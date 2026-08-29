"use client";

import * as React from "react";
import { ShieldOffIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { useReleaseAuthorization } from "@/hooks/use-capture-payment";
import { ApiClientError } from "@/lib/api-client";
import { formatCurrency } from "@/lib/format";
import type { OrderDTO } from "@/types";

interface ReleaseAuthorizationDialogProps {
  order: OrderDTO;
}

/** Server-side cap on the operator note (`cancelBodySchema`). */
const REASON_MAX = 200;

/**
 * "Release authorization" — cancels the hold WITHOUT charging.
 *
 * The distinction that matters to an operator: this is not a refund. No
 * money has moved, so nothing is being returned; the bank's hold is simply
 * dropped and the customer's available balance frees up on the issuer's own
 * schedule. The copy says exactly that, because "cancel" reads to a lot of
 * people as "cancel the booking", which is a different field entirely
 * (`order.bookingStatus`).
 *
 * Only mounted for an order that actually has an authorization —
 * `order.payment.capture?.status` — so it is unreachable on the
 * automatic-capture brands regardless of which organization is selected.
 */
export function ReleaseAuthorizationDialog({
  order,
}: ReleaseAuthorizationDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const { run, isPending } = useReleaseAuthorization(order.id);

  const capture = order.payment.capture;
  const amount = capture?.amountAuthorized ?? order.pricing.amount;
  const held = formatCurrency(amount, order.pricing.currency);

  function onOpenChange(next: boolean) {
    if (isPending && !next) return;
    setOpen(next);
    if (!next) setReason("");
  }

  async function onConfirm() {
    try {
      await run({ reason: reason.trim() || null });
      toast.success("Authorization released — the customer was not charged");
      setOpen(false);
      setReason("");
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : "Could not release the authorization";
      toast.error(message);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <ShieldOffIcon className="size-3.5" />
        Release hold
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={onOpenChange}
        tone="destructive"
        icon={<ShieldOffIcon />}
        title="Release the authorization?"
        description={`The ${held} hold on ${order.customer.name}'s card is released and the customer is NOT charged. No money has moved, so this is not a refund. Releasing cannot be reversed — a new payment link would be needed to charge this order.`}
        confirmLabel="Release hold"
        cancelLabel="Keep hold"
        pending={isPending}
        onConfirm={onConfirm}
      >
        <div className="space-y-1.5">
          <Label htmlFor="release-reason">Reason (optional)</Label>
          <Textarea
            id="release-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX))}
            placeholder="Supplier could not confirm, duplicate booking, customer withdrew…"
            rows={3}
            maxLength={REASON_MAX}
            disabled={isPending}
          />
          <p className="text-right text-[11px] text-muted-foreground">
            {reason.length}/{REASON_MAX}
          </p>
        </div>
      </ConfirmDialog>
    </>
  );
}
