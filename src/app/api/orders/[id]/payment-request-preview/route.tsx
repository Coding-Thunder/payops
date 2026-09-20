import type { NextRequest } from "next/server";
import { render } from "@react-email/render";

import { Permission } from "@/lib/constants/permissions";
import { assertPaidFeaturesEnabled } from "@/lib/paid-features";
import { sendPaymentRequestSchema } from "@/lib/validation";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { getOrderById } from "@/server/services/order.service";
import { composePaymentRequestProps } from "@/server/services/email.service";
import { PaymentRequestEmail } from "@/server/email/templates/payment-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Render the payment-request email with the composer's current overrides
 * and return the HTML string. Used by the composer's right-hand iframe
 * so the preview matches what will actually be sent — same template,
 * same inline-image pipeline, same defaults — without burning an SMTP
 * call.
 *
 * Body reuses `sendPaymentRequestSchema` so the preview and the send
 * accept exactly the same shape. We don't *apply* the customer patch
 * here; the agent only gets to commit those edits when they actually
 * click Send. The preview overlays them into the rendered email so the
 * agent can confirm the new name/email reads right.
 */
export const POST = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.ORDER_VIEW_OWN);
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const input = sendPaymentRequestSchema.parse(body);
  // Previewing a manual request belongs to the manual payment feature,
  // switched off until paid for (see src/lib/paid-features.ts).
  if (input.collection === "MANUAL") assertPaidFeaturesEnabled();

  const order = await getOrderById(id, { actor });
  // Overlay any edited customer name into the email's "Hi <name>"
  // greeting without persisting it. Email address / phone don't appear
  // in the body, so we only need to handle name here.
  const orderForPreview =
    input.customer?.name && input.customer.name !== order.customer.name
      ? {
          ...order,
          customer: { ...order.customer, name: input.customer.name },
        }
      : order;

  const props = await composePaymentRequestProps(orderForPreview, {
    subject: input.subject,
    greeting: input.greeting,
    intro: input.intro,
    note: input.note,
    // The preview's whole job is to show what will actually be sent, so it
    // must see the operator's collection choice too. Without it an operator
    // could select Manual and still be looking at a Stripe checkout CTA.
    manualCollection: input.collection === "MANUAL",
  });
  const html = await render(<PaymentRequestEmail {...props} />);
  return jsonOk({ html });
});
