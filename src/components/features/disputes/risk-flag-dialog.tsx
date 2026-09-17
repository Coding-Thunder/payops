"use client";

import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ShieldAlertIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { api, ApiClientError } from "@/lib/api-client";
import { orderQueryKey } from "@/hooks/use-order-query";
import type { OrderDTO } from "@/types";

interface RiskFlagDialogProps {
  order: OrderDTO;
  /** Visible label override for the trigger button. */
  triggerLabel?: string;
  /** Render style of the trigger. */
  triggerVariant?: "default" | "outline" | "ghost";
}

/**
 * Toggle the dispute / at-risk flag on a single order. Doubles as both the
 * "flag" and "unflag" UX:
 *   - if currently unflagged → confirm + capture an optional note
 *   - if currently flagged   → confirm to remove the flag (destructive tone)
 */
export function RiskFlagDialog({
  order,
  triggerLabel,
  triggerVariant = "outline",
}: RiskFlagDialogProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [note, setNote] = useState(order.risk.flaggedNote ?? "");

  const isFlagged = order.risk.flagged;

  async function onConfirm() {
    try {
      await api.post(`/api/orders/${order.id}/risk`, {
        flagged: !isFlagged,
        note: isFlagged ? undefined : note.trim() || undefined,
      });
      toast.success(
        isFlagged
          ? `Removed risk flag from ${order.orderNumber}`
          : `Flagged ${order.orderNumber} for review`,
      );
      setOpen(false);
      // The trigger's label changes with the flag; keep focus on it.
      window.setTimeout(() => triggerRef.current?.focus(), 150);
      // The order page reads the order through React Query; without this the
      // held-payment alert stayed up after the flag was cleared.
      void queryClient.invalidateQueries({ queryKey: orderQueryKey(order.id) });
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof ApiClientError
          ? err.message
          : "Could not update the risk flag",
      );
    }
  }

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        size="sm"
        variant={triggerVariant}
        onClick={() => {
          setNote(order.risk.flaggedNote ?? "");
          setOpen(true);
        }}
      >
        <ShieldAlertIcon className="size-3.5" />
        {triggerLabel ?? (isFlagged ? "Unflag order" : "Flag for review")}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setNote(order.risk.flaggedNote ?? "");
        }}
        icon={<ShieldAlertIcon />}
        tone={isFlagged ? "default" : "warning"}
        title={
          isFlagged
            ? `Remove risk flag from ${order.orderNumber}?`
            : `Flag ${order.orderNumber} for review?`
        }
        description={
          isFlagged
            ? "The order will return to the regular orders list. The previous note is preserved in the audit log."
            : "The order will appear on the disputes page until it's resolved. Add a short note so the next operator understands why."
        }
        confirmLabel={isFlagged ? "Remove flag" : "Flag order"}
        onConfirm={onConfirm}
      >
        {isFlagged ? (
          order.risk.flaggedNote ? (
            // What the flag says, before it is cleared — for a held payment
            // this is the reason a refund may still be owed.
            <p className="whitespace-pre-line rounded-md border border-border bg-muted/40 p-2 text-[12px]">
              {order.risk.flaggedNote}
            </p>
          ) : null
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="risk-note">Note (optional)</Label>
            <Textarea
              id="risk-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Customer says they were double-charged, etc."
              maxLength={2000}
            />
          </div>
        )}
      </ConfirmDialog>
    </>
  );
}
