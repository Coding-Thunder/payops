import type { z } from "zod";

import { PaymentTiming } from "@/lib/constants/enums";
import { summarizeCharges } from "@/lib/charges";
import type { createOrderSchema, modifyOrderSchema } from "@/lib/validation";
import type { OrderCharge, OrderDTO } from "@/types";

/**
 * The pure half of the order form: how an existing order becomes form
 * values, and how edited values become an MCO request.
 *
 * Kept free of React so the rules that decide what an edit SENDS can be
 * tested directly — those rules are what stand between an operator changing
 * a phone number and an unintended re-price.
 */

/** Raw field state, as the form holds it before validation. */
export type OrderFormValues = z.input<typeof createOrderSchema>;

/** Body of `POST /api/orders/[id]/modify`. */
export type ModifyOrderRequest = z.input<typeof modifyOrderSchema>;

/**
 * Pre-fill the create form's field set from a saved order.
 *
 * Every field `createOrderSchema` requires is present on the DTO, so edit
 * mode validates the same complete shape create does; only the request it
 * sends is partial.
 */
export function orderToFormValues(order: OrderDTO): OrderFormValues {
  const charges: OrderCharge[] =
    order.charges.length > 0
      ? order.charges
      : // `useFieldArray` must never start empty, and a legacy order's
        // single amount IS its prepaid line.
        [
          {
            name: "Rental cost",
            amount: order.pricing.amount,
            timing: PaymentTiming.PREPAID,
          },
        ];

  return {
    bookingType: order.bookingType,
    // The snapshot's `id` is the catalog key (`toSnapshot` writes key → id).
    provider: order.provider.id,
    customer: {
      name: order.customer.name,
      email: order.customer.email,
      phone: order.customer.phone,
    },
    vehicle: {
      company: order.vehicle.company,
      type: order.vehicle.type,
      imageUrl: order.vehicle.imageUrl ?? "",
    },
    trip: {
      // Already ISO strings on the DTO, which is what DateTimePicker takes.
      pickupDate: order.trip.pickupDate,
      dropoffDate: order.trip.dropoffDate,
      // Nullable on legacy orders. They become required the moment the
      // operator saves, which surfaces as an ordinary field error.
      pickupLocation: order.trip.pickupLocation ?? "",
      dropoffLocation: order.trip.dropoffLocation ?? "",
    },
    currency: order.pricing.currency,
    charges: charges.map((c) => ({
      name: c.name,
      amount: c.amount,
      timing: c.timing,
    })),
    notes: order.notes ?? "",
  };
}

export type ChangedField =
  | "provider"
  | "customer.name"
  | "customer.email"
  | "customer.phone"
  | "vehicle.company"
  | "vehicle.type"
  | "vehicle.imageUrl"
  | "trip.pickupDate"
  | "trip.dropoffDate"
  | "trip.pickupLocation"
  | "trip.dropoffLocation"
  | "charges";

