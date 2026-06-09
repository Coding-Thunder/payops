import type { NextRequest } from "next/server";
import { render } from "@react-email/render";

import { ForbiddenError } from "@/lib/errors";
import { Permission } from "@/lib/constants/permissions";
import { sendPaymentRequestSchema } from "@/lib/validation";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { getOrderById } from "@/server/services/order.service";
import { composePaymentRequestProps } from "@/server/services/email.service";
import { UniversalOrderEmail } from "@/server/email/templates/universal-order-email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Render the payment-request email with the composer's current overrides
 * and return the HTML string. Used by the composer's right-hand iframe
 * so the preview matches what will actually be sent, same template,
 * same inline-image pipeline, same defaults, without burning an SMTP
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
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const input = sendPaymentRequestSchema.parse(body);

  const order = await getOrderById(id, { actor, orgId: actor.orgId });
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

  const composed = await composePaymentRequestProps(orderForPreview, {
    subject: input.subject,
    greeting: input.greeting,
    intro: input.intro,
    note: input.note,
  });
  const html = await render(<UniversalOrderEmail {...composed.template} />);
  return jsonOk({ html });
});
