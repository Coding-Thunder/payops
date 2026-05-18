import { notFound } from "next/navigation";
import { render } from "@react-email/render";

import { PageHeader } from "@/components/common/page-header";
import { EmailComposer } from "@/components/features/orders/email-composer";
import { Permission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";
import {
  composePaymentRequestProps,
  defaultPaymentRequestSubject,
} from "@/server/services/email.service";
import { getOrderById } from "@/server/services/order.service";
import { getBranding } from "@/server/services/branding.service";
import { PaymentRequestEmail } from "@/server/email/templates/payment-request";

export const metadata = { title: "Send payment request" };
export const dynamic = "force-dynamic";

interface ComposePageProps {
  params: Promise<{ id: string }>;
}

export default async function ComposePaymentRequestPage({
  params,
}: ComposePageProps) {
  const actor = await requirePermission(Permission.ORDER_VIEW_OWN);
  const { id } = await params;

  const order = await getOrderById(id, { actor }).catch(() => null);
  if (!order) notFound();

  // Render the initial preview on the server so the iframe is fully
  // painted on first navigation — no flash of empty preview while the
  // client useEffect kicks off its first fetch.
  const [props, branding] = await Promise.all([
    composePaymentRequestProps(order),
    getBranding(),
  ]);
  const initialHtml = await render(<PaymentRequestEmail {...props} />);
  const defaultSubject = defaultPaymentRequestSubject(order, branding.brandName);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Order"
        title="Send payment request"
        description="Edit the customer-facing email, then send when ready. The preview reflects exactly what will be delivered."
      />
      <EmailComposer
        order={order}
        initialHtml={initialHtml}
        defaultSubject={defaultSubject}
      />
    </div>
  );
}
