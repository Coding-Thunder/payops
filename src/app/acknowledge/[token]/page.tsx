import { getPublicAcknowledgementView } from "@/server/services/acknowledgement.service";
import { getBranding } from "@/server/services/branding.service";
import { AppError } from "@/lib/errors";

import { AcknowledgeForm } from "./acknowledge-form";

export const dynamic = "force-dynamic";
// Token-bound, customer-facing surface — never index (the signed token in
// the path is the credential).
export const metadata = {
  title: "Confirm your booking terms",
  robots: { index: false, follow: false, nocache: true },
};

interface AcknowledgePageProps {
  params: Promise<{ token: string }>;
}

/**
 * Public hosted Terms & Conditions acknowledgement page. The customer arrives
 * from the "I Agree" button in the confirmation email. Renders the T&C and a
 * single button that records their acknowledgement (timestamp + IP). No login
 * — the signed token is the credential (the proxy allowlists /acknowledge).
 */
export default async function AcknowledgePage({
  params,
}: AcknowledgePageProps) {
  const { token } = await params;

  let view;
  try {
    view = await getPublicAcknowledgementView(token);
  } catch (err) {
    // Expired / invalid / missing token → a friendly customer-facing message,
    // NEVER a redirect to the internal login or a bare 404.
    if (
      err instanceof AppError &&
      (err.statusCode === 400 || err.statusCode === 404)
    ) {
      const branding = await getBranding();
      return (
        <main className="mx-auto w-full max-w-xl px-4 py-10">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">
              This link is no longer valid
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              Your acknowledgement link may have expired or already been used.
              No action is needed — your booking is unaffected.
            </p>
            <p className="mt-4 text-[13px] text-slate-500">
              Need help? Contact{" "}
              <a
                href={`mailto:${branding.supportEmail}`}
                className="text-slate-700 underline underline-offset-2"
              >
                {branding.supportEmail}
              </a>
              .
            </p>
          </div>
        </main>
      );
    }
    throw err;
  }

  return (
    <main className="mx-auto w-full max-w-xl px-4 py-10">
      <AcknowledgeForm token={token} initialView={view} />
    </main>
  );
}
