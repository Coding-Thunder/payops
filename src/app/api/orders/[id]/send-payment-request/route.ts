import type { NextRequest } from "next/server";

import { Types } from "mongoose";

import { Permission } from "@/lib/constants/permissions";
import { sendPaymentRequestSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { idempotencyKeyFrom, runIdempotent } from "@/server/api/idempotency";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { OrderStatus } from "@/lib/constants/enums";
import { ConflictError, ForbiddenError } from "@/lib/errors";
import { Order } from "@/server/db/models";
import {
  getOrderById,
  updateOrderCustomer,
} from "@/server/services/order.service";
import { sendPaymentRequestEmail } from "@/server/services/email.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Step 4 of the linear agent flow: dispatch the payment-request email.
 *
 * REQUIRES that the payment link has already been generated via
 * `/api/orders/[id]/generate-payment-link`. We no longer auto-initiate
 * on send, payment-session creation is an explicit agent action so
 * the gateway choice + intent are unambiguous.
 *
 * Flow:
 *   1. Validate body (subject/greeting/intro/note + optional customer
 *      patch).
 *   2. PATCH the order's customer if anything was edited, the
 *      auto-confirmation email later relies on the same customer record.
 *   3. Guard: order MUST be in LINK_GENERATED or PAYMENT_PENDING. If
 *      it's still NOT_INITIATED the agent skipped step 3.
 *   4. Render + send the email. The send transitions
 *      LINK_GENERATED → PAYMENT_PENDING (handled inside the service).
 *   5. The service records its own EMAIL_SENT audit row.
 */
export const POST = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.ORDER_VIEW_OWN);
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const input = sendPaymentRequestSchema.parse(body);
  const reqCtx = await getRequestContext();

  // 1. Patch customer if edited.
  let order = await getOrderById(id, { actor, orgId: actor.orgId });
  if (input.customer && Object.keys(input.customer).length > 0) {
    const patched = await updateOrderCustomer(id, input.customer, {
      actor,
      orgId: actor.orgId,
      request: reqCtx,
    });
    order = patched.order;
  }

  // 2. Strict gate, payment link must exist before we email about it.
  if (order.status === OrderStatus.NOT_INITIATED) {
    throw new ConflictError(
      "Generate a payment link before sending the request email.",
    );
  }
  if (
    order.status === OrderStatus.PAID ||
    order.status === OrderStatus.FAILED ||
    order.status === OrderStatus.EXPIRED
  ) {
    throw new ConflictError(
      `Cannot send a request, order is ${order.status.toLowerCase()}.`,
    );
  }

  // 3. Send — guarded by the client's Idempotency-Key so a timeout retry or
  // double-submit cannot dispatch the email twice. A DUPLICATE returns the
  // current order without re-sending; a FAILED send releases the claim so a
  // real retry can go through.
  const orgId = actor.orgId;
  const payload = await runIdempotent(
    "send-payment-request",
    idempotencyKeyFrom(req),
    async () => {
      const result = await sendPaymentRequestEmail(
        order,
        {
          subject: input.subject,
          greeting: input.greeting,
          intro: input.intro,
          note: input.note,
        },
        { actor, request: reqCtx },
      );

      // 4. Transition LINK_GENERATED → PAYMENT_PENDING after a successful
      // send. Conditional + tenant-pinned so re-sends to an already-PENDING/
      // PAID order are no-ops and no cross-tenant status flip is possible.
      if (order.status === OrderStatus.LINK_GENERATED) {
        await Order.updateOne(
          {
            _id: id,
            orgId: new Types.ObjectId(orgId),
            status: OrderStatus.LINK_GENERATED,
          },
          {
            $set: {
              status: OrderStatus.PAYMENT_PENDING,
              "payment.status": OrderStatus.PAYMENT_PENDING,
            },
          },
        );
      }

      const refreshed = await getOrderById(id, { actor, orgId });
      return {
        order: refreshed,
        sent: {
          messageId: result.id,
          consentToken: result.consentToken,
          deduplicated: false,
        },
      };
    },
    async () => {
      const refreshed = await getOrderById(id, { actor, orgId });
      return {
        order: refreshed,
        sent: { messageId: null, consentToken: null, deduplicated: true },
      };
    },
  );
  return jsonOk(payload);
});
