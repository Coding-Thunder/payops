import { getBranding } from "@/server/services/branding.service";
import {
  getOrderByNumber,
  reconcileOrderPayment,
} from "@/server/services/order.service";
import { OrderStatus } from "@/lib/constants/enums";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { logger } from "@/lib/logger";

import { PaymentSuccessAutoRefresh } from "./auto-refresh";

export const metadata = { title: "Payment received" };
export const dynamic = "force-dynamic";

interface SuccessPageProps {
  searchParams: Promise<{ order?: string; session_id?: string }>;
}

export default async function PaymentSuccessPage({
  searchParams,
}: SuccessPageProps) {
  const { order: orderNumber, session_id: sessionId } = await searchParams;

  // Defensive: require BOTH order and Stripe session id, and verify the
  // pair matches before rendering anything. The session id is server-
  // rendered into the success URL by Stripe via the {CHECKOUT_SESSION_ID}
  // placeholder, so anyone arriving here legitimately has it. Without
  // this pairing check, a curl loop over order-number space pulls full
  // PII for every paid order on the platform.
  let order = orderNumber ? await getOrderByNumber(orderNumber) : null;
  if (order && order.payment.paymentSessionId !== (sessionId ?? null)) {
    order = null;
  }

  // Pull THIS order's tenant branding (not the legacy singleton). When
  // the order pairing fails above, fall back to the no-orgId path which
  // returns neutral empty defaults — the page below already handles a
  // missing-order state, so the brand isn't rendered in that case.
  const branding = await getBranding(order?.orgId ?? null);

  // Self-heal the local-dev / dropped-webhook case at first render.
  // Stripe just sent the customer here, which means the session SHOULD
  // be paid. Ask Stripe directly; if confirmed, drive the same atomic
  // transition the webhook uses. By the time the page paints, the
  // order reflects Stripe's truth even if the webhook never reached us.
  if (
    order &&
    order.status === OrderStatus.PAYMENT_PENDING &&
    order.payment.paymentSessionId &&
    sessionId
  ) {
    try {
      const result = await reconcileOrderPayment(order.id, undefined, {
        sessionId,
      });
      order = result.order;
    } catch (err) {
      logger.warn("pay_success.reconcile_failed", {
        orderId: order.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const stillPending =
    order?.status === OrderStatus.PAYMENT_PENDING &&
    Boolean(order?.payment.paymentSessionId);
  const brand = branding.brandName;
  const supportEmail = branding.supportEmail;
  const supportPhone = branding.supportPhone;
  const amount = order
    ? formatCurrency(
        order.payment.amountReceived ?? order.pricing.amount,
        order.pricing.currency,
      )
    : null;
  const paidOn = order?.payment.paidAt
    ? formatDateTime(order.payment.paidAt)
    : null;
  // Pass 5h: universal-shape rendering. Provider/booking-type metadata
  // is gone; line items + scheduling carry whatever the order needs.
  const typeLabel = "Order";

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {/* ─── Hero ─── */}
      <div className="bg-gradient-to-br from-emerald-50 via-white to-white px-8 pt-10 pb-8 text-center">
        <div
          className={
            stillPending
              ? "mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 text-amber-700"
              : "mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600"
          }
        >
          {stillPending ? (
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
            stillPending
              ? "mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-amber-700"
              : "mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700"
          }
        >
          {stillPending ? "Confirming with Stripe" : "Payment confirmed"}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
          {stillPending ? "We’re confirming your payment" : "Payment received"}
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          {stillPending
            ? `${brand} is waiting for Stripe to finalise this charge. This page refreshes automatically.`
            : `Thank you. ${brand} has confirmed your payment and a receipt is on its way to your inbox.`}
        </p>
        {stillPending ? <PaymentSuccessAutoRefresh /> : null}
      </div>

      {order && amount ? (
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

          {/* ─── Order details (universal) ─── */}
          <div className="border-t border-slate-100 px-8 py-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.10em] text-slate-500">
              Order details
            </p>
            <dl className="mt-3 divide-y divide-slate-100 text-sm">
              <DetailRow label="Customer" value={order.customer.name} />
              <DetailRow label="Type" value={typeLabel} />
              {order.lineItems.length > 0 ? (
                <DetailRow
                  label={order.lineItems.length === 1 ? "Item" : "Items"}
                  value={order.lineItems
                    .map((l) =>
                      l.quantity > 1 ? `${l.quantity}× ${l.name}` : l.name,
                    )
                    .join(", ")}
                />
              ) : null}
              {order.scheduling ? (
                <>
                  <DetailRow
                    label="Starts"
                    value={formatDateTime(order.scheduling.startsAt)}
                  />
                  {order.scheduling.endsAt ? (
                    <DetailRow
                      label="Ends"
                      value={formatDateTime(order.scheduling.endsAt)}
                    />
                  ) : null}
                </>
              ) : null}
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
