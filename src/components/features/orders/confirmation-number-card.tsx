"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { LoadingButton } from "@/components/ui/loading-button";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { orderQueryKey } from "@/hooks/use-order-query";
import { api, ApiClientError } from "@/lib/api-client";
import { OrderStatus } from "@/lib/constants/enums";
import {
  bookingReference,
  bookingReferenceWording,
} from "@/lib/service-summary";
import type { OrderDTO } from "@/types";

interface ConfirmationNumberCardProps {
  order: OrderDTO;
}

/** The resend route answers with the refreshed order. */
interface ResendConfirmationResponse {
  order: OrderDTO;
  /** Null when SMTP isn't configured / the send was skipped. */
  emailId: string | null;
}

/**
 * Staff-editable supplier booking reference — ONE per order
 * (`order.confirmationNumber`): a rental's confirmation number, a flight's
 * PNR, a hotel's confirmation number, each named the way its service names
 * it (`bookingReferenceCopy` — a car reads exactly as it always has).
 * Agents paste the value the supplier returns once the booking is
 * confirmed; it surfaces at the top of the customer's confirmation email.
 * Saving never resends that email — only the explicit button does. Server
 * enforces order ownership.
 *
 * Both routes answer with the fresh order, which goes straight into the
 * order query cache the detail page renders from — the contract of
 * `use-capture-payment.ts` — so the card settles (hint, Save, Reset) with
 * no reload. `router.refresh()` would re-render the same client tree
 * against the same cache and change nothing.
 */
export function ConfirmationNumberCard({ order }: ConfirmationNumberCardProps) {
  const queryClient = useQueryClient();
  const copy = bookingReferenceWording(order);
  // The order's reference: a flight created before the PNR lived on the
  // order shows its legacy `flight.pnr`.
  const current = bookingReference(order) ?? "";
  const [value, setValue] = useState(current);
  // The stored value the field last followed. When the order changes under
  // the card — a save landing in the cache, or a poll bringing another
  // agent's edit — the field follows it, unless the agent is mid-edit.
  const [synced, setSynced] = useState(current);
  if (current !== synced) {
    setSynced(current);
    if (value.trim() === synced) setValue(current);
  }
  const [saving, setSaving] = useState(false);
  const [resending, setResending] = useState(false);

  const dirty = value.trim() !== current;
  const isPaid = order.status === OrderStatus.PAID;

  /** Writes the order the API answered with into the page's cache — first
   *  cancelling any refetch still in flight (a poll), whose older copy
   *  would otherwise land on top of it. */
  async function settle(next: OrderDTO) {
    const queryKey = orderQueryKey(order.id);
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData(queryKey, next);
  }

  /** Saves the field and settles on what the server stored. Returns the
   *  order it answered with. */
  async function saveReference(): Promise<OrderDTO> {
    const next = await api.post<OrderDTO>(
      `/api/orders/${order.id}/confirmation-number`,
      { confirmationNumber: value.trim() },
    );
    await settle(next);
    setValue(bookingReference(next) ?? "");
    return next;
  }

  async function resend() {
    setResending(true);
    try {
      // One-click: persist any unsaved edit first so the resent email carries
      // the reference the agent currently sees, then resend.
      if (dirty) await saveReference();
      const res = await api.post<ResendConfirmationResponse>(
        `/api/orders/${order.id}/resend-confirmation`,
        {},
      );
      if (res?.order) await settle(res.order);
      // `emailId` is null when SMTP isn't configured / the send was skipped —
      // surface that instead of a false "sent" success.
      if (res?.emailId) {
        toast.success("Confirmation email resent to the customer");
      } else {
        toast.error(
          "Saved, but the email was not sent — email delivery isn't configured. Check Admin → email/SMTP settings.",
        );
      }
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : "Could not resend the confirmation email";
      toast.error(message);
    } finally {
      setResending(false);
    }
  }

  async function save() {
    setSaving(true);
    // In the words the card showed when Save was pressed — an older flight
    // that also holds an airline PNR switches to the PNR's once its pasted
    // number is cleared.
    const wording = copy;
    try {
      const next = await saveReference();
      // What the server now holds for the field that was edited: cleared
      // means it is empty, even if a separate airline PNR is still shown.
      toast.success(next.confirmationNumber?.trim() ? wording.saved : wording.cleared);
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : `Could not save the ${copy.noun}`;
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{copy.label}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={copy.placeholder}
            maxLength={64}
            disabled={saving}
            className="font-mono"
          />
          <div className="flex gap-2">
            <LoadingButton
              size="sm"
              onClick={save}
              loading={saving}
              loadingText="Saving"
              disabled={!dirty}
            >
              Save
            </LoadingButton>
            {dirty ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setValue(current)}
                disabled={saving}
              >
                Reset
              </Button>
            ) : null}
          </div>
        </div>
        {!current ? (
          <p className="text-[11.5px] text-muted-foreground">{copy.notSet}</p>
        ) : null}

        {isPaid ? (
          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-[11.5px] text-muted-foreground">
              {`The confirmation email was sent automatically on payment. If you've added or changed the ${copy.noun} since, resend it so the customer receives the updated copy.`}
              {dirty
                ? " Resending will save your current change first."
                : ""}
            </p>
            <LoadingButton
              variant="outline"
              size="sm"
              onClick={resend}
              loading={resending}
              loadingText="Sending"
              disabled={saving}
            >
              {dirty ? "Save & resend confirmation email" : "Resend confirmation email"}
            </LoadingButton>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
