"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { useUnsavedChangesGuard } from "@/components/common/unsaved-changes-guard";
import { hasCustomerConsent } from "@/lib/consent";
import { orderQueryKey } from "@/hooks/use-order-query";
import { api, ApiClientError } from "@/lib/api-client";
import { OrderStatus } from "@/lib/constants/enums";
import { formatCurrency } from "@/lib/format";
import type { CreateOrderInput } from "@/lib/validation";
import type { OrderDTO, ProviderDTO } from "@/types";

import { OrderForm, useOrderForm } from "./order-form";
import {
  CHANGED_FIELD_LABEL,
  diffOrder,
  orderToFormValues,
  touchesCheckoutDetails,
  type OrderFormValues,
} from "./order-form-model";

interface EditOrderFormProps {
  order: OrderDTO;
  providers: ProviderDTO[];
}

interface ModifyOrderResponse {
  order: OrderDTO;
  amountChanged: boolean;
  /** The customer's earlier confirmation no longer covers the new amount. */
  consentReset?: boolean;
  /** A live checkout page still shows the pre-edit details. */
  checkoutDetailsChanged?: boolean;
}

/**
 * Edit Order — the shared order form in edit mode.
 *
 * A customer-requested change amends THIS order. The only request this page
 * can make is `POST /api/orders/[id]/modify`; it has no path to
 * `POST /api/orders`, so it cannot mint a second order, and the order number
 * and id are never part of what it sends.
 *
 * Payment state stays the server's call. The page sends the breakdown only
 * when it differs, and the server alone decides whether that stands down a
 * live payment link — it does so when the prepaid total moves, and not
 * otherwise.
 */
