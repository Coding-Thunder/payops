"use client";

import * as React from "react";
import { BanknoteIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingButton } from "@/components/ui/loading-button";
import { BookingStatusBadge } from "@/components/common/status-badges";
import { toast } from "@/components/ui/sonner";
import { useCapturePayment } from "@/hooks/use-capture-payment";
import { ApiClientError } from "@/lib/api-client";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/format";
import { BookingStatus, PaymentCaptureStatus } from "@/lib/constants/enums";
import {
  describeServiceItem,
  serviceDetailRows,
  serviceItemLabel,
} from "@/lib/service-summary";
import type { OrderDTO } from "@/types";

interface CapturePaymentDialogProps {
  order: OrderDTO;
}

/**
 * "Capture payment" — turns an authorization into a real charge.
 *
 * This is the single irreversible money-moving control in the admin UI: a
 * mistaken capture cannot be undone, only refunded. So the dialog is a
 * READ-BEFORE-YOU-CHARGE surface — it restates who is being charged, what
 * they booked, how much, and by when the hold expires — and the confirm
 * button stays disabled until the operator explicitly acknowledges.
 *
 * The caller (`OrderPaymentCard`) decides whether to mount this at all,
 * keyed off `order.payment.capture?.status` — a per-ORDER, server-derived
 * fact — plus the actor's ORDER_CAPTURE_PAYMENT permission. It is never
 * keyed off the selected organization, which would let an operator with
 * two memberships see a Capture button on an automatic-capture order.
 */
export function CapturePaymentDialog({ order }: CapturePaymentDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [acknowledged, setAcknowledged] = React.useState(false);
  const { run, isPending } = useCapturePayment(order.id);

  const capture = order.payment.capture;
  const currency = order.pricing.currency;
  // Capture the full hold. `amountAuthorized` is what the gateway is
  // actually holding; pricing.amount is the pre-authorization fallback for
  // an order whose webhook has not filled the figure in yet.
  const amount = capture?.amountAuthorized ?? order.pricing.amount;
  const rows = serviceDetailRows(order, (value) => formatDate(value));
  const retry = capture?.status === PaymentCaptureStatus.CAPTURE_FAILED;

  function reset(next: boolean) {
    setOpen(next);
    if (!next) setAcknowledged(false);
  }

  async function onConfirm() {
    if (!acknowledged || isPending) return;
    try {
      // No `amount` — capture the whole authorized hold. Partial capture is
      // supported by the API but is not an operator-facing control yet.
      await run();
      toast.success(`Captured ${formatCurrency(amount, currency)}`);
      reset(false);
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : "Could not capture the payment";
      toast.error(message);
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <BanknoteIcon className="size-3.5" />
        {retry ? "Retry capture" : "Capture payment"}
      </Button>

      <Dialog open={open} onOpenChange={reset}>
        <DialogContent
          size="lg"
          className="max-h-[min(88vh,720px)]"
          showCloseButton={!isPending}
          onInteractOutside={(e) => {
            // A capture in flight is real money at the gateway — don't let a
            // stray click dismiss the dialog mid-request.
            if (isPending) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (isPending) e.preventDefault();
          }}
        >
          <DialogHeader icon={<BanknoteIcon />} tone="warning">
            <DialogTitle>
              Charge {formatCurrency(amount, currency)} to this customer?
            </DialogTitle>
            <DialogDescription>
              This captures the authorization and moves real money now.
              Captures cannot be undone — correcting one means issuing a
              refund.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <dl className="grid grid-cols-1 gap-3 rounded-md border border-border bg-muted/30 p-3 text-sm sm:grid-cols-2">
              <SummaryRow label="Order" value={order.orderNumber} mono />
              <SummaryRow
                label="Booking status"
                value={
                  order.bookingStatus ? (
                    <BookingStatusBadge status={order.bookingStatus} />
                  ) : (
                    "—"
                  )
                }
              />
              <SummaryRow label="Customer" value={order.customer.name} />
              <SummaryRow label="Email" value={order.customer.email} />
              <SummaryRow
                label={serviceItemLabel(order)}
                value={describeServiceItem(order)}
                className="sm:col-span-2"
              />
              {rows.map((row) => (
                <SummaryRow
                  key={row.label}
                  label={row.label}
                  value={row.value}
                />
              ))}
            </dl>

            <div className="grid grid-cols-1 gap-3 rounded-md border border-warning-border/60 bg-warning-soft/60 p-3 text-sm sm:grid-cols-2">
              <SummaryRow
                label="Amount to charge"
                value={
                  <span className="text-base font-semibold tabular-nums">
                    {formatCurrency(amount, currency)}
                  </span>
                }
              />
              <SummaryRow label="Currency" value={currency} />
              <SummaryRow
                label="Authorization expires"
                value={
                  capture?.captureExpiresAt
                    ? formatDateTime(capture.captureExpiresAt)
                    : "—"
                }
                className="sm:col-span-2"
              />
            </div>

            {order.bookingStatus === BookingStatus.PENDING ? (
              <p className="text-xs text-muted-foreground">
                The booking is still awaiting confirmation. Capture once the
                supplier has confirmed it — the hold stays valid until the
                expiry above.
              </p>
            ) : null}

            {capture?.lastError ? (
              <p className="text-xs text-destructive">
                Last capture attempt failed: {capture.lastError}
              </p>
            ) : null}

            <label className="flex items-start gap-2.5 rounded-md border border-border p-3 text-sm">
              <Checkbox
                checked={acknowledged}
                onCheckedChange={(v) => setAcknowledged(v === true)}
                disabled={isPending}
                className="mt-0.5"
                aria-label="Confirm this capture"
              />
              <span className="text-muted-foreground">
                I have checked the details above and want to charge{" "}
                <span className="font-medium text-foreground">
                  {formatCurrency(amount, currency)}
                </span>{" "}
                to {order.customer.name} now.
              </span>
            </label>
          </DialogBody>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => reset(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <LoadingButton
              type="button"
              size="sm"
              onClick={onConfirm}
              disabled={!acknowledged}
              loading={isPending}
              loadingText="Capturing"
            >
              Capture {formatCurrency(amount, currency)}
            </LoadingButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SummaryRow({
  label,
  value,
  mono,
  className,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd
        className={
          mono
            ? "mt-1 font-mono text-xs text-foreground break-all"
            : "mt-1 text-sm font-medium text-foreground break-words"
        }
      >
        {value}
      </dd>
    </div>
  );
}
