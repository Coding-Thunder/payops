import Image from "next/image";

import { PublicBrandChrome } from "@/components/public/public-brand-chrome";
import { resolvePublicBrandForOrderNumber } from "@/server/email/identity";
import { getBranding } from "@/server/services/branding.service";
import {
  getOrderByNumber,
  reconcileOrderPayment,
} from "@/server/services/order.service";
import {
  BookingTypeLabel,
  PaymentGatewayLabel as PAYMENT_GATEWAY_LABELS,
} from "@/lib/constants/labels";
import { resolveProvider } from "@/lib/constants/providers";
import {
  OrderStatus,
  PaymentCaptureStatus,
  PaymentGatewayKey,
  ServiceType,
} from "@/lib/constants/enums";
import { summarizeCharges } from "@/lib/charges";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { logger } from "@/lib/logger";
import {
  serviceDetailRows,
  serviceNoun,
  serviceTypeOf,
} from "@/lib/service-summary";
import type { OrderDTO } from "@/types";

import { PaymentSuccessAutoRefresh } from "./auto-refresh";

/**
 * PER-BRAND TAB TITLE, and honest about whether money actually moved.
 *
 * `title.absolute` opts out of the root layout's `"%s • <deployment name>"`
 * template so a FlightBizz customer's tab never reads another brand's name.
 * And an order sitting on an AUTHORIZATION has not been paid — telling that
 * customer "Payment received" in the tab title contradicts the page itself.
 */
export async function generateMetadata({
  searchParams,
}: SuccessPageProps) {
  const { order: orderNumber } = await searchParams;
  const brand = await resolvePublicBrandForOrderNumber(
    orderNumber,
    await getBranding(),
  );
  const order = orderNumber ? await getOrderByNumber(orderNumber) : null;
  const authorized =
    order?.payment.capture?.status === PaymentCaptureStatus.AUTHORIZED &&
    order.status !== OrderStatus.PAID;
  const headline = authorized ? "Card authorized" : "Payment received";
  return { title: { absolute: `${headline} • ${brand.brandName}` } };
}
export const dynamic = "force-dynamic";

interface SuccessPageProps {
  /**
   * `session_id` is Stripe's ({CHECKOUT_SESSION_ID} placeholder). PayPal
   * appends `token` (its order id) and `PayerID` to the return URL instead,
   * and never sends `session_id` — which is why the pairing check below used
   * to fail for every PayPal payment and blank the page.
   */
  searchParams: Promise<{
    order?: string;
    session_id?: string;
    token?: string;
    PayerID?: string;
  }>;
}

