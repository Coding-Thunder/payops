import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ key?: string }>;
}

/**
 * Index route — there are only ever a handful of editable templates, so
 * we just kick the admin to the most operationally-relevant default
 * (the payment-request copy, since it's the only one a human composes
 * by hand).
 */
export default async function AdminEmailTemplatesIndex({
  searchParams,
}: PageProps) {
  const { key } = await searchParams;
  redirect(`/admin/email-templates/${key ?? "payment-request"}`);
}