export interface OrderDiff {
  /** What to POST, or null when nothing the MCO flow carries has moved. */
  payload: ModifyOrderRequest | null;
  /** Every field that differs from the saved order, in form order. */
  changed: ChangedField[];
  /** True when the prepaid total — the amount a payment link collects — moved. */
  amountChanged: boolean;
  previousPrepaid: number;
  nextPrepaid: number;
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const nullableText = (v: unknown) => text(v) || null;

/** Compare instants, not spellings: "…T10:00:00Z" and "…T10:00:00.000Z" are
 *  the same pick-up. An unparseable value is kept verbatim so it reads as a
 *  change and validation reports it. */
const instant = (v: unknown) => {
  const s = text(v);
  const t = Date.parse(s);
  return Number.isNaN(t) ? s : new Date(t).toISOString();
};

function chargeLines(
  lines: ReadonlyArray<{ name?: unknown; amount?: unknown; timing?: unknown }>,
) {
  return summarizeCharges(
    lines.map((l) => ({
      name: text(l.name),
      amount: typeof l.amount === "number" ? l.amount : Number(l.amount),
      timing:
        l.timing === PaymentTiming.DUE_AT_COUNTER
          ? PaymentTiming.DUE_AT_COUNTER
          : PaymentTiming.PREPAID,
    })),
  );
}

/**
 * Work out what an edit actually changes.
 *
 * Compares NORMALISED values — trimmed, lower-cased email, upper-cased
 * provider key, instants rather than strings — so the answer matches what the
 * server would store. RHF's own dirty tracking compares raw input and would
 * call a trailing space a change.
 *
 * The request is an ALLOW-LIST built field by field. The whole form value is
 * never spread into it: booking type, currency and internal notes are not
 * things this flow can change, and the server now rejects them outright.
 *
 * Charges are sent whole or not at all, because the server replaces the
 * array. They are sent whenever the breakdown differs, not only when the
 * total does — a renamed due-at-counter line is a real change.
 */
export function diffOrder(
  values: OrderFormValues,
  order: OrderDTO,
  reason = "",
  opts: { settled?: boolean } = {},
): OrderDiff {
  const changed: ChangedField[] = [];
  const payload: ModifyOrderRequest = {};
  // On a paid order the provider and the charges are settled and shown
  // read-only, so nothing the form still holds for them may be sent — an
  // unsaved amount edit from before the payment would otherwise make every
  // save fail and leave the operator unable to fix a phone number.
  const settled = Boolean(opts.settled);

  const nextProvider = text(values.provider).toUpperCase();
  if (!settled && nextProvider && nextProvider !== order.provider.id) {
    changed.push("provider");
    payload.provider = nextProvider;
  }

  const customer: NonNullable<ModifyOrderRequest["customer"]> = {};
  if (text(values.customer?.name) !== order.customer.name) {
    changed.push("customer.name");
    customer.name = text(values.customer?.name);
  }
  if (text(values.customer?.email).toLowerCase() !== order.customer.email) {
    changed.push("customer.email");
    customer.email = text(values.customer?.email).toLowerCase();
  }
  if (text(values.customer?.phone) !== order.customer.phone) {
    changed.push("customer.phone");
    customer.phone = text(values.customer?.phone);
  }
  if (Object.keys(customer).length) payload.customer = customer;

  const vehicle: NonNullable<ModifyOrderRequest["vehicle"]> = {};
  if (text(values.vehicle?.company) !== order.vehicle.company) {
    changed.push("vehicle.company");
    vehicle.company = text(values.vehicle?.company);
  }
  if (text(values.vehicle?.type) !== order.vehicle.type) {
    changed.push("vehicle.type");
    vehicle.type = text(values.vehicle?.type);
  }
  const nextImage = nullableText(values.vehicle?.imageUrl);
  if (nextImage !== nullableText(order.vehicle.imageUrl)) {
    changed.push("vehicle.imageUrl");
    // "" rather than null: the schema maps an empty value to "no photo",
    // and that is the one spelling both it and the form agree on.
    vehicle.imageUrl = nextImage ?? "";
  }
  if (Object.keys(vehicle).length) payload.vehicle = vehicle;

  const trip: NonNullable<ModifyOrderRequest["trip"]> = {};
  if (instant(values.trip?.pickupDate) !== instant(order.trip.pickupDate)) {
    changed.push("trip.pickupDate");
    trip.pickupDate = instant(values.trip?.pickupDate);
  }
  if (instant(values.trip?.dropoffDate) !== instant(order.trip.dropoffDate)) {
    changed.push("trip.dropoffDate");
    trip.dropoffDate = instant(values.trip?.dropoffDate);
  }
  if (text(values.trip?.pickupLocation) !== text(order.trip.pickupLocation)) {
    changed.push("trip.pickupLocation");
    trip.pickupLocation = text(values.trip?.pickupLocation);
  }
  if (text(values.trip?.dropoffLocation) !== text(order.trip.dropoffLocation)) {
    changed.push("trip.dropoffLocation");
    trip.dropoffLocation = text(values.trip?.dropoffLocation);
  }
  if (Object.keys(trip).length) payload.trip = trip;

  const before = summarizeCharges(order.charges, order.pricing.amount);
  const after = settled ? before : chargeLines(values.charges ?? []);
  if (JSON.stringify(before.charges) !== JSON.stringify(after.charges)) {
    changed.push("charges");
    payload.charges = after.charges;
  }

  const trimmedReason = reason.trim();
  if (changed.length && trimmedReason) payload.reason = trimmedReason;

  return {
    payload: changed.length ? payload : null,
    changed,
    amountChanged:
      changed.includes("charges") && after.prepaid !== order.pricing.amount,
    previousPrepaid: order.pricing.amount,
    nextPrepaid: after.prepaid,
  };
}

/** Operator-facing names for the change summary. */
/**
 * Fields a live checkout page was built from — the product name (provider,
 * vehicle), its description (trip dates and places) and the prefilled email.
 * Changing them leaves an open link showing the old wording.
 */
const CHECKOUT_SNAPSHOT_FIELDS: ReadonlySet<ChangedField> = new Set<ChangedField>([
  "provider",
  "customer.email",
  "vehicle.company",
  "vehicle.type",
  "trip.pickupDate",
  "trip.dropoffDate",
  "trip.pickupLocation",
  "trip.dropoffLocation",
]);

export function touchesCheckoutDetails(changed: readonly ChangedField[]): boolean {
  return changed.some((f) => CHECKOUT_SNAPSHOT_FIELDS.has(f));
}

export const CHANGED_FIELD_LABEL: Record<ChangedField, string> = {
  provider: "Rental provider",
  "customer.name": "Customer name",
  "customer.email": "Customer email",
  "customer.phone": "Customer phone",
  "vehicle.company": "Car make",
  "vehicle.type": "Car model",
  "vehicle.imageUrl": "Vehicle photo",
  "trip.pickupDate": "Pick-up date & time",
  "trip.dropoffDate": "Drop-off date & time",
  "trip.pickupLocation": "Pick-up location",
  "trip.dropoffLocation": "Drop-off location",
  charges: "Charge breakdown",
};
