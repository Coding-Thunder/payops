import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { sendPaymentRequestSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
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
 * Compose + dispatch the payment-request email from the agent's composer.
 *
 * Flow:
 *   1. Validate body (subject/greeting/intro/note overrides + optional
 *      customer patch).
 *   2. If the agent edited customer fields, PATCH the order — the
 *      auto-confirmation email later relies on the same customer record.
 *   3. Re-fetch the order so the freshly-patched customer flows into the
 *      rendered email.
 *   4. sendPaymentRequestEmail records its own EMAIL_SENT audit row.
 */
export const POST = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.ORDER_VIEW_OWN);
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const input = sendPaymentRequestSchema.parse(body);
  const reqCtx = await getRequestContext();

  // 1. Patch the order's customer if anything was edited.
  let order = await getOrderById(id, { actor });
  if (input.customer && Object.keys(input.customer).length > 0) {
    const patched = await updateOrderCustomer(id, input.customer, {
      actor,
      request: reqCtx,
    });
    order = patched.order;
  }

  // 2. Send.
  const result = await sendPaymentRequestEmail(order, {
    subject: input.subject,
    greeting: input.greeting,
    intro: input.intro,
    note: input.note,
  });

  return jsonOk({
    order,
    sent: { messageId: result.id },
  });
});
