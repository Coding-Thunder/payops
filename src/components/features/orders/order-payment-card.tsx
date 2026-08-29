"use client";

import { useRouter } from "next/navigation";
import type * as React from "react";
import { useState } from "react";
import {
  ExternalLinkIcon,
  RefreshCwIcon,
} from "lucide-react";

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
import {
  BookingStatusBadge,
  OrderStatusBadge,
  PaymentCaptureStatusBadge,
} from "@/components/common/status-badges";
import { CapturePaymentDialog } from "@/components/features/orders/capture-payment-dialog";
import { ReleaseAuthorizationDialog } from "@/components/features/orders/release-authorization-dialog";
import { toast } from "@/components/ui/sonner";
import { api, ApiClientError } from "@/lib/api-client";
import { formatCurrency, formatDateTime, formatRelative } from "@/lib/format";
import {
  OrderStatus,
  PaymentCaptureStatus,
  PaymentTiming,
} from "@/lib/constants/enums";
import { PaymentGatewayLabel } from "@/lib/constants/labels";
import { summarizeCharges } from "@/lib/charges";
import type { OrderDTO, OrderPaymentCapture } from "@/types";

interface OrderPaymentCardProps {
  order: OrderDTO;
  canRegenerate: boolean;
  /** ORDER_CAPTURE_PAYMENT. Additive — defaults to today's behaviour
   *  (no capture control), so existing callers are unaffected. */
  canCapture?: boolean;
  /** ORDER_VOID_AUTHORIZATION. Same additive default. */
  canRelease?: boolean;
}

interface RegenerateApiResponse {
  order: OrderDTO;
  checkoutUrl: string;
}

