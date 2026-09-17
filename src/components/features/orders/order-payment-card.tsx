"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  ExternalLinkIcon,
  RefreshCwIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CopyButton } from "@/components/common/copy-button";
import { ManualPaymentDialog } from "@/components/features/orders/manual-payment-dialog";
import { SwitchGatewayDialog } from "@/components/features/orders/switch-gateway-dialog";
import { OrderStatusBadge } from "@/components/common/status-badges";
import { toast } from "@/components/ui/sonner";
import { api, ApiClientError } from "@/lib/api-client";
import { formatCurrency, formatDateTime, formatRelative } from "@/lib/format";
import {
  OrderStatus,
  PaymentGatewayKey,
  PaymentTiming,
} from "@/lib/constants/enums";
import { PaymentGatewayLabel } from "@/lib/constants/labels";
import { summarizeCharges } from "@/lib/charges";
import {
  heldPaymentSource,
  isOperatorSupersede,
  isSessionSuperseded,
  outstandingHeldPayments,
} from "@/lib/payment-state";
import type { OrderDTO } from "@/types";

interface OrderPaymentCardProps {
  order: OrderDTO;
  canRegenerate: boolean;
  /** Switching gateway and recording a manual payment are admin actions
   *  (ORDER_UPDATE); STAFF were shown both and then refused. */
  canManagePayment?: boolean;
}

interface RegenerateApiResponse {
  order: OrderDTO;
  checkoutUrl: string;
}

