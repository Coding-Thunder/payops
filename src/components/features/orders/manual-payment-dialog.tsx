"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BanknoteIcon, TriangleAlertIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/sonner";
import { api, ApiClientError } from "@/lib/api-client";
import { ConsentStatus, OrderStatus } from "@/lib/constants/enums";
import { PaymentGatewayLabel } from "@/lib/constants/labels";
import { formatCurrency, formatDateTime } from "@/lib/format";
import type { OrderDTO } from "@/types";

/**
 * Record a payment the operator took OUTSIDE PayOps.
 *
 * The card is charged on a physical terminal; this dialog records only the
 * confirmation. There is deliberately no field for a card number, CVV,
 * expiry or PIN, and there never should be — the only value captured is a
 * reference, which the server rejects if it looks like a PAN.
 *
 * Every rule shown here is ALSO enforced server-side (consent received, not
 * already paid, full amount, reference required, live session stood down).
 * The UI states them so the operator understands the refusal before it
 * happens; it does not implement them. Backend errors are surfaced verbatim
 * rather than pre-empted, so the console can never disagree with the truth.
 */
export function ManualPaymentDialog({ order }: { order: OrderDTO }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState("Card terminal");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");

  const consentReceived = order.consent?.status === ConsentStatus.RECEIVED;
  const alreadyPaid = order.status === OrderStatus.PAID;
  // A link the customer could still pay. `paymentUrl` is what they were
  // actually sent, and it survives a failure — which is exactly why this
  // warning matters.
  const hasLiveLink = Boolean(order.payment.paymentUrl);
  const failedAttempts = (order.payment.attempts ?? []).filter(
    (a) => a.status === OrderStatus.FAILED || a.supersededAt,
  );

  async function onSubmit() {
    setError(null);
    setSaving(true);
    try {
      await api.post(`/api/orders/${order.id}/manual-payment`, {
        method: method.trim(),
        reference: reference.trim(),
        notes: notes.trim() || undefined,
      });
      // Only after the backend confirms. Nothing above this line implies
      // the order is paid.
      toast.success("Manual payment recorded. Confirmation email sent.");
      setOpen(false);
      router.refresh();
    } catch (err) {
      // A validation failure carries the specific reason in
      // `details.issues`; `message` is the generic "Invalid request data".
      // Showing only the generic one turns the PAN rejection — the single
      // most important refusal in this dialog — into an unhelpful shrug.
      const message =
        err instanceof ApiClientError
          ? (firstIssueMessage(err.details) ?? err.message)
          : "Could not record the payment.";
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setError(null);
          setReference("");
          setNotes("");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <BanknoteIcon className="size-3.5" />
          Record manual payment
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record a manual payment</DialogTitle>
          <DialogDescription>
            For money collected outside PayOps — a card terminal, bank
            transfer or cash. Order {order.orderNumber} is settled in place.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Could not record the payment</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-4 text-[13px]">
          <div className="rounded-md border border-border bg-surface-1 px-3 py-2 space-y-1">
            <Row label="Order" value={order.orderNumber} mono />
            <Row label="Customer" value={order.customer.name} />
            <Row
              label="Amount to collect"
              value={formatCurrency(order.pricing.amount, order.pricing.currency)}
              strong
            />
            <Row label="Payment status" value={order.payment.status} />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Consent</span>
              <Badge variant={consentReceived ? "secondary" : "destructive"}>
                {order.consent?.status ?? "NOT_REQUESTED"}
              </Badge>
            </div>
          </div>

          {failedAttempts.length > 0 ? (
            <div className="rounded-md border border-border px-3 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Previous attempts
              </p>
              <ul className="mt-1 space-y-1">
                {failedAttempts.map((a, i) => (
                  <li key={`${a.sessionId ?? "x"}-${i}`} className="text-[12px]">
                    <span className="font-medium">
                      {PaymentGatewayLabel[a.gateway] ?? a.gateway}
                    </span>{" "}
                    <span className="text-muted-foreground">
                      {formatCurrency(a.amount, a.currency)} ·{" "}
                      {a.failureReason ?? a.supersededReason ?? a.status} ·{" "}
                      {formatDateTime(a.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* The operational model, stated where the operator is about to
              act on it. This is the single most important sentence here. */}
          <Alert>
            <TriangleAlertIcon className="size-4" />
            <AlertTitle>The card is charged outside PayOps</AlertTitle>
            <AlertDescription>
              Take the payment on your terminal first, then record the
              reference here. Never enter card details, CVV or a PIN into this
              system — there is no field for them and there never will be.
            </AlertDescription>
          </Alert>

          {!consentReceived ? (
            <Alert variant="destructive">
              <AlertTitle>Consent is not complete</AlertTitle>
              <AlertDescription>
                The customer must complete the consent form before a payment
                can be recorded. Send the consent request first.
              </AlertDescription>
            </Alert>
          ) : null}

          {hasLiveLink ? (
            <Alert variant="destructive">
              <TriangleAlertIcon className="size-4" />
              <AlertTitle>A payment link is still out with the customer</AlertTitle>
              <AlertDescription>
                Recording this will stand that link down so it cannot also be
                paid. If the customer pays it anyway, that payment is recorded
                and the order is flagged for you — it will not settle twice.
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-1">
            <label
              htmlFor="manual-method"
              className="text-[11px] font-medium text-muted-foreground"
            >
              How was it taken?
            </label>
            <Input
              id="manual-method"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              disabled={saving}
              placeholder="Card terminal"
            />
          </div>

          <div className="space-y-1">
            <label
              htmlFor="manual-reference"
              className="text-[11px] font-medium text-muted-foreground"
            >
              Payment reference <span className="text-destructive">*</span>
            </label>
            <Input
              id="manual-reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              disabled={saving}
              placeholder="AUTH-004521"
              autoComplete="off"
            />
            <p className="text-[11px] text-muted-foreground">
              The terminal authorisation code or transfer reference. A card
              number will be rejected.
            </p>
          </div>

          <div className="space-y-1">
            <label
              htmlFor="manual-notes"
              className="text-[11px] font-medium text-muted-foreground"
            >
              Notes (optional)
            </label>
            <Textarea
              id="manual-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              disabled={saving}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <LoadingButton
            onClick={onSubmit}
            loading={saving}
            loadingText="Recording"
            // Mirrors the server's rules so the operator is not invited to
            // fail. The server enforces them regardless.
            disabled={saving || !reference.trim() || !consentReceived || alreadyPaid}
          >
            Record payment
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The first field-level message from a validation error envelope. */
function firstIssueMessage(details: unknown): string | null {
  if (!details || typeof details !== "object") return null;
  const issues = (details as { issues?: unknown }).issues;
  if (!Array.isArray(issues) || issues.length === 0) return null;
  const first = issues[0];
  if (!first || typeof first !== "object") return null;
  const message = (first as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message : null;
}

function Row({
  label,
  value,
  mono = false,
  strong = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={[
          mono ? "font-mono text-[12px]" : "",
          strong ? "font-semibold tabular-nums" : "font-medium",
        ].join(" ")}
      >
        {value}
      </span>
    </div>
  );
}
