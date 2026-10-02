import type { NextRequest } from "next/server";
import { render } from "@react-email/render";

import { Permission } from "@/lib/constants/permissions";
import { sendPaymentRequestSchema } from "@/lib/validation";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { getOrderById } from "@/server/services/order.service";
import { composePaymentRequestProps } from "@/server/services/email.service";
import { PaymentRequestEmail } from "@/server/email/templates/payment-request";
import { FlightPaymentRequestEmail } from "@/server/email/templates/flight-payment-request";
import { isFlightOrder } from "@/lib/service-summary";

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
  });
  /**
   * Template selection must match `sendPaymentRequestEmail` EXACTLY.
   *
   * This route previously rendered the rental template for every order, so a
   * flight order previewed as a car email: an empty "Vehicle" row, blank
   * Pick-up/Drop-off, "Total rental cost" and "Amount due at counter". The
   * email that actually went out was the flight one, which made the preview
   * actively misleading — the operator approved a layout the customer never
   * received.
   *
   * `composePaymentRequestProps` above already carries `flightRows`, so both
   * callers compose once and only the element differs. Keeping the two
   * selections identical is the point; if they diverge again the preview
   * lies, so `email-preview-parity.test.ts` asserts they agree.
   */
  const element = isFlightOrder(order) ? (
    <FlightPaymentRequestEmail {...props} />
  ) : (
    <PaymentRequestEmail {...props} />
  );
  const html = await render(element);
  return jsonOk({ html });
});