export function OrderPaymentCard({
  order,
  canRegenerate,
  canManagePayment = true,
}: OrderPaymentCardProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const isPaid = order.status === OrderStatus.PAID;
  const isPending = order.status === OrderStatus.PAYMENT_PENDING;
  // A generated link is shareable whether or not the request email has gone
  // out yet. Gating the link display on PAYMENT_PENDING alone hid the link
  // an operator had just generated — including the new one a gateway switch
  // produces, which lands the order at LINK_GENERATED.
  const hasShareableLink =
    isPending || order.status === OrderStatus.LINK_GENERATED;
  const isNotInitiated = order.status === OrderStatus.NOT_INITIATED;
  const isFailedOrExpired =
    order.status === OrderStatus.FAILED ||
    order.status === OrderStatus.EXPIRED;
  // Settled outside PayOps: nothing was paid online, and the operator's
  // recorded method and reference are what identify the payment.
  const settledManually =
    isPaid && order.payment.gateway === PaymentGatewayKey.MANUAL;
  // The latest request asked for manual collection: nothing is charged
  // online, whatever link the order once had.
  const manualRequested =
    !isPaid && order.consent?.collectionMethod === "MANUAL";
  const heldPayment = outstandingHeldPayments(order).length > 0;
  const stoodDown =
    order.status === OrderStatus.FAILED &&
    isOperatorSupersede(order.payment.failureReason);

  const amountReceived =
    order.payment.amountReceived ?? order.pricing.amount;

  // Breakdown is derived from the order's charges (legacy orders fall back to
  // a single prepaid line built from pricing.amount).
  const breakdown = summarizeCharges(order.charges, order.pricing.amount);
  const currency = order.pricing.currency;
  const hasCounterDue = breakdown.dueAtCounter > 0;

  async function regenerate() {
    setSubmitting(true);
    try {
      await api.post<RegenerateApiResponse>(
        `/api/orders/${order.id}/regenerate-link`,
      );
      toast.success("New payment link generated");
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : "Could not regenerate the link";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Payment</CardTitle>
          <CardDescription>
            {isPaid
              ? `Settled ${formatRelative(order.payment.paidAt)}`
              : heldPayment
                ? "Payment already received on an earlier link — reconcile it"
              : manualRequested
                ? "Manual payment requested"
              : order.status === OrderStatus.LINK_GENERATED
                ? "Link ready — not sent to the customer yet"
              : isPending
                ? `Awaiting customer payment`
                : stoodDown
                  ? "Previous link stood down — a new link is needed"
                  : isFailedOrExpired
                  ? `Payment ${order.status.toLowerCase()}`
                  : isNotInitiated
                    ? `Payment link not generated yet`
                    : null}
          </CardDescription>
        </div>
        {manualRequested ? (
          <Badge variant="secondary">Manual requested</Badge>
        ) : (
          <OrderStatusBadge status={order.status} />
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <Field
            label={
              settledManually
                ? "Paid (recorded manually)"
                : isPaid
                  ? "Paid online"
                  : manualRequested
                    ? "To be charged (manual)"
                    : "To be charged online"
            }
            value={formatCurrency(
              isPaid ? amountReceived : breakdown.prepaid,
              currency,
            )}
          />
          <Field
            label={isPaid ? "Amount received" : "Currency"}
            value={
              isPaid
                ? formatCurrency(amountReceived, currency)
                : currency
            }
          />
          {isPaid || manualRequested ? null : (
            <Field
              label="Link expires"
              value={
                order.payment.expiresAt
                  ? formatDateTime(order.payment.expiresAt)
                  : "—"
              }
            />
          )}
          {/* A manual-only request has no gateway or session to show. */}
          {manualRequested && !order.payment.paymentSessionId ? null : (
            <Field
              label="Gateway"
              value={
                settledManually
                  ? "Manual payment"
                  : order.payment.gateway
                    ? PaymentGatewayLabel[order.payment.gateway]
                    : "—"
              }
            />
          )}
          {settledManually ? (
            <>
              <Field label="Method" value={order.payment.manualMethod ?? "—"} />
              <Field
                label="Reference"
                value={order.payment.manualReference ?? "—"}
                mono
              />
            </>
          ) : null}
          {manualRequested && !order.payment.paymentSessionId ? null : (
            <Field
              label={
                isSessionSuperseded(order.payment)
                  ? "Previous session (stood down)"
                  : "Payment session"
              }
              value={order.payment.paymentSessionId ?? "—"}
              mono
            />
          )}
        </div>

        {/* Charge breakdown — single source of truth for the three figures.
            Only render the per-line list / due-at-counter rows when there is
            something beyond a single prepaid line. */}
        <div className="space-y-1.5 rounded-md border border-border bg-muted/30 p-3 text-sm">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Charge breakdown
          </p>
          {breakdown.charges.length > 0 ? (
            <div className="space-y-1 pb-1">
              {breakdown.charges.map((c, i) => (
                <div key={i} className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">
                    {c.name}
                    <span className="ml-1.5 text-[11px] uppercase tracking-wide">
                      {c.timing === PaymentTiming.PREPAID
                        ? "· prepaid"
                        : "· at counter"}
                    </span>
                  </span>
                  <span className="tabular-nums">
                    {formatCurrency(c.amount, currency)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex items-center justify-between border-t pt-1.5">
            <span className="text-muted-foreground">
              {settledManually
                ? "Amount paid"
                : isPaid
                  ? "Amount paid online"
                  : manualRequested
                    ? "Amount to prepay"
                    : "Amount to pay online"}
            </span>
            <span className="font-medium tabular-nums">
              {formatCurrency(breakdown.prepaid, currency)}
            </span>
          </div>
          {hasCounterDue ? (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Amount due at counter</span>
              <span className="font-medium tabular-nums">
                {formatCurrency(breakdown.dueAtCounter, currency)}
              </span>
            </div>
          ) : null}
          <div className="flex items-center justify-between">
            <span className="font-medium">Total rental cost</span>
            <span className="font-semibold tabular-nums">
              {formatCurrency(breakdown.total, currency)}
            </span>
          </div>
        </div>

        {order.payment.failureReason && !heldPayment ? (
          isOperatorSupersede(order.payment.failureReason) ? (
            // Stood down by an operator action, not declined by the gateway.
            <Alert>
              <AlertTitle>
                {manualRequested
                  ? "The online payment link was stopped"
                  : "The previous payment link was stood down"}
              </AlertTitle>
              <AlertDescription>
                {manualRequested
                  ? "A manual payment was requested instead, so the customer can no longer pay online."
                  : `${order.payment.failureReason}. It can no longer be paid — generate a new link or record a manual payment.`}
              </AlertDescription>
            </Alert>
          ) : (
            <Alert variant="destructive">
              <AlertTitle>Payment problem reported by the gateway</AlertTitle>
              <AlertDescription>{order.payment.failureReason}</AlertDescription>
            </Alert>
          )
        ) : null}

        {attemptRows(order).length > 0 ? (
          // Stripe declined, then PayPal — the operator needs the history in
          // front of them, not only in the audit log.
          <details className="rounded-md border border-border p-3 text-sm">
            <summary className="cursor-pointer text-[12px] font-medium">
              Payment attempts ({attemptRows(order).length})
            </summary>
            <ul className="mt-2 space-y-1.5">
              {attemptRows(order).map((a, i) => (
                <li
                  key={`${a.sessionId ?? "attempt"}-${i}`}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5"
                >
                  <span>
                    {PaymentGatewayLabel[a.gateway] ?? a.gateway} ·{" "}
                    {formatCurrency(a.amount, a.currency)}
                  </span>
                  <span className="text-[12px] text-muted-foreground">
                    {describeAttempt(a)} · {formatDateTime(a.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {hasShareableLink && order.payment.paymentUrl ? (
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-muted/40 p-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {order.consent?.collectionMethod === "MANUAL"
                  ? "Earlier payment link — still live (the latest request is for manual payment)"
                  : "Payment link to share with the customer"}
              </p>
              <p className="mt-1 font-mono text-xs break-all">
                {order.payment.paymentUrl}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <CopyButton value={order.payment.paymentUrl} label="Copy link" />
              <Button asChild variant="outline" size="sm">
                <a
                  href={order.payment.paymentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLinkIcon className="size-3.5" />
                  Open in new tab
                </a>
              </Button>
              {canRegenerate && !heldPayment ? (
                <LoadingButton
                  variant="ghost"
                  size="sm"
                  onClick={regenerate}
                  loading={submitting}
                  loadingText="Regenerating"
                  icon={<RefreshCwIcon className="size-3.5" />}
                >
                  Regenerate link
                </LoadingButton>
              ) : null}
            </div>
          </div>
        ) : null}

        {isFailedOrExpired && canRegenerate && !heldPayment && !manualRequested ? (
          <LoadingButton
            variant="outline"
            size="sm"
            onClick={regenerate}
            loading={submitting}
            loadingText="Generating"
            icon={<RefreshCwIcon className="size-3.5" />}
          >
            Generate a new payment link
          </LoadingButton>
        ) : null}

        {/* Stripe declined → offer PayPal on the SAME order. Hidden once the
            order is settled: a second payable link against a paid order is
            precisely the double charge this must not create. */}
        {!isPaid && canManagePayment ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {/* No gateway to switch away from until a link has existed. */}
            {/* While a payment is held, no new link: only reconciliation. */}
            {/* A manual request is the chosen method; going back to a gateway
                is a deliberate choice on the payment-request page. */}
            {!isNotInitiated && !heldPayment && !manualRequested ? (
              <SwitchGatewayDialog order={order} />
            ) : null}
            {/* The offline fallback, offered alongside the gateway switch —
                which is exactly the decision point the operator is at when
                a gateway has just declined. Also offered on a never-initiated
                order: that is what a pure manual booking looks like, and
                hiding it there left the operator no way to record the
                payment. Hidden once settled. */}
            <ManualPaymentDialog order={order} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={
          mono
            ? "mt-1 font-mono text-xs text-foreground break-all"
            : "mt-1 text-sm text-foreground font-medium"
        }
      >
        {value}
      </p>
    </div>
  );
}

function describeAttempt(a: AttemptRow): string {
  if (a.held) {
    return a.heldReviewedAt
      ? `Paid ${heldPaymentSource(a)}, not accepted — reconciled`
      : `Paid ${heldPaymentSource(a)}, not accepted — held for review`;
  }
  const reason =
    a.supersededReason === "REPRICED"
      ? "replaced after an amount change"
      : a.supersededReason === "REGENERATED"
        ? "replaced by a new link"
        : a.supersededReason === "GATEWAY_SWITCHED"
          ? "replaced by another payment method"
          : a.supersededReason === "PAYMENT_HELD"
            ? "stopped: a payment was already received"
            : null;
  // A replaced link is history: say how it ended, not the state it was in
  // when it was replaced ("awaiting payment" read as if it still were).
  const outcome = a.failureReason
    ? `failed (${a.failureReason})`
    : a.status === OrderStatus.PAID
      ? "paid"
      : a.status === OrderStatus.EXPIRED
        ? "expired"
        : a.status === OrderStatus.FAILED
          ? "failed"
          : reason
            ? "not paid"
            : a.status === OrderStatus.PAYMENT_PENDING
              ? "sent, awaiting payment"
              : "link created";
  const text = reason ? `${outcome}, ${reason}` : outcome;
  return a.current ? `${text} (current link)` : text;
}

type AttemptRow = OrderDTO["payment"]["attempts"][number] & { current?: boolean };

/**
 * The attempts as an operator reads them: one row per link (the history can
 * record a link twice — live, then stood down — and the latest record is
 * the one that matters), each held payment as its own row, and the link the
 * order is collecting on now, which is not in the history until it ends.
 */
function attemptRows(order: OrderDTO): AttemptRow[] {
  const rows: AttemptRow[] = [];
  const bySession = new Map<string, number>();
  for (const a of order.payment.attempts ?? []) {
    if (a.held || !a.sessionId) {
      rows.push(a);
      continue;
    }
    const at = bySession.get(a.sessionId);
    if (at === undefined) {
      bySession.set(a.sessionId, rows.length);
      rows.push(a);
    } else {
      rows[at] = a;
    }
  }
  const current = order.payment.paymentSessionId;
  if (
    current &&
    order.payment.gateway &&
    order.payment.gateway !== "MANUAL" &&
    !bySession.has(current)
  ) {
    rows.push({
      gateway: order.payment.gateway,
      sessionId: current,
      amount: order.payment.amountReceived ?? order.pricing.amount,
      currency: order.pricing.currency,
      status: order.payment.status,
      failureReason: order.payment.failureReason,
      supersededReason: null,
      supersededAt: null,
      held: false,
      heldReviewedAt: null,
      heldKind: null,
      createdAt: order.payment.initiatedAt ?? order.createdAt,
      current: true,
    });
  }
  return rows;
}
