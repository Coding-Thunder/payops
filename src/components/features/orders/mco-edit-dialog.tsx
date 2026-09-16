"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { PencilIcon, TriangleAlertIcon } from "lucide-react";

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
import { DateTimePicker } from "@/components/common/date-time-picker";
import { toast } from "@/components/ui/sonner";
import { api, ApiClientError } from "@/lib/api-client";
import { formatCurrency } from "@/lib/format";
import { OrderStatus } from "@/lib/constants/enums";
import type { OrderDTO } from "@/types";

/**
 * MCO — the operator's workflow for a customer-requested booking change.
 *
 * Amends the order in place. There is deliberately no "new order" affordance
 * anywhere in this dialog, because the whole point of an MCO is that Order
 * #123 stays Order #123.
 *
 * Two things the operator must not be able to miss, so both are surfaced
 * before they can save:
 *   - the amount is only editable while the order is unpaid, and the field
 *     is disabled with an explanation once it is settled;
 *   - changing the amount stands down the payment link the customer is
 *     holding, which needs a fresh link afterwards.
 */
interface McoEditDialogProps {
  order: OrderDTO;
}

type FieldState = {
  name: string;
  email: string;
  phone: string;
  company: string;
  type: string;
  pickupDate: string;
  dropoffDate: string;
  pickupLocation: string;
  dropoffLocation: string;
  amount: string;
};

function initialState(order: OrderDTO): FieldState {
  return {
    name: order.customer.name,
    email: order.customer.email,
    phone: order.customer.phone,
    company: order.vehicle.company,
    type: order.vehicle.type,
    pickupDate: order.trip.pickupDate,
    dropoffDate: order.trip.dropoffDate,
    pickupLocation: order.trip.pickupLocation ?? "",
    dropoffLocation: order.trip.dropoffLocation ?? "",
    amount: String(order.pricing.amount),
  };
}

