import Image from "next/image";

import { getBranding } from "@/server/services/branding.service";
import { getOrderByNumber } from "@/server/services/order.service";
import { BookingTypeLabel } from "@/lib/constants/labels";
import { resolveProvider } from "@/lib/constants/providers";
import { formatCurrency, formatDateTime } from "@/lib/format";

export const metadata = { title: "Payment received" };
export const dynamic = "force-dynamic";

interface SuccessPageProps {
  searchParams: Promise<{ order?: string }>;
}

export default async function PaymentSuccessPage({
  searchParams,
}: SuccessPageProps) {
  const { order: orderNumber } = await searchParams;
  const [order, branding] = await Promise.all([
    orderNumber ? getOrderByNumber(orderNumber) : Promise.resolve(null),
    getBranding(),
  ]);
  const brand = branding.brandName;
  const supportEmail = branding.supportEmail;
  const supportPhone = branding.supportPhone;
  const providerMeta = order ? resolveProvider(order.provider) : null;
  const amount = order
    ? formatCurrency(
        order.payment.amountReceived ?? order.pricing.amount,
        order.pricing.currency,
      )
    : null;
  const paidOn = order?.payment.paidAt
    ? formatDateTime(order.payment.paidAt)
    : null;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* ─── Hero ─── */}
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
        <p className="mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
          Payment confirmed
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
          Payment received
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Thank you. {brand} has confirmed your payment and a receipt is on
          its way to your inbox.
        </p>
      </div>

      {order && providerMeta && amount ? (
        <>
          {/* ─── Amount + Order ─── */}
          <div className="grid grid-cols-2 gap-4 border-t border-slate-100 px-8 py-6">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.10em] text-slate-500">
                Amount paid
              </p>
              <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-slate-900">
                {amount}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[11px] font-semibold uppercase tracking-[0.10em] text-slate-500">
                Order
              </p>
              <p className="mt-1 font-mono text-sm font-semibold text-slate-900">
                {order.orderNumber}
              </p>
              {paidOn ? (
                <p className="mt-1 text-xs text-slate-500">{paidOn}</p>
              ) : null}
            </div>
          </div>

          {/* ─── Provider strip ─── */}
          <div className="flex items-center gap-3 border-t border-slate-100 bg-slate-50/60 px-8 py-4">
            <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md border border-slate-200 bg-white p-1.5">
              <Image
                src={providerMeta.logo}
                alt={providerMeta.name}
                width={40}
                height={40}
                unoptimized
                className="max-h-full max-w-full object-contain"
              />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">
                {providerMeta.name}
              </p>
              <p className="truncate text-xs text-slate-500">
                {BookingTypeLabel[order.bookingType]}
              </p>
            </div>
          </div>

          {/* ─── Booking details ─── */}
          <div className="border-t border-slate-100 px-8 py-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.10em] text-slate-500">
              Booking details
            </p>
            <dl className="mt-3 divide-y divide-slate-100 text-sm">
              <DetailRow
                label="Customer"
                value={order.customer.name}
              />
              <DetailRow
                label="Type"
                value={BookingTypeLabel[order.bookingType]}
              />
              <DetailRow
                label="Provider"
                value={providerMeta.name}
              />
              <DetailRow
                label="Vehicle"
                value={`${order.vehicle.company} · ${order.vehicle.type}`}
              />
              <DetailRow
                label="Pick-up"
                value={formatDateTime(order.trip.pickupDate)}
              />
              <DetailRow
                label="Drop-off"
                value={formatDateTime(order.trip.dropoffDate)}
              />
              {order.payment.receiptUrl ? (
                <DetailRow
                  label="Stripe receipt"
                  value={
                    <a
                      href={order.payment.receiptUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-600"
                    >
                      View receipt
                    </a>
                  }
                />
              ) : null}
            </dl>
          </div>

          {/* ─── Stripe trust line ─── */}
          <div className="border-t border-slate-100 px-8 py-4 text-center text-[11px] text-slate-500">
            Payment processed securely by Stripe — PCI-DSS Level 1 certified.
          </div>
        </>
      ) : null}

      {/* ─── Support footer ─── */}
      <div className="border-t border-slate-100 bg-slate-50 px-8 py-5 text-center text-xs text-slate-500">
        Questions? Reach us at{" "}
        <a
          href={`mailto:${supportEmail}`}
          className="font-medium text-slate-700 underline-offset-2 hover:underline"
        >
          {supportEmail}
        </a>
        {supportPhone ? ` · ${supportPhone}` : null}. You can safely close
        this window.
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-right text-sm font-medium text-slate-900">
        {value}
      </dd>
    </div>
  );
}