export function EditOrderForm({ order, providers }: EditOrderFormProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  const [saved, setSaved] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [confirmReload, setConfirmReload] = React.useState(false);
  const savingRef = React.useRef(false);

  // The version of the order this form was filled from. Every comparison is
  // against THIS, never against `order`: the page re-renders with fresh data
  // when anything changes the order in the background, and comparing the
  // untouched form to the newer order used to report a colleague's changes as
  // edits to revert — and a Save then silently wrote the old values back.
  const [baseline, setBaseline] = React.useState(order);
  const initialValues = React.useMemo(() => orderToFormValues(baseline), [baseline]);
  const form = useOrderForm(initialValues);

  // What the order is NOW decides what may still be changed.
  const settled = order.status === OrderStatus.PAID;
  const hasLiveLink =
    Boolean(order.payment.paymentUrl) &&
    (order.status === OrderStatus.LINK_GENERATED ||
      order.status === OrderStatus.PAYMENT_PENDING);
  const changedElsewhere = !saved && order.updatedAt !== baseline.updatedAt;
  const emailHref = `/app/orders/${order.id}/email`;

  // Watching the whole form re-renders on each keystroke, which is what the
  // change summary and the Save button's state need.
  const values = form.watch() as OrderFormValues;
  const diff = diffOrder(values, baseline, reason, { settled });
  const dirty = !saved && (diff.changed.length > 0 || reason.trim().length > 0);
  const staleCheckoutWording =
    hasLiveLink && !diff.amountChanged && touchesCheckoutDetails(diff.changed);

  const guard = useUnsavedChangesGuard({ when: dirty, busy: saving });

  function loadLatest() {
    setBaseline(order);
    form.reset(orderToFormValues(order));
    setReason("");
    setServerError(null);
    setConfirmReload(false);
  }

  async function onSubmit(parsed: CreateOrderInput) {
    if (savingRef.current) return;
    // Diff the VALIDATED values: trimmed and normalised exactly as the
    // server will store them.
    const { payload, amountChanged } = diffOrder(parsed, baseline, reason, {
      settled,
    });
    if (!payload) {
      toast.info("Nothing to save — no details have changed.");
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setServerError(null);
    try {
      const result = await api.post<ModifyOrderResponse>(
        `/api/orders/${order.id}/modify`,
        // The server refuses the edit if the order moved since this form was
        // filled, rather than applying stale values over the newer ones.
        { ...payload, expectedUpdatedAt: baseline.updatedAt },
      );

      // The payment-request page reads this order through React Query, and
      // its cache outlives the navigation. Seed it with the saved order so
      // the first paint on return is already the new one — not the pre-edit
      // copy followed by a refetch — then mark it stale for a background
      // refresh of anything the modify response does not carry.
      queryClient.setQueryData(orderQueryKey(order.id), result.order);
      void queryClient.invalidateQueries({ queryKey: orderQueryKey(order.id) });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });

      setSaved(true);
      guard.release();
      toast.success(
        result.consentReset
          ? "Order updated. The customer must confirm the new amount — send them a new payment request."
          : (result.amountChanged ?? amountChanged)
            ? "Order updated. Generate a new payment link for the new amount."
            : result.checkoutDetailsChanged
              ? "Order updated. The customer's open payment link still shows the old details — generate a new link if they should see the change."
              : "Order updated.",
      );
      // Replace, so Back from the payment-request page does not return to a
      // form for a change that has already been made.
      router.replace(emailHref);
      router.refresh();
    } catch (err) {
      savingRef.current = false;
      setSaving(false);
      const message =
        err instanceof ApiClientError ? err.message : "Could not save the change.";
      setServerError(message);
      toast.error(message);
    }
  }

  const beforeActions = (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Change note</CardTitle>
          <CardDescription>
            Optional. Saved with this change in the order&apos;s audit trail.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <Label htmlFor="order-change-note">What the customer requested</Label>
          <Textarea
            id="order-change-note"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={500}
            disabled={saved}
            placeholder="e.g. Customer requested a later return date"
            aria-describedby="order-change-note-hint"
          />
          <p id="order-change-note-hint" className="text-xs text-muted-foreground">
            One or two sentences is enough. Never enter card details.
          </p>
        </CardContent>
      </Card>

      {diff.amountChanged ? (
        <Alert variant={hasLiveLink ? "destructive" : "default"}>
          <TriangleAlertIcon className="size-4" />
          <AlertTitle>
            {hasLiveLink
              ? "Saving will stand down the current payment link"
              : "The prepaid amount will change"}
          </AlertTitle>
          <AlertDescription>
            {hasLiveLink ? (
              <>
                The customer is holding a link for{" "}
                {formatCurrency(diff.previousPrepaid, order.pricing.currency)}.
                Saving invalidates it so it cannot collect the old amount.
                Generate a new link for{" "}
                {formatCurrency(diff.nextPrepaid, order.pricing.currency)} from
                the payment-request page.
                {hasCustomerConsent(order.consent?.status)
                  ? " The customer confirmed the old amount, so they will be asked to confirm again."
                  : null}
              </>
            ) : (
              <>
                From{" "}
                {formatCurrency(diff.previousPrepaid, order.pricing.currency)} to{" "}
                {formatCurrency(diff.nextPrepaid, order.pricing.currency)}. Any
                payment link generated after saving collects the new amount.
                {hasCustomerConsent(order.consent?.status)
                  ? " The customer confirmed the old amount, so they will be asked to confirm again."
                  : null}
              </>
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {staleCheckoutWording ? (
        <Alert>
          <TriangleAlertIcon className="size-4" />
          <AlertTitle>The open payment link keeps the old details</AlertTitle>
          <AlertDescription>
            The amount is unchanged, so the customer&apos;s current link stays
            valid — but its checkout page still shows the provider, car, dates
            and email it was created with. Generate a new link after saving if
            the customer should see the change.
          </AlertDescription>
        </Alert>
      ) : null}

      <div
        className="rounded-md border border-border bg-surface-1 px-4 py-3 text-sm"
        // Polite: a running count, read when the operator pauses rather than
        // interrupting every keystroke.
        aria-live="polite"
        aria-atomic="true"
      >
        {diff.changed.length === 0 ? (
          <p className="text-muted-foreground">
            No changes yet. This order ({order.orderNumber}) is updated in place
            — no new order is created.
          </p>
        ) : (
          <>
            <p className="font-medium">
              {diff.changed.length} change{diff.changed.length === 1 ? "" : "s"} to{" "}
              <span className="font-mono">{order.orderNumber}</span>
            </p>
            <p className="mt-1 text-muted-foreground">
              {diff.changed.map((f) => CHANGED_FIELD_LABEL[f]).join(" · ")}
            </p>
          </>
        )}
      </div>
    </>
  );

  return (
    <>
      {changedElsewhere ? (
        <Alert className="mb-6">
          <TriangleAlertIcon className="size-4" />
          <AlertTitle>This order was updated elsewhere</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              Someone changed this order after you opened it. Saving now would
              be refused so that their change is not overwritten. Load the
              latest version, then make your change again.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => (dirty ? setConfirmReload(true) : loadLatest())}
            >
              Load the latest version
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <ConfirmDialog
        open={confirmReload}
        onOpenChange={setConfirmReload}
        title="Discard your edits and load the latest version?"
        description="The changes you have typed on this page will be cleared."
        confirmLabel="Load latest"
        cancelLabel="Keep my edits"
        tone="warning"
        onConfirm={loadLatest}
      />
      <OrderForm
        mode="edit"
        form={form}
        order={order}
        settled={settled}
        providers={providers}
        serverError={serverError}
        serverErrorTitle="Could not save the change"
        onSubmit={onSubmit}
        onCancel={() => guard.requestLeave(emailHref)}
        submitLabel={
          diff.amountChanged && hasLiveLink ? "Save & invalidate link" : "Save changes"
        }
        submittingLabel="Saving"
        submitDisabled={diff.changed.length === 0}
        locked={saved}
        beforeActions={beforeActions}
      />
      {guard.dialog}
    </>
  );
}
