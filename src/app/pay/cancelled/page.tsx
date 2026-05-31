export const metadata = { title: "Payment cancelled" };
export const dynamic = "force-dynamic";

/**
 * Generic cancellation page — no per-tenant branding is rendered
 * here because Stripe's cancel URL doesn't carry an order id and
 * we deliberately don't expose the legacy {key:"default"} singleton's
 * env-defaulted brand (which would be wrong for every tenant except
 * the legacy one).
 *
 * To add tenant branding to this page, the Stripe checkout's
 * cancel_url needs an `?order=<orderNumber>` param appended at session
 * creation time, then we can resolve the order's tenant the same way
 * pay/success does.
 */
export default function PaymentCancelledPage() {
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
          You closed the secure payment window before finishing. Your card
          has not been charged. You can use the same payment link to try
          again, or contact the merchant for a new one.
        </p>
      </div>

      <div className="border-t border-slate-100 bg-slate-50 px-8 py-5 text-center text-xs text-slate-500">
        Reply to the original payment email if you need help completing
        this order.
      </div>
    </div>
  );
}
