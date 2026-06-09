import { notFound, redirect } from "next/navigation";

import { Permission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";
import { findCustomerByEmail } from "@/server/services/customer.service";

export const dynamic = "force-dynamic";

/**
 * Email → customerId resolver. Order records key the customer by
 * `customer.email` rather than a foreign-key id, so anywhere the
 * app surfaces an email and wants to deep-link to the customer
 * detail page, we go through this route and let the server resolve.
 *
 * 404s when the customer record hasn't been created yet (e.g. an
 * order that landed before the Customer collection existed and
 * never got back-filled). Operators can ignore — the order detail
 * still works on its own.
 */
interface CustomerByEmailProps {
  params: Promise<{ email: string }>;
}

export default async function CustomerByEmailRedirect({
  params,
}: CustomerByEmailProps) {
  const user = await requirePermission(Permission.ORDER_VIEW_OWN);
  if (!user.orgId) notFound();
  const { email: rawEmail } = await params;
  const email = decodeURIComponent(rawEmail);
  const customer = await findCustomerByEmail(user.orgId, email);
  if (!customer) notFound();
  redirect(`/app/customers/${customer.id}`);
}
