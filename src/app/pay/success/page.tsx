import Image from "next/image";
import { cache } from "react";

import { FlightItinerary } from "@/components/common/flight-itinerary";
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
  providerLabelFor,
} from "@/lib/constants/labels";
import { resolveProvider } from "@/lib/constants/providers";
import {
  OrderStatus,
  PaymentCaptureStatus,
  PaymentGatewayKey,
  ServiceType,
} from "@/lib/constants/enums";
import {
  type FlightAmountLabels,
  type FlightAmountSummary,
  flightCollection,
  flightMoneyWording,
  HOLD_TODAY_LABEL,
  holdCondition,
  showsAirlineCharge,
  summarizeCharges,
  summarizeFlightAmounts,
} from "@/lib/charges";
import { buildFlightItinerary } from "@/lib/flight-itinerary";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { logger } from "@/lib/logger";
import {
  bookingReference,
  bookingReferenceWording,
  hasSeparateLegacyPnr,
  serviceDetailRows,
  serviceNoun,
  serviceTypeOf,
} from "@/lib/service-summary";
import type { OrderDTO } from "@/types";

import { PaymentSuccessAutoRefresh } from "./auto-refresh";

/**
 * Whether the order is still waiting on the gateway's word — its link out
 * (LINK_GENERATED) or its request sent (PAYMENT_PENDING) — rather than
 * settled one way or the other.
 *
 * LINK_GENERATED counts: an agent can hand the customer the link without
 * sending the request email (Copy payment link), so a customer can pay —
 * or put a hold on their card — and land here before the order ever moved
 * to PAYMENT_PENDING. Reading that order as settled told them "Payment
 * confirmed" before the gateway had confirmed anything.
 *
 * So does a manual-capture order a decline drove to FAILED while its hold
 * was still pending: Checkout keeps the session open, the customer pays
 * with another card and lands here before that authorization is recorded.
 * It is waiting on a hold, not settled — never "Payment received".
 */
function awaitingGateway(
  order: Pick<OrderDTO, "status" | "payment"> | null,
): boolean {
  return (
    order?.status === OrderStatus.PAYMENT_PENDING ||
    order?.status === OrderStatus.LINK_GENERATED ||
    (order?.status === OrderStatus.FAILED &&
      order.payment.capture?.status === PaymentCaptureStatus.PENDING_AUTHORIZATION)
  );
}

/**
 * A manual-capture hold: the card is authorized and the money HELD, not
 * taken — whether the request email went out (PAYMENT_PENDING) or the
 * customer paid from a copied link (LINK_GENERATED). That stays true while
 * an operator's capture is in flight or was refused (the hold still stands)
 * until the order is PAID. The page and its tab title read this one
 * predicate, so they can never disagree about it. `capture` is null on
 * every automatic-capture order, so it is false for one.
 */
function isAuthorizationHold(order: OrderDTO | null): boolean {
  const status = order?.payment.capture?.status;
  return (
    (status === PaymentCaptureStatus.AUTHORIZED ||
      status === PaymentCaptureStatus.CAPTURE_PENDING ||
      status === PaymentCaptureStatus.CAPTURE_FAILED) &&
    order?.status !== OrderStatus.PAID
  );
}

/**
 * A manual-capture hold that was let go — released by an operator, or
 * lapsed at the gateway — without the card ever being charged. The customer
 * must hear exactly that, never "payment received" nor "still confirming".
 */
function isReleasedHold(order: OrderDTO | null): boolean {
  const status = order?.payment.capture?.status;
  return (
    (status === PaymentCaptureStatus.CANCELLED ||
      status === PaymentCaptureStatus.AUTHORIZATION_EXPIRED) &&
    order?.status !== OrderStatus.PAID
  );
}

/**
 * A manual-capture order the customer has just authorized, whose hold the
 * gateway has not confirmed yet: the wait is for a HOLD to land, not a
 * charge, so nothing on the page may say money moved either way.
 */
function isConfirmingHold(order: OrderDTO | null): boolean {
  return (
    awaitingGateway(order) &&
    Boolean(order?.payment.paymentSessionId) &&
    order?.payment.capture?.status === PaymentCaptureStatus.PENDING_AUTHORIZATION
  );
}

/**
 * A manual-capture order that is neither paid, held, let go nor still
 * awaiting the gateway — its link expired, or the order was archived,
 * before any hold: no money moved and none is held. Never "Payment
 * received". `capture` is null on every automatic-capture order.
 */