export function OrderPaymentCard({
  order,
  canRegenerate,
  canCapture = false,
  canRelease = false,
}: OrderPaymentCardProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const isPaid = order.status === OrderStatus.PAID;
  const isPending = order.status === OrderStatus.PAYMENT_PENDING;
  const isNotInitiated = order.status === OrderStatus.NOT_INITIATED;
  const isFailedOrExpired =
    order.status === OrderStatus.FAILED ||
    order.status === OrderStatus.EXPIRED;

  const amountReceived =
    order.payment.amountReceived ?? order.pricing.amount;

  // Breakdown is derived from the order's charges (legacy orders fall back to
  // a single prepaid line built from pricing.amount).
  const breakdown = summarizeCharges(order.charges, order.pricing.amount);
  const currency = order.pricing.currency;
  const hasCounterDue = breakdown.dueAtCounter > 0;

  // MANUAL-CAPTURE ONLY. `payment.capture` is null on every automatic-capture
  // order — i.e. every order the two incumbent brands have ever created — so
  // everything keyed off `capture` below renders nothing for them and this
  // card stays byte-identical to what it has always been.
  //
  // Note this is keyed off the ORDER, never off the selected organization:
  // an operator with memberships in a manual-capture org and an automatic
  // one must not see a Capture button after switching tenants.
  const capture = order.payment.capture;
  const captureStatus = capture?.status ?? null;
  const awaitingCapture =
    captureStatus === PaymentCaptureStatus.AUTHORIZED ||
    captureStatus === PaymentCaptureStatus.CAPTURE_FAILED;
  const showCapture = canCapture && awaitingCapture;
  const showRelease =
    canRelease &&
    (awaitingCapture ||
      captureStatus === PaymentCaptureStatus.PENDING_AUTHORIZATION);

  const refunded = order.refundedAmount ?? 0;
  const disputeStatus = order.dispute?.status ?? null;

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
            {capture
              ? describeCaptureLifecycle(capture)
              : isPaid
                ? `Settled ${formatRelative(order.payment.paidAt)}`
                : isPending
                  ? `Awaiting customer payment`
                  : isFailedOrExpired
                    ? `Payment ${order.status.toLowerCase()}`
                    : isNotInitiated
                      ? `Payment link not generated yet`
                      : null}
          </CardDescription>
        </div>
        <OrderStatusBadge status={order.status} />
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <Field
            label={isPaid ? "Paid online" : "Charged online"}
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
          <Field
            label="Expires"
            value={
              order.payment.expiresAt
                ? formatDateTime(order.payment.expiresAt)
                : "—"
            }
          />
          <Field
            label="Gateway"
            value={
              order.payment.gateway
                ? PaymentGatewayLabel[order.payment.gateway]
                : "—"
            }
          />
          <Field
            label="Payment session"
            value={order.payment.paymentSessionId ?? "—"}
            mono
          />
        </div>

        {/* AUTHORIZATION — manual capture only. Absent (null) for both
            incumbent brands, so this whole subtree is unreachable there.
            Three DIFFERENT lifecycles are on this card and none of them is
            allowed to stand in for another: `OrderStatusBadge` above is the
            PAYMENT state, this badge is the AUTHORIZATION state, and
            `BookingStatusBadge` is whether the supplier confirmed the trip. */}
        {capture ? (
          <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Authorization
              </p>
              <PaymentCaptureStatusBadge status={capture.status} />
            </div>

            <p className="text-xs text-muted-foreground">
              {captureHelpText(capture.status)}
            </p>

            <div className="grid grid-cols-2 gap-4 text-sm">
              <Field
                label="Authorized at"
                value={
                  capture.authorizedAt
                    ? formatDateTime(capture.authorizedAt)
                    : "—"
                }
              />
              <Field
                label="Amount authorized"
                value={
                  capture.amountAuthorized !== null
                    ? formatCurrency(capture.amountAuthorized, currency)
                    : "—"
                }
              />
              <Field
                label="Capture deadline"
                value={
                  capture.captureExpiresAt
                    ? formatDateTime(capture.captureExpiresAt)
                    : "—"
                }
              />
              <Field
                label="Captured at"
                value={
                  capture.capturedAt ? formatDateTime(capture.capturedAt) : "—"
                }
              />
              <Field
                label="Amount captured"
                value={
                  capture.amountCaptured !== null
                    ? formatCurrency(capture.amountCaptured, currency)
                    : "—"
                }
              />
              {capture.cancelledAt ? (
                <Field
                  label="Hold released"
                  value={formatDateTime(capture.cancelledAt)}
                />
              ) : null}
              {capture.cancelReason ? (
                <div className="col-span-2">
                  <Field label="Release reason" value={capture.cancelReason} />
                </div>
              ) : null}
              {order.bookingStatus ? (
                <div className="col-span-2">
                  <Field
                    label="Booking (not payment)"
                    value={<BookingStatusBadge status={order.bookingStatus} />}
                  />
                </div>
              ) : null}
              {capture.lastError ? (
                <div className="col-span-2">
                  <Field
                    label="Last capture error"
                    value={
                      <span className="text-destructive">
                        {capture.lastError}
                      </span>
                    }
                  />
                </div>
              ) : null}
            </div>

            {showCapture || showRelease ? (
              <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                {showCapture ? <CapturePaymentDialog order={order} /> : null}
                {showRelease ? (
                  <ReleaseAuthorizationDialog order={order} />
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

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
            <span className="text-muted-foreground">Amount paid online</span>
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

        {order.payment.failureReason ? (
          <Alert variant="destructive">
            <AlertTitle>Payment problem reported by the gateway</AlertTitle>
            <AlertDescription>{order.payment.failureReason}</AlertDescription>
          </Alert>
        ) : null}

        {/* Money that came BACK. Rendered only when there is something to
            report, so an order with no refund and no chargeback — which is
            every order on the happy path — is untouched. */}
        {refunded > 0 ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
            <span className="text-muted-foreground">
              Refunded to the customer
            </span>
            <span className="font-medium tabular-nums">
              {formatCurrency(refunded, currency)}
            </span>
          </div>
        ) : null}

        {disputeStatus ? (
          <Alert variant="destructive">
            <AlertTitle>
              Chargeback — {humanizeEnum(disputeStatus)}
            </AlertTitle>
            <AlertDescription>
              {[
                order.dispute?.amount !== null &&
                order.dispute?.amount !== undefined
                  ? `${formatCurrency(
                      order.dispute.amount,
                      order.dispute.currency ?? currency,
                    )} disputed`
                  : null,
                order.dispute?.openedAt
                  ? `opened ${formatDateTime(order.dispute.openedAt)}`
                  : null,
                order.dispute?.reason ? `reason: ${order.dispute.reason}` : null,
                order.dispute?.outcome
                  ? `outcome: ${humanizeEnum(order.dispute.outcome)}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ") || "A chargeback has been raised on this payment."}
            </AlertDescription>
          </Alert>
        ) : null}

        {isPending && order.payment.paymentUrl ? (
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-muted/40 p-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Payment link to share with the customer
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
              {canRegenerate ? (
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

        {isFailedOrExpired && canRegenerate ? (
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
      </CardContent>
    </Card>
  );
}

/**
 * One-line header copy for a manual-capture order. Deliberately talks about
 * the MONEY, not the booking — "confirmed" here would be read as the
 * supplier having confirmed the trip, which is `order.bookingStatus`.
 */
function describeCaptureLifecycle(capture: OrderPaymentCapture): string {
  switch (capture.status) {
    case PaymentCaptureStatus.PENDING_AUTHORIZATION:
      return "Waiting for the customer to authorize their card";
    case PaymentCaptureStatus.AUTHORIZED:
      return "Card authorized — needs capture to take the money";
    case PaymentCaptureStatus.CAPTURE_PENDING:
      return "Capture in progress at the gateway";
    case PaymentCaptureStatus.CAPTURED:
      return capture.capturedAt
        ? `Captured ${formatRelative(capture.capturedAt)}`
        : "Captured";
    case PaymentCaptureStatus.CAPTURE_FAILED:
      return "Capture failed — the hold is still in place";
    case PaymentCaptureStatus.CANCELLED:
      return "Hold released — the customer was never charged";
    case PaymentCaptureStatus.AUTHORIZATION_EXPIRED:
      return "Authorization expired — the hold has lapsed uncaptured";
    default:
      return "";
  }
}

/** The "so what do I do about it" sentence under the authorization badge. */
function captureHelpText(status: PaymentCaptureStatus): string {
  switch (status) {
    case PaymentCaptureStatus.PENDING_AUTHORIZATION:
      return "No hold exists yet. Nothing can be captured until the customer completes checkout.";
    case PaymentCaptureStatus.AUTHORIZED:
      return "The funds are held but NOT taken. Capture to charge the card, or release the hold to let them go.";
    case PaymentCaptureStatus.CAPTURE_PENDING:
      return "A capture has been sent to the gateway. This page updates itself when it settles.";
    case PaymentCaptureStatus.CAPTURED:
      return "The money has been taken. Reversing it now means issuing a refund.";
    case PaymentCaptureStatus.CAPTURE_FAILED:
      return "The gateway rejected the capture. The hold is still live — retry, or release it.";
    case PaymentCaptureStatus.CANCELLED:
      return "The hold was released without a charge. Nothing was taken from the customer.";
    case PaymentCaptureStatus.AUTHORIZATION_EXPIRED:
      return "The hold lapsed before it was captured. Charging this order now needs a fresh payment link.";
    default:
      return "";
  }
}

/** `WARNING_NEEDS_RESPONSE` → `Warning needs response`. */
function humanizeEnum(value: string): string {
  const spaced = value.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  /** Widened from `string` so a Field can carry a badge. Every existing
   *  call site passes a string and is unaffected. */
  value: React.ReactNode;
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