export default async function PaymentSuccessPage({
  searchParams,
}: SuccessPageProps) {
  const {
    order: orderNumber,
    session_id: sessionId,
    token: paypalToken,
  } = await searchParams;
  const branding = await getBranding();

  // Whichever gateway sent the customer back, this is the id of the session
  // it created. Both gateways store it in `payment.paymentSessionId`.
  const returnedSessionId = sessionId ?? paypalToken ?? null;

  // Defensive: require BOTH the order number and the gateway session id, and
  // verify the pair matches before rendering anything. Anyone arriving here
  // legitimately has both. Without this pairing check, a curl loop over
  // order-number space pulls full PII for every paid order on the platform.
  let order = orderNumber ? await getOrderByNumber(orderNumber) : null;
  if (order && order.payment.paymentSessionId !== returnedSessionId) {
    order = null;
  }

  // Self-heal the local-dev / dropped-webhook case at first render.
  // The gateway just sent the customer here, which means the session SHOULD
  // be settled. Ask the gateway directly; if confirmed, drive the same atomic
  // transition the webhook uses. By the time the page paints, the order
  // reflects the gateway's truth even if the webhook never reached us.
  //
  // `reconcileOrderPayment` resolves the gateway from the order, so this
  // works for both. Note PayPal's APPROVED (buyer agreed, nothing captured)
  // correctly maps to "open", so a PayPal order that is only approved stays
  // pending here and the auto-refresh waits for the webhook to capture.
  //
  // An order sitting on a manual-capture AUTHORIZATION is deliberately
  // excluded: the hold is already the gateway's truth, there is nothing
  // half-finished to self-heal, and re-reconciling it would only risk
  // reading an authorized session as a completed one. `payment.capture` is
  // null on every automatic-capture order — i.e. every order both incumbent
  // brands have — so this guard never fires for them.
  if (
    order &&
    order.status === OrderStatus.PAYMENT_PENDING &&
    order.payment.capture?.status !== PaymentCaptureStatus.AUTHORIZED &&
    order.payment.paymentSessionId &&
    returnedSessionId
  ) {
    try {
      const result = await reconcileOrderPayment(order.id, undefined, {
        sessionId: returnedSessionId,
      });
      order = result.order;
    } catch (err) {
      logger.warn("pay_success.reconcile_failed", {
        orderId: order.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // Manual capture: the card was authorized and the money is being HELD,
  // not taken. The customer must not be told the payment succeeded, and the
  // "we're still confirming" spinner is wrong too — nothing is in flight.
  // `capture` is null on every automatic-capture order, so `isAuthorized`
  // is false for both incumbent brands and this page renders exactly as it
  // does today for them.
  const capture = order?.payment.capture ?? null;
  const isAuthorized =
    capture?.status === PaymentCaptureStatus.AUTHORIZED &&
    order?.status === OrderStatus.PAYMENT_PENDING;
  const stillPending =
    order?.status === OrderStatus.PAYMENT_PENDING &&
    Boolean(order?.payment.paymentSessionId) &&
    !isAuthorized;
  // Brand from the ORDER's organization — resolved from the order number even
  // when the pairing check nulled `order`, because the header, the hero copy
  // and the support footer all render outside that guard.
  const publicBrand = await resolvePublicBrandForOrderNumber(
    orderNumber,
    branding,
  );
  const brand = publicBrand.brandName;
  const supportEmail = publicBrand.supportEmail;
  const supportPhone = publicBrand.supportPhone;
  const gatewayLabel = order?.payment.gateway
    ? PAYMENT_GATEWAY_LABELS[order.payment.gateway as PaymentGatewayKey]
    : null;
  const providerMeta = order ? resolveProvider(order.provider) : null;
  const amount = order
    ? formatCurrency(
        isAuthorized
          ? (capture?.amountAuthorized ?? order.pricing.amount)
          : (order.payment.amountReceived ?? order.pricing.amount),
        order.pricing.currency,
      )
    : null;
  const paidOn = order?.payment.paidAt
    ? formatDateTime(order.payment.paidAt)
    : null;
  const authorizedOn =
    isAuthorized && capture?.authorizedAt
      ? formatDateTime(capture.authorizedAt)
      : null;
  // Same value as before whenever `capture` is null.
  const settledOn = authorizedOn ?? paidOn;
  const breakdown = order
    ? summarizeCharges(order.charges, order.pricing.amount)
    : null;
  const hasCounterDue = (breakdown?.dueAtCounter ?? 0) > 0;
  // "rental" for a car, so "Total rental cost" below is reproduced exactly.
  const noun = order ? serviceNoun(order) : "rental";
  const counterDueLabel = order
    ? balanceDueLabel(order)
    : "Remaining balance due at rental counter";

  return (
    <PublicBrandChrome brand={publicBrand}>
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {/* ─── Hero ─── */}
        <div className="bg-gradient-to-br from-emerald-50 via-white to-white px-8 pt-10 pb-8 text-center">
          <div
            className={
              isAuthorized
                ? "mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-sky-100 text-sky-700"
                : stillPending
                  ? "mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 text-amber-700"
                  : "mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600"
            }
          >
            {isAuthorized ? (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-7 w-7"
                aria-hidden
              >
                <rect x="2" y="5" width="20" height="14" rx="2" />
                <path d="M2 10h20" />
              </svg>
            ) : stillPending ? (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-7 w-7 animate-spin"
                aria-hidden
              >
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-7 w-7"
                aria-hidden
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            )}
          </div>
          <p
            className={
              isAuthorized
                ? "mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-sky-700"
                : stillPending
                  ? "mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-amber-700"
                  : "mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700"
            }
          >
            {isAuthorized
              ? "Card authorized"
              : stillPending
                ? `Confirming with ${gatewayLabel ?? "your bank"}`
                : "Payment confirmed"}
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
            {isAuthorized
              ? "Your card has been authorized"
              : stillPending
                ? "We’re confirming your payment"
                : "Payment received"}
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            {isAuthorized
              ? `${brand} has placed a hold on your card${amount ? ` for ${amount}` : ""}. You have not been charged yet — the amount is released to us only once your ${noun} is confirmed, and you’ll get a receipt then.`
              : stillPending
                ? `${brand} is waiting for ${gatewayLabel ?? "the payment provider"} to finalise this charge. This page refreshes automatically.`
                : `Thank you. ${brand} has confirmed your payment and a receipt is on its way to your inbox.`}
          </p>
          {stillPending ? <PaymentSuccessAutoRefresh /> : null}
        </div>

        {order && providerMeta && amount ? (
          <>
            {/* ─── Amount + Order ─── */}
            <div className="grid grid-cols-2 gap-4 border-t border-slate-100 px-8 py-6">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.10em] text-slate-500">
                  {isAuthorized ? "Amount on hold" : "Amount paid"}
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
                {settledOn ? (
                  <p className="mt-1 text-xs text-slate-500">{settledOn}</p>
                ) : null}
              </div>
            </div>

            {/* ─── Charge breakdown (only when a counter balance remains) ─── */}
            {hasCounterDue && breakdown ? (
              <div className="border-t border-slate-100 px-8 py-5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.10em] text-slate-500">
                  Charge breakdown
                </p>
                <dl className="mt-3 space-y-1.5 text-sm">
                  <div className="flex items-center justify-between">
                    <dt className="text-slate-500">
                      {isAuthorized
                        ? "Authorized online today"
                        : "Paid online today"}
                    </dt>
                    <dd className="tabular-nums text-slate-900">
                      {formatCurrency(
                        breakdown.prepaid,
                        order.pricing.currency,
                      )}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-slate-500">{counterDueLabel}</dt>
                    <dd className="tabular-nums text-slate-900">
                      {formatCurrency(
                        breakdown.dueAtCounter,
                        order.pricing.currency,
                      )}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between border-t border-slate-100 pt-1.5 font-medium">
                    <dt className="text-slate-700">{`Total ${noun} cost`}</dt>
                    <dd className="tabular-nums text-slate-900">
                      {formatCurrency(breakdown.total, order.pricing.currency)}
                    </dd>
                  </div>
                </dl>
              </div>
            ) : null}

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
                <DetailRow label="Customer" value={order.customer.name} />
                <DetailRow
                  label="Type"
                  value={BookingTypeLabel[order.bookingType]}
                />
                <DetailRow label="Provider" value={providerMeta.name} />
                <ServiceDetailRows order={order} />
                {isAuthorized && capture?.captureExpiresAt ? (
                  <DetailRow
                    label="Authorization expires"
                    value={formatDateTime(capture.captureExpiresAt)}
                  />
                ) : null}
                {order.confirmationNumber ? (
                  <DetailRow
                    label="Confirmation #"
                    value={order.confirmationNumber}
                  />
                ) : null}
                {order.payment.receiptUrl ? (
                  <DetailRow
                    label={gatewayLabel ? `${gatewayLabel} receipt` : "Receipt"}
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

            {/* ─── Processor trust line ─── */}
            <div className="border-t border-slate-100 px-8 py-4 text-center text-[11px] text-slate-500">
              {isAuthorized
                ? gatewayLabel
                  ? `Card authorized securely by ${gatewayLabel} — PCI-DSS Level 1 certified.`
                  : "Card authorized securely."
                : gatewayLabel
                  ? `Payment processed securely by ${gatewayLabel} — PCI-DSS Level 1 certified.`
                  : "Payment processed securely."}
            </div>
          </>
        ) : null}

        {/* ─── Support footer ─── */}
        <div className="border-t border-slate-100 bg-slate-50 px-8 py-5 text-center text-xs text-slate-500">
          {supportEmail ? (
            <>
              Questions? Reach us at{" "}
              <a
                href={`mailto:${supportEmail}`}
                className="font-medium text-slate-700 underline-offset-2 hover:underline"
              >
                {supportEmail}
              </a>
              {supportPhone ? ` · ${supportPhone}` : null}.{" "}
            </>
          ) : null}
          You can safely close this window.
        </div>
      </div>
    </PublicBrandChrome>
  );
}

/**
 * Where the remaining (not-collected-online) balance is settled. The
 * CAR_RENTAL string is the literal this page has always rendered.
 */
function balanceDueLabel(order: OrderDTO): string {
  switch (serviceTypeOf(order)) {
    case ServiceType.FLIGHT:
      return "Remaining balance due at check-in";
    case ServiceType.HOTEL:
      return "Remaining balance due at the property";
    case ServiceType.CAR_RENTAL:
    default:
      return "Remaining balance due at rental counter";
  }
}

/**
 * The service rows of the booking-details list.
 *
 * CAR_RENTAL renders the original Vehicle / Pick-up / Drop-off triple
 * verbatim — same labels, same `·`-joined values, same order — because
 * every order both incumbent brands have is a car rental and this receipt
 * must not shift by a character for them. It is now null-guarded only
 * because the DTO fields became nullable; on a real rental both are
 * present, so nothing disappears. FLIGHT and HOTEL fall through to the
 * shared `serviceDetailRows` helper, so this page, the order detail card
 * and the emails all describe a flight or a hotel identically.
 */
function ServiceDetailRows({ order }: { order: OrderDTO }) {
  if (serviceTypeOf(order) === ServiceType.CAR_RENTAL) {
    const vehicle = order.vehicle;
    const trip = order.trip;
    return (
      <>
        {vehicle ? (
          <DetailRow
            label="Vehicle"
            value={`${vehicle.company} · ${vehicle.type}`}
          />
        ) : null}
        {trip ? (
          <>
            <DetailRow
              label="Pick-up"
              value={
                trip.pickupLocation
                  ? `${formatDateTime(trip.pickupDate)} · ${trip.pickupLocation}`
                  : formatDateTime(trip.pickupDate)
              }
            />
            <DetailRow
              label="Drop-off"
              value={
                trip.dropoffLocation
                  ? `${formatDateTime(trip.dropoffDate)} · ${trip.dropoffLocation}`
                  : formatDateTime(trip.dropoffDate)
              }
            />
          </>
        ) : null}
      </>
    );
  }

  return (
    <>
      {serviceDetailRows(order, formatDateTime).map((row) => (
        <DetailRow key={row.label} label={row.label} value={row.value} />
      ))}
    </>
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
      <dd className="text-right text-sm font-medium text-slate-900">{value}</dd>
    </div>
  );
}