function isUnchargedManual(order: OrderDTO | null): boolean {
  return (
    order?.payment.capture != null &&
    order.status !== OrderStatus.PAID &&
    !isAuthorizationHold(order) &&
    !isReleasedHold(order) &&
    !(awaitingGateway(order) && Boolean(order.payment.paymentSessionId))
  );
}

/** What a released hold's amount is called on this page. */
const RELEASED_HOLD_LABEL = "Hold released — not charged";

/**
 * The order this page is about — read, paired with the session the gateway
 * sent the customer back with, and reconciled — ONCE per request, shared by
 * the page and its tab title. Next renders the metadata alongside the page,
 * so two separate reads disagreed: a title read before the page's reconcile
 * said "Payment received" over a body that had just recorded a card hold,
 * and a title read without the pairing check named the state of an order
 * the page itself refused to show.
 */
const loadReturningOrder = cache(
  async (
    orderNumber: string | undefined,
    returnedSessionId: string | null,
  ): Promise<OrderDTO | null> => {
    // Defensive: require BOTH the order number and the gateway session id,
    // and verify the pair matches before rendering anything. Anyone arriving
    // here legitimately has both. Without this pairing check, a curl loop
    // over order-number space pulls full PII for every paid order on the
    // platform.
    let order = orderNumber ? await getOrderByNumber(orderNumber) : null;
    // No session on either side is no pairing at all: an order without a
    // session (a draft) must not match a link that carries none.
    if (
      order &&
      (!returnedSessionId ||
        order.payment.paymentSessionId !== returnedSessionId)
    ) {
      order = null;
    }

    // Self-heal the local-dev / dropped-webhook case at first render.
    // The gateway just sent the customer here, which means the session
    // SHOULD be settled. Ask the gateway directly; if confirmed, drive the
    // same atomic transition the webhook uses. By the time the page paints,
    // the order reflects the gateway's truth even if the webhook never
    // reached us.
    //
    // `reconcileOrderPayment` resolves the gateway from the order, so this
    // works for both. Note PayPal's APPROVED (buyer agreed, nothing
    // captured) correctly maps to "open", so a PayPal order that is only
    // approved stays pending here and the auto-refresh waits for the webhook
    // to capture.
    //
    // A manual-capture order is reconciled only while there is still
    // something to record: its authorization has not landed yet, or a
    // capture is in flight or failed — the gateway may have taken money the
    // app has not recorded, and for a manual order reconcile only ever
    // accepts a gateway-reported "paid". A held, released or lapsed hold is
    // the gateway's truth already. `payment.capture` is null on every
    // automatic-capture order, so this guard never fires for one.
    //
    // A LINK_GENERATED order is reconciled exactly like a PAYMENT_PENDING
    // one: a customer paying from a copied link arrives before any request
    // email moved the order on (`awaitingGateway`).
    const captureStatus = order?.payment.capture?.status ?? null;
    if (
      order &&
      awaitingGateway(order) &&
      (captureStatus === null ||
        captureStatus === PaymentCaptureStatus.PENDING_AUTHORIZATION ||
        captureStatus === PaymentCaptureStatus.CAPTURE_PENDING ||
        captureStatus === PaymentCaptureStatus.CAPTURE_FAILED) &&
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
    return order;
  },
);

/** Whichever gateway sent the customer back, the id of the session it
 *  created. Both gateways store it in `payment.paymentSessionId`. */
function returnedSessionIdOf(params: {
  session_id?: string;
  token?: string;
}): string | null {
  return params.session_id ?? params.token ?? null;
}

/**
 * PER-BRAND TAB TITLE, and honest about whether money actually moved.
 *
 * `title.absolute` opts out of the root layout's `"%s • <deployment name>"`
 * template so a FlightBizz customer's tab never reads another brand's name.
 * It reads the very order the page renders (`loadReturningOrder`), so the
 * two always agree: an order on a card HOLD — being confirmed, held, or let
 * go — has not been paid, and a session that matches no order names none.
 */
export async function generateMetadata({
  searchParams,
}: SuccessPageProps) {
  const params = await searchParams;
  const brand = await resolvePublicBrandForOrderNumber(
    params.order,
    await getBranding(),
  );
  const order = await loadReturningOrder(
    params.order,
    returnedSessionIdOf(params),
  );
  const headline =
    !order || isUnchargedManual(order)
    ? "Payment status"
    : isAuthorizationHold(order)
      ? "Card authorized"
      : isReleasedHold(order)
        ? "Hold released"
        : isConfirmingHold(order)
          ? "Confirming your card"
          : "Payment received";
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
  const params = await searchParams;
  const orderNumber = params.order;
  const branding = await getBranding();
  const order = await loadReturningOrder(
    orderNumber,
    returnedSessionIdOf(params),
  );

  // Manual capture: the card was authorized and the money is being HELD,
  // not taken. The customer must not be told the payment succeeded, and the
  // "we're still confirming" spinner is wrong too — nothing is in flight.
  // `capture` is null on every automatic-capture order, so `isAuthorized`,
  // `isReleased` and `confirmingHold` are all false for one and this page
  // renders exactly as it always has.
  const capture = order?.payment.capture ?? null;
  const isAuthorized = isAuthorizationHold(order);
  const isReleased = isReleasedHold(order);
  const holdExpired =
    isReleased && capture?.status === PaymentCaptureStatus.AUTHORIZATION_EXPIRED;
  // Still waiting on the gateway — never "Payment confirmed" before it has
  // confirmed, whether the order was emailed or its link copied. A released
  // hold is settled: nothing more will happen to it.
  const stillPending =
    awaitingGateway(order) &&
    Boolean(order?.payment.paymentSessionId) &&
    !isAuthorized &&
    !isReleased;
  // The same wait on a manual-capture order is for a HOLD to land, not a
  // charge — the copy must not promise money moved either way.
  const confirmingHold = stillPending && isConfirmingHold(order);
  // No order matched this session (a stale or hand-edited link — e.g. one
  // whose hold was released and a new link issued since): there is no
  // payment status to state, least of all "Payment received".
  const unmatched = !order;
  const notCharged = isUnchargedManual(order);
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
        isAuthorized || isReleased
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
  // An itinerary flight's payment link collects ONLY the service charge; the
  // airline fare is part of the booking value but never of this payment.
  // Every flight receipt says so, so a customer who sees "$50 paid" against a
  // $550 trip is never left to guess where the rest went. A flight created
  // before itineraries usually paid its whole fare here: same breakdown,
  // neutral labels, generic sentences. Null for every other service.
  const isFlight = order ? serviceTypeOf(order) === ServiceType.FLIGHT : false;
  const flightAmounts =
    order && isFlight
      ? summarizeFlightAmounts(
          order.charges,
          order.flight?.airlineFare,
          order.pricing.amount,
        )
      : null;
  const flightWording =
    order && isFlight
      ? flightMoneyWording(order.flight, order.bookingType, order.charges)
      : null;
  const flightLabels = flightWording?.labels ?? null;
  const serviceChargeModel = flightWording?.serviceChargeModel ?? false;
  // What has ACTUALLY happened to the money the link collects — the same
  // helper as the operator card and the evidence: collected only once the
  // order is PAID; on hold while a manual-capture hold still reserves the
  // card (authorized, capturing, or a failed capture); otherwise nothing
  // collected yet. A flight's labels follow it, so this page never says
  // "Paid" for money that was not taken, nor "payable" for money held.
  const flightMoney = order && flightLabels ? flightCollection(order) : null;
  const flightSettled =
    order && flightLabels && flightMoney && flightAmounts
      ? isReleased
        ? {
            label: RELEASED_HOLD_LABEL,
            amount: capture?.amountAuthorized ?? order.pricing.amount,
          }
        : notCharged
        ? { label: "Not charged", amount: order.pricing.amount }
        : confirmingHold
        ? { label: flightLabels.heldNow, amount: order.pricing.amount }
        : flightMoney.status === "COLLECTED"
        ? {
            label: flightLabels.paidNow,
            amount: flightMoney.amount ?? order.pricing.amount,
          }
        : flightMoney.status === "ON_HOLD"
          ? {
              label: flightLabels.heldNow,
              amount: capture?.amountAuthorized ?? order.pricing.amount,
            }
          : { label: flightLabels.payableNow, amount: flightAmounts.payableNow }
      : null;
  // The hero names the same state; while nothing is collected yet, an
  // itinerary flight's hero names WHAT the amount is — the service charge.
  const flightHeroLabel =
    flightLabels && flightSettled
      ? isReleased
        ? RELEASED_HOLD_LABEL
        : notCharged
          ? "Not charged"
          : confirmingHold
          ? flightLabels.heldNow
          : flightMoney?.status === "NOT_COLLECTED" && serviceChargeModel
          ? flightLabels.serviceCharge
          : flightSettled.label
      : null;
  const itinerary = flightAmounts ? buildFlightItinerary(order?.flight) : null;

  return (
    <PublicBrandChrome brand={publicBrand}>
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {/* ─── Hero ─── */}
        <div className="bg-gradient-to-br from-emerald-50 via-white to-white px-8 pt-10 pb-8 text-center">
          <div
            className={
              isAuthorized
                ? "mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-sky-100 text-sky-700"
                : isReleased || unmatched || notCharged
                  ? "mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-600"
                  : stillPending
                  ? "mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 text-amber-700"
                  : "mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600"
            }
          >
            {unmatched || notCharged ? (
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
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4" />
                <path d="M12 8h.01" />
              </svg>
            ) : isAuthorized || isReleased ? (
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
                : isReleased || unmatched || notCharged
                  ? "mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-slate-600"
                  : stillPending
                  ? "mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-amber-700"
                  : "mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700"
            }
          >
            {unmatched || notCharged
              ? "Payment status"
              : isAuthorized
              ? "Card authorized"
              : isReleased
                ? "Hold released"
                : stillPending
                  ? `Confirming with ${gatewayLabel ?? "your bank"}`
                  : "Payment confirmed"}
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
            {unmatched
              ? "We couldn’t match this payment"
              : notCharged
              ? "You have not been charged"
              : isAuthorized
              ? "Your card has been authorized"
              : isReleased
                ? "You have not been charged"
                : confirmingHold
                  ? "We’re confirming your card"
                  : stillPending
                    ? "We’re confirming your payment"
                    : "Payment received"}
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            {unmatched
              ? `This link doesn’t match a current ${brand} payment, so there is no payment status to show here. Your latest email from ${brand} has the up-to-date details of your booking.`
              : notCharged
              ? `This payment link is no longer active, and nothing was charged to your card. Your latest email from ${brand} has the up-to-date details of your booking.`
              : serviceChargeModel
              ? flightHeroCopy({
                  chargeName: flightWording?.chargeName ?? "",
                  bookingType: order?.bookingType ?? null,
                  brand,
                  amount,
                  gatewayLabel,
                  isAuthorized,
                  isReleased,
                  holdExpired,
                  confirmingHold,
                  stillPending,
                })
              : isAuthorized
                ? `${brand} has placed a hold on your card${amount ? ` for ${amount}` : ""}. You have not been charged yet — the amount is collected only once ${holdCondition(order?.bookingType, noun)}, and you’ll get a receipt then.`
                : isReleased
                  ? releasedHoldCopy({
                      brand,
                      held: amount ? ` for ${amount}` : "",
                      expired: holdExpired,
                    })
                  : confirmingHold
                    ? `${brand} is waiting for ${gatewayLabel ?? "the payment provider"} to confirm the hold on your card. You won’t be charged until ${holdCondition(order?.bookingType, noun)}. This page refreshes automatically.`
                    : stillPending
                      ? `${brand} is waiting for ${gatewayLabel ?? "the payment provider"} to finalise this charge. This page refreshes automatically.`
                      : `Thank you. ${brand} has confirmed your payment and a receipt is on its way to your inbox.`}
          </p>
          {stillPending ? (
            <PaymentSuccessAutoRefresh
              gatewayLabel={gatewayLabel}
              {...(confirmingHold ? { hold: true } : {})}
            />
          ) : null}
        </div>

        {order && providerMeta && amount ? (
          <>
            {/* ─── Amount + Order ─── */}
            <div className="grid grid-cols-2 gap-4 border-t border-slate-100 px-8 py-6">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.10em] text-slate-500">
                  {flightHeroLabel
                    ? flightHeroLabel
                    : isAuthorized
                      ? "Amount on hold"
                      : isReleased
                        ? RELEASED_HOLD_LABEL
                        : confirmingHold
                          ? HOLD_TODAY_LABEL
                          : notCharged
                            ? "Not charged"
                            : "Amount paid"}
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

            {/* ─── Charge breakdown (always for a flight; otherwise only
                when a counter balance remains) ─── */}
            {flightAmounts && flightLabels && flightSettled ? (
              <FlightAmountBreakdown
                amounts={flightAmounts}
                labels={flightLabels}
                currency={order.pricing.currency}
                settledLabel={flightSettled.label}
                settledAmount={flightSettled.amount}
              />
            ) : hasCounterDue && breakdown ? (
              <div className="border-t border-slate-100 px-8 py-5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.10em] text-slate-500">
                  Charge breakdown
                </p>
                <dl className="mt-3 space-y-1.5 text-sm">
                  <div className="flex items-center justify-between">
                    <dt className="text-slate-500">
                      {isAuthorized
                        ? "Authorized online today"
                        : isReleased
                          ? RELEASED_HOLD_LABEL
                          : confirmingHold
                            ? HOLD_TODAY_LABEL
                            : notCharged
                              ? "Not charged"
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
                <DetailRow
                  label={providerLabelFor(serviceTypeOf(order), "Provider")}
                  value={providerMeta.name}
                />
                <ServiceDetailRows order={order} />
                {isAuthorized && capture?.captureExpiresAt ? (
                  <DetailRow
                    label="Authorization expires"
                    value={formatDateTime(capture.captureExpiresAt)}
                  />
                ) : null}
                <BookingReferenceRow order={order} />
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

            {/* ─── Itinerary (flights only): every flight and layover ─── */}
            {itinerary ? (
              <div className="border-t border-slate-100 px-8 py-6">
                <p className="text-[11px] font-semibold uppercase tracking-[0.10em] text-slate-500">
                  Itinerary
                </p>
                <FlightItinerary itinerary={itinerary} className="mt-3" />
              </div>
            ) : null}

            {/* ─── Processor trust line ─── */}
            <div className="border-t border-slate-100 px-8 py-4 text-center text-[11px] text-slate-500">
              {isAuthorized
                ? gatewayLabel
                  ? `Card authorized securely by ${gatewayLabel} — PCI-DSS Level 1 certified.`
                  : "Card authorized securely."
                : isReleased || confirmingHold || notCharged
                  ? gatewayLabel
                    ? `Card details handled securely by ${gatewayLabel} — PCI-DSS Level 1 certified.`
                    : "Card details handled securely."
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
 * CAR_RENTAL string is the literal this page has always rendered. A flight
 * renders `FlightAmountBreakdown` instead, so its case is only a safety net
 * — and never says check-in: nothing is paid at an airport desk.
 */
function balanceDueLabel(order: OrderDTO): string {
  switch (serviceTypeOf(order)) {
    case ServiceType.FLIGHT:
      return flightMoneyWording(order.flight, order.bookingType).labels.dueLater;
    case ServiceType.HOTEL:
      return "Remaining balance due at the property";
    case ServiceType.CAR_RENTAL:
    default:
      return "Remaining balance due at rental counter";
  }
}

/**
 * Hero copy for an itinerary flight. Says outright that the payment — or the
 * hold, on manual capture — covers the SERVICE CHARGE, because the airline
 * fare is never part of what the payment link collects. A flight created
 * before itineraries gets the generic copy instead.
 */
function flightHeroCopy({
  chargeName,
  bookingType,
  brand,
  amount,
  gatewayLabel,
  isAuthorized,
  isReleased,
  holdExpired,
  confirmingHold,
  stillPending,
}: {
  /** The operator's name for the collected charge. */
  chargeName: string;
  /** What the hold is for — a change or a cancellation charge is not
   *  collected "once your flight is confirmed". */
  bookingType: string | null;
  brand: string;
  amount: string | null;
  gatewayLabel: string | null;
  isAuthorized: boolean;
  isReleased: boolean;
  holdExpired: boolean;
  confirmingHold: boolean;
  stillPending: boolean;
}): string {
  if (isAuthorized) {
    return `${brand} has placed a hold on your card for the ${chargeName}${amount ? ` of ${amount}` : ""}. You have not been charged yet — the amount is collected only once ${holdCondition(bookingType, "flight")}, and you’ll get a receipt then.`;
  }
  if (isReleased) {
    return releasedHoldCopy({
      brand,
      held: ` for the ${chargeName}${amount ? ` of ${amount}` : ""}`,
      expired: holdExpired,
    });
  }
  if (confirmingHold) {
    return `${brand} is waiting for ${gatewayLabel ?? "the payment provider"} to confirm the hold on your card for the ${chargeName}. You won’t be charged until ${holdCondition(bookingType, "flight")}. This page refreshes automatically.`;
  }
  if (stillPending) {
    return `${brand} is waiting for ${gatewayLabel ?? "the payment provider"} to finalise your ${chargeName} payment. This page refreshes automatically.`;
  }
  return `Thank you. ${brand} has confirmed your ${chargeName} payment and a receipt is on its way to your inbox.`;
}

/**
 * Hero copy for a manual-capture hold that ended without a charge —
 * released by the operator, or lapsed at the gateway. It promises only what
 * is true of THIS hold: a cancelled authorization can never be captured. It
 * claims nothing about the booking (a lapsed hold says nothing about whether
 * it was confirmed, and the business may still ask for a new payment), and
 * only the bank decides how fast the pending line leaves the statement.
 */
function releasedHoldCopy({
  brand,
  held,
  expired,
}: {
  brand: string;
  /** " for $480.00", " for the Service Charge of $50.00", or "". */
  held: string;
  expired: boolean;
}): string {
  const lead = expired
    ? `The hold on your card${held} has expired and been released.`
    : `${brand} has released the hold on your card${held}.`;
  return `${lead} You have not been charged, and this hold will never be collected. Your bank may take a few days to remove the pending amount from your statement.`;
}

/**
 * A flight's money, every time: what was paid (the service charge, on an
 * itinerary flight) set against what the booking is worth — Airline Charge,
 * Service Charge, Total Booking Value, then the amount this payment took,
 * the same rows as the consent page and the emails. Unlike a rental's
 * breakdown it does not wait for a counter balance — its whole job is to
 * show that the airline charge is not part of this payment. Labels come
 * from `flightMoneyWording`, shared with the consent page and the emails.
 */
function FlightAmountBreakdown({
  amounts,
  labels,
  currency,
  settledLabel,
  settledAmount,
}: {
  amounts: FlightAmountSummary;
  labels: FlightAmountLabels;
  currency: string;
  /** What happened to the amount the link collects: paid, on hold, or —
   *  nothing collected yet — payable now. */
  settledLabel: string;
  settledAmount: number;
}) {
  const showAirline = showsAirlineCharge(amounts);
  return (
    <div className="border-t border-slate-100 px-8 py-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.10em] text-slate-500">
        {labels.breakdownTitle}
      </p>
      <dl className="mt-3 space-y-1.5 text-sm">
        {showAirline ? (
          <div className="flex items-start justify-between gap-3">
            <dt className="text-slate-500">
              {labels.airlineFare}
              <span className="block text-xs text-slate-400">
                {labels.airlineFareNote}
              </span>
            </dt>
            <dd className="tabular-nums text-slate-900">
              {formatCurrency(amounts.airlineFare, currency)}
            </dd>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <dt className="text-slate-500">{labels.serviceCharge}</dt>
          <dd className="tabular-nums text-slate-900">
            {formatCurrency(amounts.serviceCharge, currency)}
          </dd>
        </div>
        {/* Only a flight created before flights became prepaid-only. */}
        {amounts.dueLater > 0 ? (
          <div className="flex items-center justify-between gap-3">
            <dt className="text-slate-500">{labels.dueLater}</dt>
            <dd className="tabular-nums text-slate-900">
              {formatCurrency(amounts.dueLater, currency)}
            </dd>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-1.5 font-medium">
          <dt className="text-slate-700">{labels.bookingTotal}</dt>
          <dd className="tabular-nums text-slate-900">
            {formatCurrency(amounts.bookingTotal, currency)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3 font-semibold">
          <dt className="text-slate-900">{settledLabel}</dt>
          <dd className="tabular-nums text-slate-900">
            {formatCurrency(settledAmount, currency)}
          </dd>
        </div>
      </dl>
      {showAirline ? (
        <p className="mt-3 text-xs text-slate-500">
          {labels.airlineFareExplainer}
        </p>
      ) : null}
    </div>
  );
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
 * and the emails all describe a flight or a hotel identically. For a flight
 * those are the trip-level rows only; the flights themselves render in the
 * Itinerary section below the list.
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

/**
 * The booking's ONE supplier reference (`bookingReference`), once, under
 * the service's own name for it (`bookingReferenceCopy`): "Confirmation #"
 * on a rental — the row this receipt has always had — and "Hotel
 * confirmation #" on a hotel. A flight's is not repeated here: its "PNR"
 * row is already one of the shared service rows above, and a second row
 * would print the same reference twice (or, on an older flight, two
 * different ones).
 */
function BookingReferenceRow({ order }: { order: OrderDTO }) {
  const serviceType = serviceTypeOf(order);
  const reference = bookingReference(order);
  if (!reference) return null;
  // An older flight that keeps its airline PNR apart from a pasted
  // supplier number shows that number here, as it always did.
  if (serviceType === ServiceType.FLIGHT && !hasSeparateLegacyPnr(order)) {
    return null;
  }
  return (
    <DetailRow
      label={bookingReferenceWording(order).receiptLabel}
      value={reference}
    />
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
