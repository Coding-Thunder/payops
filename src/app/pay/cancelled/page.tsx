import { getBranding } from "@/server/services/branding.service";

export const metadata = { title: "Payment cancelled" };
export const dynamic = "force-dynamic";

export default async function PaymentCancelledPage() {
  const branding = await getBranding();
  const brand = branding.brandName;
  const supportEmail = branding.supportEmail;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="bg-gradient-to-br from-amber-50 via-white to-white px-8 pt-10 pb-8 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 text-amber-600">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-7 w-7"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-slate-900">
          Payment not completed
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          You closed the secure payment window before finishing. {brand} has
          not charged your card. You can use the same payment link to try
          again, or ask us to send a new one.
        </p>
      </div>

      <div className="border-t border-slate-100 bg-slate-50 px-8 py-5 text-center text-xs text-slate-500">
        Need help? Email{" "}
        <a
          href={`mailto:${supportEmail}`}
          className="font-medium text-slate-700 underline-offset-2 hover:underline"
        >
          {supportEmail}
        </a>
        .
      </div>
    </div>
  );
}
