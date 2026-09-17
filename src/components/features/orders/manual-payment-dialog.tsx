"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import { OrderStatus } from "@/lib/constants/enums";
import { hasCustomerConsent } from "@/lib/consent";
import { heldPaymentSource, outstandingHeldPayments } from "@/lib/payment-state";
import { orderQueryKey } from "@/hooks/use-order-query";
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
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState("Card terminal");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");

  const consentReceived = hasCustomerConsent(order.consent?.status);
  const alreadyPaid = order.status === OrderStatus.PAID;
  // A link the customer could still pay. `paymentUrl` is what they were
  // actually sent, and it survives a failure — which is exactly why this
  // warning matters.
  const hasLiveLink = Boolean(order.payment.paymentUrl);
  // Money already taken on a link the order no longer uses. Charging the
  // card as well would take it twice, so the operator confirms they have
  // dealt with it — the server refuses the recording otherwise.
  const held = outstandingHeldPayments(order);
  // While a payment is held the operator says exactly what they are doing:
  // recording ONE of the held payments as this order's payment (its index),
  // or recording a new payment after refunding what was held ("refunded").
  // Only that choice is reconciled; any other held payment stays flagged.
  const [heldChoice, setHeldChoice] = useState<number | "refunded" | null>(null);
  const acceptedHeld = typeof heldChoice === "number" ? held[heldChoice] : undefined;
  const takingNewPayment = held.length === 0 || heldChoice === "refunded";
  // Recording a held payment settles the order at its CURRENT amount, so only
  // a held payment for exactly that amount can be recorded as its payment.
  const matchesOrderAmount = (a: { amount: number }) =>
    Math.round(a.amount * 100) === Math.round(order.pricing.amount * 100);
  function chooseHeld(choice: number | "refunded") {
    setHeldChoice(choice);
    if (choice === "refunded") {
      setMethod("Card terminal");
      setReference("");
    } else {
      const a = held[choice];
      setMethod(`${PaymentGatewayLabel[a.gateway] ?? a.gateway} online payment`.slice(0, 40));
      setReference((a.paymentIntentId ?? a.sessionId ?? "").slice(0, 120));
    }
  }
  // One row per link: the history can record the same link twice (live,
  // then stood down), which read as two separate tries.
  const failedAttempts = Array.from(
    new Map(
      (order.payment.attempts ?? [])
        .filter((a) => !a.held && (a.status === OrderStatus.FAILED || a.supersededAt))
        .map((a, i) => [a.sessionId ?? `attempt-${i}`, a] as const),
    ).values(),
  );

  async function onSubmit() {
    // Three clicks in one event loop turn all got through before the
    // disabled state rendered, sending three recordings.
    if (savingRef.current) return;
    savingRef.current = true;
    setError(null);
    setSaving(true);
    try {
      const result = await api.post<{ order: OrderDTO }>(
        `/api/orders/${order.id}/manual-payment`,
        {
          method: method.trim(),
          reference: reference.trim(),
          notes: notes.trim() || undefined,
          ...(held.length > 0
            ? {
                heldPaymentReviewed: heldChoice !== null,
                ...(acceptedHeld
                  ? {
                      acceptHeldPayment: {
                        sessionId: acceptedHeld.sessionId ?? null,
                        paymentIntentId: acceptedHeld.paymentIntentId ?? null,
                      },
                    }
                  : {}),
              }
            : {}),
        },
      );
      // Only after the backend confirms. Nothing above this line implies
      // the order is paid.
      toast.success(
        "Manual payment recorded. The confirmation email is on its way to the customer.",
      );
      if (result?.order?.risk?.flagged && result.order.risk.flaggedNote !== order.risk.flaggedNote) {
        toast.warning("This order was flagged for review", {
          description: result.order.risk.flaggedNote ?? undefined,
        });
      }
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: orderQueryKey(order.id) });
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
      savingRef.current = false;
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
          setHeldChoice(null);
          setMethod("Card terminal");
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
            <Row
              label="Payment status"
              value={order.payment.status.toLowerCase().replace(/_/g, " ")}
            />
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
                      {a.failureReason ??
                        (a.supersededReason === "REPRICED"
                          ? "replaced after an amount change"
                          : a.supersededReason === "REGENERATED"
                            ? "replaced by a new link"
                            : a.supersededReason === "PAYMENT_HELD"
                              ? "stopped: a payment was already received"
                            : a.supersededReason
                              ? "replaced by another payment method"
                              : a.status.toLowerCase().replace(/_/g, " "))}{" "}
                      ·{" "}
                      {formatDateTime(a.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {held.length > 0 ? (
            <Alert variant="destructive" className="text-red-800 dark:text-red-200">
              <TriangleAlertIcon className="size-4" />
              <AlertTitle>
                The customer has already paid on an earlier link
              </AlertTitle>
              <AlertDescription className="space-y-2">
                <ul className="list-disc pl-5">
                  {held.map((a, i) => (
                    <li key={`${a.sessionId ?? "held"}-${i}`}>
                      {formatCurrency(a.amount, a.currency)} on{" "}
                      {PaymentGatewayLabel[a.gateway] ?? a.gateway}{" "}
                      {heldPaymentSource(a)} · {formatDateTime(a.createdAt)}
                    </li>
                  ))}
                </ul>
                <p>
                  Do not take a new payment for money the customer has already
                  paid. Choose what you are recording:
                </p>
                <div
                  role="radiogroup"
                  aria-label="What are you recording?"
                  className="space-y-1.5"
                >
                  {held.map((a, i) => (
                    <label
                      key={`choice-${a.sessionId ?? "held"}-${i}`}
                      className="flex items-start gap-2 font-medium"
                    >
                      <input
                        type="radio"
                        name="held-choice"
                        className="mt-0.5"
                        checked={heldChoice === i}
                        onChange={() => chooseHeld(i)}
                        disabled={saving || !matchesOrderAmount(a)}
                      />
                      <span className={matchesOrderAmount(a) ? undefined : "opacity-70"}>
                        {/* One string: the build drops the space before
                            "is" when this is written as wrapped JSX text. */}
                        {`The ${formatCurrency(a.amount, a.currency)} already received on ${PaymentGatewayLabel[a.gateway] ?? a.gateway} is this order's payment`}
                        {matchesOrderAmount(a)
                          ? held.length > 1
                            ? " (refund the other one in its gateway)"
                            : ""
                          : ` — not possible: the order is now ${formatCurrency(order.pricing.amount, order.pricing.currency)}, so refund it`}
                      </span>
                    </label>
                  ))}
                  <label className="flex items-start gap-2 font-medium">
                    <input
                      type="radio"
                      name="held-choice"
                      className="mt-0.5"
                      checked={heldChoice === "refunded"}
                      onChange={() => chooseHeld("refunded")}
                      disabled={saving}
                    />
                    <span>
                      {held.length > 1
                        ? "I refunded these payments and took a new payment"
                        : "I refunded that payment and took a new payment"}
                    </span>
                  </label>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}

          {/* The operational model, stated where the operator is about to
              act on it. This is the single most important sentence here.
              Not shown when the operator is recording money already
              received — there is nothing to charge then. */}
          {acceptedHeld ? (
            <Alert>
              <AlertTitle>Recording money already received</AlertTitle>
              <AlertDescription>
                Do not take a new payment. The method and reference below are
                filled in from{" "}
                {PaymentGatewayLabel[acceptedHeld.gateway] ?? acceptedHeld.gateway};
                check them and record.
              </AlertDescription>
            </Alert>
          ) : null}
          {takingNewPayment ? (
          <Alert>
            <TriangleAlertIcon className="size-4" />
            <AlertTitle>The card is charged outside PayOps</AlertTitle>
            <AlertDescription>
              Take the payment on your terminal first, then record the
              reference here. Never enter card details, CVV or a PIN into this
              system — there is no field for them and there never will be.
            </AlertDescription>
          </Alert>
          ) : null}

          {!consentReceived && takingNewPayment ? (
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
              maxLength={40}
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
              maxLength={120}
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
            // Recording a HELD payment is allowed on the customer's earlier
            // confirmation; the server checks that one exists.
            disabled={
              saving ||
              !reference.trim() ||
              alreadyPaid ||
              (held.length > 0 && heldChoice === null) ||
              (takingNewPayment && !consentReceived)
            }
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
