import { env } from "@/lib/env";
import { getOrderByNumber } from "@/server/services/order.service";

export const metadata = { title: "Payment received" };
export const dynamic = "force-dynamic";

interface SuccessPageProps {
  searchParams: Promise<{ order?: string }>;
}

export default async function PaymentSuccessPage({
  searchParams,
}: SuccessPageProps) {
  const { order: orderNumber } = await searchParams;
  const order = orderNumber ? await getOrderByNumber(orderNumber) : null;
  const brand = env.server.CUSTOMER_BRAND_NAME;
  const supportEmail = env.server.SUPPORT_EMAIL;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="bg-gradient-to-br from-emerald-50 via-white to-white px-8 pt-10 pb-8 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-7 w-7"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-slate-900">
          Payment received
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Thank you. {brand} has confirmed your payment and a receipt is on its
          way to your inbox.
        </p>
      </div>

      {order ? (
        <div className="border-t border-slate-100 px-8 py-6">
          <dl className="grid grid-cols-2 gap-y-3 text-sm">
            <dt className="text-slate-500">Order</dt>
            <dd className="text-right font-mono text-slate-900">
              {order.orderNumber}
            </dd>
          </dl>
        </div>
      ) : null}

      <div className="border-t border-slate-100 bg-slate-50 px-8 py-5 text-center text-xs text-slate-500">
        Questions? Reach us at{" "}
        <a
          href={`mailto:${supportEmail}`}
          className="font-medium text-slate-700 underline-offset-2 hover:underline"
        >
          {supportEmail}
        </a>
        . You can safely close this window.
      </div>
    </div>
  );
}
