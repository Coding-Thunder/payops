"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BanknoteIcon, CheckCircle2Icon, TriangleAlertIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import {
  Dialog,
  DialogBody,
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
 * Kept deliberately short: an operator is on the phone, and what they need
 * is the amount, who it is for, that consent is in, and two fields. The
 * order's own page carries the payment history, so it is not repeated here;
 * only a payment that is HELD appears, because it changes what recording
 * this even means.
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
  const referenceRef = useRef<HTMLInputElement>(null);
  const firstHeldChoiceRef = useRef<HTMLInputElement>(null);

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

  // Every way of closing — Cancel, Escape, the X, a click outside —
  // leaves the next opening blank. Cancel used to skip this, so a reference
  // from an earlier call came back pre-filled.
  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setError(null);
      setReference("");
      setNotes("");
      setHeldChoice(null);
      setMethod("Card terminal");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <BanknoteIcon className="size-3.5" />
          Record manual payment
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[90dvh]"
        // Land where the operator types: the reference. Focusing the method
        // (the first field) selected "Card terminal", so the first thing
        // typed — the auth code — replaced it. With money held, the choice
        // of what is being recorded comes first.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (held.length > 0 ? firstHeldChoiceRef.current : referenceRef.current)?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Record manual payment</DialogTitle>
          <DialogDescription>
            For money collected outside PayOps — card terminal, bank transfer
            or cash.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-3 text-[13px]">
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Could not record the payment</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {/* Who and how much, in one glance. The amount is the fact the
              operator is confirming out loud on the call, so it carries the
              hierarchy. */}
          <div className="flex items-end justify-between gap-3 rounded-md border border-border bg-surface-1 px-3 py-2.5">
            <div className="min-w-0">
              <p className="truncate font-mono text-[12px] font-medium text-foreground">
                {order.orderNumber}
              </p>
              <p className="truncate text-[12.5px] text-muted-foreground">
                {order.customer.name}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                Amount to collect
              </p>
              <p className="text-[22px] font-semibold leading-tight tabular-nums text-foreground">
                {formatCurrency(order.pricing.amount, order.pricing.currency)}
              </p>
            </div>
          </div>

          {/* Consent, as one line when it is in — and as the blocker it is
              when it is not. */}
          {consentReceived ? (
            <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-success">
              <CheckCircle2Icon className="size-3.5 shrink-0" aria-hidden />
              Customer consent {String(order.consent?.status ?? "").toLowerCase()}
            </p>
          ) : takingNewPayment ? (
            <Alert variant="destructive">
              <AlertTitle>Consent is not complete</AlertTitle>
              <AlertDescription>
                The customer must complete the consent form before a payment
                can be recorded. Send the consent request first.
              </AlertDescription>
            </Alert>
          ) : acceptedHeld ? (
            <p className="text-[12.5px] text-muted-foreground">
              Recorded against the customer&apos;s earlier confirmation.
            </p>
          ) : (
            <p className="text-[12.5px] text-muted-foreground">
              Customer consent is not complete — a new payment would need it.
            </p>
          )}

          {/* Money is already sitting in a gateway: what this recording
              means depends entirely on what the operator says it is. */}
          {held.length > 0 ? (
            <Alert
              variant="destructive"
              className="text-[12.5px] text-red-800 dark:text-red-200"
            >
              <TriangleAlertIcon className="size-4" />
              <AlertTitle>
                {held.length > 1
                  ? "Payments were already received on earlier links"
                  : "A payment was already received on an earlier link"}
              </AlertTitle>
              <AlertDescription className="space-y-2">
                <ul className="space-y-0.5">
                  {held.map((a, i) => (
                    <li key={`${a.sessionId ?? "held"}-${i}`}>
                      {`${formatCurrency(a.amount, a.currency)} on ${PaymentGatewayLabel[a.gateway] ?? a.gateway} ${heldPaymentSource(a)} · ${formatDateTime(a.createdAt)}`}
                    </li>
                  ))}
                </ul>
                <p className="font-medium">
                  Do not take a new payment for money the customer has already
                  paid. Choose what you are recording:
                </p>
                <div
                  role="radiogroup"
                  aria-label="What are you recording?"
                  className="space-y-1.5 pt-0.5"
                >
                  {held.map((a, i) => (
                    <label
                      key={`choice-${a.sessionId ?? "held"}-${i}`}
                      className="flex items-start gap-2 font-medium"
                    >
                      <input
                        ref={i === 0 ? firstHeldChoiceRef : undefined}
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

          {/* The operational model, in one line, where the operator is about
              to act on it. Not shown when they are recording money already
              received — there is nothing to charge then. */}
          {takingNewPayment ? (
            <p className="flex gap-2 rounded-md border border-border bg-surface-1 px-3 py-2 text-[12px] text-muted-foreground">
              <TriangleAlertIcon
                className="mt-[1px] size-3.5 shrink-0 text-warning"
                aria-hidden
              />
              <span>
                <span className="font-medium text-foreground">
                  Payment is collected outside PayOps.
                </span>{" "}
                Never enter card numbers, CVV, PINs or other card data here.
              </span>
            </p>
          ) : acceptedHeld ? (
            <p className="rounded-md border border-border bg-surface-1 px-3 py-2 text-[12px] text-muted-foreground">
              <span className="font-medium text-foreground">
                Recording money already received.
              </span>{" "}
              Do not take a new payment — the method and reference below are
              filled in from{" "}
              {PaymentGatewayLabel[acceptedHeld.gateway] ?? acceptedHeld.gateway}.
            </p>
          ) : null}

          {hasLiveLink ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-red-800 dark:text-red-200">
              <span className="font-medium">
                A payment link is still out with the customer.
              </span>{" "}
              Recording this stands it down so it cannot also be paid.
            </p>
          ) : null}

          <div className="space-y-1">
            <label
              htmlFor="manual-method"
              className="text-[11px] font-medium text-muted-foreground"
            >
              Payment method
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
              ref={referenceRef}
              id="manual-reference"
              required
              aria-required="true"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              disabled={saving}
              placeholder="AUTH-004521"
              autoComplete="off"
              maxLength={120}
              aria-describedby="manual-reference-hint"
            />
            <p id="manual-reference-hint" className="text-[11px] text-muted-foreground">
              Terminal authorisation or transfer reference. A card number will
              be rejected.
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
        </DialogBody>

        <DialogFooter>
          <Button
            variant="ghost"
            className="h-9"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <LoadingButton
            className="h-9"
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
