import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { sendPaymentRequestSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { enforceRateLimit } from "@/server/api/security";
import { requirePermission } from "@/server/auth/session";
import { OrderStatus } from "@/lib/constants/enums";
import { ConflictError } from "@/lib/errors";
import { Order } from "@/server/db/models";
import {
  assertNoHeldPayment,
  getOrderById,
  standDownLinkForManualRequest,
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
 * on send — payment-session creation is an explicit agent action so
 * the gateway choice + intent are unambiguous.
 *
 * Flow:
 *   1. Validate body (subject/greeting/intro/note + optional customer
 *      patch).
 *   2. PATCH the order's customer if anything was edited — the
 *      auto-confirmation email later relies on the same customer record.
 *   3. Guard: order MUST be in LINK_GENERATED or PAYMENT_PENDING. If
 *      it's still NOT_INITIATED the agent skipped step 3.
 *   4. Render + send the email. The send transitions
 *      LINK_GENERATED → PAYMENT_PENDING (handled inside the service).
 *   5. The service records its own EMAIL_SENT audit row.
 */
export const POST = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.ORDER_VIEW_OWN);
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const input = sendPaymentRequestSchema.parse(body);
  const reqCtx = await getRequestContext();

  // Every accepted call emails the customer. The composer latches its own
  // double-clicks, but a script or a stuck retry loop sent eight identical
  // emails in a few seconds. Limited per operator AND order, so one busy
  // operator never blocks a colleague's sends.
  enforceRateLimit({
    route: "order-send-payment-request",
    key: `${actor.id}|${id}`,
    max: 3,
    windowMs: 60_000,
  });

  let order = await getOrderById(id, { actor });

  // 1. Strict gate — payment link must exist before we email about it.
  //    A MANUAL collection is the deliberate exception: there is no link and
  //    the email only asks the customer to review and consent, so an order
  //    that has never been initiated is exactly the normal case.
  //
  //    The gates run BEFORE the customer patch below. They used to run after
  //    it, so a send refused because the order was already paid (or its link
  //    was dead) had still rewritten the customer's name and email — and the
  //    receipt then went to an address that was never confirmed.
  const manualCollection = input.collection === "MANUAL";
  if (order.status === OrderStatus.NOT_INITIATED && !manualCollection) {
    throw new ConflictError(
      "Generate a payment link before sending the request email.",
    );
  }
  if (order.status === OrderStatus.PAID) {
    throw new ConflictError("Cannot send a request — order is already paid.");
  }
  // Money already held on an earlier link: asking again, by any method,
  // risks a second charge until it is reconciled.
  assertNoHeldPayment(order);
  // A failed or expired gateway attempt is precisely when an operator falls
  // back to collecting manually, so that path stays open; only the gateway
  // path still refuses, because its link is dead.
  if (
    !manualCollection &&
    (order.status === OrderStatus.FAILED || order.status === OrderStatus.EXPIRED)
  ) {
    throw new ConflictError(
      `Cannot send a request — order is ${order.status.toLowerCase()}.`,
    );
  }

  // 2. Manual collection: the order's gateway link stops being payable
  //    before the customer is asked to confirm, so the same payment cannot
  //    also arrive online while the operator takes it on the terminal.
  if (manualCollection) {
    const stoodDown = await standDownLinkForManualRequest(id, {
      actor,
      request: reqCtx,
    });
    if (stoodDown) order = await getOrderById(id, { actor });
  }

  // 3. Patch customer if edited — only once the send is known to proceed.
  if (input.customer && Object.keys(input.customer).length > 0) {
    const patched = await updateOrderCustomer(id, input.customer, {
      actor,
      request: reqCtx,
    });
    order = patched.order;
  }

  // 4. Send.
  const result = await sendPaymentRequestEmail(
    order,
    {
      subject: input.subject,
      greeting: input.greeting,
      intro: input.intro,
      note: input.note,
      manualCollection,
    },
    { actor, request: reqCtx },
  );

  // 5. Transition LINK_GENERATED → PAYMENT_PENDING after a successful
  // send. Doing it here (not in the email service) keeps the email
  // module side-effect-free against the order doc. Conditional update
  // means re-sends to an already-PENDING/PAID order are no-ops.
  // A manual request carries no link, so it does not put the order's link
  // in the customer's hands.
  if (order.status === OrderStatus.LINK_GENERATED && !manualCollection) {
    await Order.updateOne(
      { _id: id, status: OrderStatus.LINK_GENERATED },
      {
        $set: {
          status: OrderStatus.PAYMENT_PENDING,
          "payment.status": OrderStatus.PAYMENT_PENDING,
        },
      },
    );
  }

  const refreshed = await getOrderById(id, { actor });
  return jsonOk({
    order: refreshed,
    sent: { messageId: result.id, consentToken: result.consentToken },
  });
});