export function McoEditDialog({ order }: McoEditDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [values, setValues] = useState<FieldState>(() => initialState(order));

  const original = useMemo(() => initialState(order), [order]);
  const isPaid = order.status === OrderStatus.PAID;
  const hasLiveLink = Boolean(order.payment.paymentUrl);

  const set = (key: keyof FieldState) => (v: string) =>
    setValues((prev) => ({ ...prev, [key]: v }));

  /** Only what actually moved — the operator sees precisely this list. */
  const changed = useMemo(
    () =>
      (Object.keys(original) as Array<keyof FieldState>).filter(
        (k) => values[k] !== original[k],
      ),
    [values, original],
  );
  const amountChanged = changed.includes("amount");
  const nothingChanged = changed.length === 0;

  function reset() {
    setValues(initialState(order));
    setReason("");
    setError(null);
  }

  async function onSave() {
    setError(null);
    setSaving(true);
    try {
      const payload: Record<string, unknown> = { reason: reason.trim() || undefined };

      const customer: Record<string, string> = {};
      if (values.name !== original.name) customer.name = values.name.trim();
      if (values.email !== original.email) customer.email = values.email.trim();
      if (values.phone !== original.phone) customer.phone = values.phone.trim();
      if (Object.keys(customer).length) payload.customer = customer;

      const vehicle: Record<string, string> = {};
      if (values.company !== original.company) vehicle.company = values.company.trim();
      if (values.type !== original.type) vehicle.type = values.type.trim();
      if (Object.keys(vehicle).length) payload.vehicle = vehicle;

      const trip: Record<string, string> = {};
      if (values.pickupDate !== original.pickupDate) trip.pickupDate = values.pickupDate;
      if (values.dropoffDate !== original.dropoffDate) trip.dropoffDate = values.dropoffDate;
      if (values.pickupLocation !== original.pickupLocation)
        trip.pickupLocation = values.pickupLocation.trim();
      if (values.dropoffLocation !== original.dropoffLocation)
        trip.dropoffLocation = values.dropoffLocation.trim();
      if (Object.keys(trip).length) payload.trip = trip;

      if (amountChanged) {
        const next = Number(values.amount);
        if (!Number.isFinite(next) || next <= 0) {
          throw new Error("Enter a valid amount");
        }
        // The prepaid total IS the collectable amount. Counter lines are
        // carried through untouched so they are not silently dropped.
        const counterLines = (order.charges ?? []).filter(
          (c) => c.timing === "DUE_AT_COUNTER",
        );
        payload.charges = [
          { name: "Rental cost", amount: next, timing: "PREPAID" },
          ...counterLines.map((c) => ({
            name: c.name,
            amount: c.amount,
            timing: c.timing,
          })),
        ];
      }

      await api.post(`/api/orders/${order.id}/modify`, payload);
      toast.success(
        amountChanged
          ? "Order updated. Generate a new payment link for the new amount."
          : "Order updated.",
      );
      setOpen(false);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : "Could not save the change.";
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
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <PencilIcon className="size-3.5" />
          Edit order
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Customer-requested change</DialogTitle>
          <DialogDescription>
            Amends order {order.orderNumber} in place. No new order is created.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Could not save</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-4 text-[13px]">
          <Section title="Customer">
            <Field label="Name" value={values.name} onChange={set("name")} />
            <Field label="Email" value={values.email} onChange={set("email")} type="email" />
            <Field label="Phone" value={values.phone} onChange={set("phone")} />
          </Section>

          <Section title="Vehicle">
            <Field label="Company" value={values.company} onChange={set("company")} />
            <Field label="Type" value={values.type} onChange={set("type")} />
          </Section>

          <Section title="Trip">
            <div className="space-y-1">
              <label htmlFor="mco-pickup" className="text-[11px] font-medium text-muted-foreground">
                Pick-up
              </label>
              <DateTimePicker
                id="mco-pickup"
                value={values.pickupDate}
                onChange={set("pickupDate")}
                disabled={saving}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="mco-dropoff" className="text-[11px] font-medium text-muted-foreground">
                Drop-off
              </label>
              <DateTimePicker
                id="mco-dropoff"
                value={values.dropoffDate}
                onChange={set("dropoffDate")}
                disabled={saving}
              />
            </div>
            <Field
              label="Pick-up location"
              value={values.pickupLocation}
              onChange={set("pickupLocation")}
            />
            <Field
              label="Drop-off location"
              value={values.dropoffLocation}
              onChange={set("dropoffLocation")}
            />
          </Section>

          <Section title="Amount">
            <Field
              label={`Prepaid total (${order.pricing.currency})`}
              value={values.amount}
              onChange={set("amount")}
              disabled={isPaid}
            />
            {isPaid ? (
              <p className="text-[11.5px] text-muted-foreground">
                This order is paid. The amount is settled and can no longer be
                changed; other details remain editable.
              </p>
            ) : null}
          </Section>

          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              What did the customer ask for? (optional)
            </label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              disabled={saving}
              placeholder="Customer called to extend the return date"
            />
          </div>

          {changed.length > 0 ? (
            <div className="rounded-md border border-border bg-surface-1 px-3 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {changed.length} change{changed.length === 1 ? "" : "s"}
              </p>
              <ul className="mt-1 space-y-0.5">
                {changed.map((k) => (
                  <li key={k} className="text-[12px]">
                    <span className="text-muted-foreground">{k}:</span>{" "}
                    <span className="line-through opacity-60">
                      {original[k] || "—"}
                    </span>{" "}
                    → <span className="font-medium">{values[k] || "—"}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {amountChanged && hasLiveLink ? (
            <Alert variant="destructive">
              <TriangleAlertIcon className="size-4" />
              <AlertTitle>This will stand down the current payment link</AlertTitle>
              <AlertDescription>
                The customer is holding a link for{" "}
                {formatCurrency(order.pricing.amount, order.pricing.currency)}.
                Saving invalidates it so it cannot collect the old amount, and
                you will need to generate a new link.
              </AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <LoadingButton
            onClick={onSave}
            loading={saving}
            loadingText="Saving"
            disabled={nothingChanged}
          >
            {amountChanged ? "Save & invalidate link" : "Save change"}
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">{children}</div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  disabled?: boolean;
}) {
  // Derived from the label so the association is automatic and cannot drift
  // as fields are added. Without `htmlFor`/`id` the label is decoration: a
  // screen reader announces an unlabelled textbox, and clicking the text
  // does not focus the input.
  const id = `mco-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  return (
    <div className="space-y-1">
      <label
        htmlFor={id}
        className="text-[11px] font-medium text-muted-foreground"
      >
        {label}
      </label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
    </div>
  );
}
