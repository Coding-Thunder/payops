import { z } from "zod";

import {
  BOOKING_TYPES,
  CURRENCIES,
  ORDER_STATUSES,
  PAYMENT_GATEWAY_KEYS,
  PAYMENT_TIMINGS,
  PaymentTiming,
  RECORD_STATES,
} from "@/lib/constants/enums";
import { PROVIDER_KEY_REGEX } from "@/lib/constants/providers";
import { defaultTimingForIndex } from "@/lib/charges";

import { CARD_DATA_MESSAGE, containsCardData } from "./card-data";

/**
 * An ISO 8601 date-time as the date pickers produce it.
 *
 * `Date.parse` alone is too forgiving to be the server's rule: it reads "1"
 * as the year 2001 and silently rolls 30 February into 2 March. The UI can
 * produce neither, so anything that does not start with a real calendar date
 * is refused rather than reinterpreted.
 */
const isoDateString = z
  .string()
  .min(1, "Date is required")
  .refine((v) => {
    // The whole string, not just its start: "2027-06-01 junk" used to pass
    // and was stored four days later. A time must carry its zone, or the
    // server's own time zone silently decides what it means.
    const m =
      /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(
        v,
      );
    if (!m) return false;
    const t = Date.parse(v);
    if (Number.isNaN(t)) return false;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    // The calendar part must exist as written (no rollover).
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (
      probe.getUTCFullYear() !== y ||
      probe.getUTCMonth() !== mo - 1 ||
      probe.getUTCDate() !== d
    ) {
      return false;
    }
    return y >= 2000 && y <= 2100;
  }, "Enter a valid date");

const phoneRegex = /^[+0-9()\-\s]{7,32}$/;

/** A phone number needs digits, not just separators. */
const hasEnoughDigits = (v: string) => (v.match(/\d/g) ?? []).length >= 7;

/** Names are printed in emails and on receipts: no control characters, and
 *  at least one visible letter or digit (a run of zero-width spaces is not a
 *  name). The zero-width non-joiner and joiner (U+200C, U+200D) are allowed:
 *  Persian and Indic names need them. */
const isPrintableName = (v: string) =>
  !/[\x00-\x1f\x7f\u200b\u2060\ufeff]/.test(v) &&
  /[\p{L}\p{N}]/u.test(v);

/** RFC 5321 caps a mailbox at 254 characters; the database enforces the same
 *  limit, so exceeding it must be a field error, not a 500. */
const EMAIL_MAX = 254;

/** Money is stored and charged to the cent. More precision than that used to
 *  be accepted and rounded line by line, so the lines a customer saw could
 *  add up to a cent more than the link charged. */
const hasAtMostTwoDecimals = (v: number) =>
  Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;

/** The smallest prepaid total a payment link can collect. The order model
 *  enforces the same floor; checking it here turns a 500 into a field error. */
const MIN_PREPAID_TOTAL = 0.5;

/**
 * Public URL of the vehicle photo.
 *
 * Defined once and shared by the create and edit paths rather than written
 * twice, because the two must agree on what "no image" means. The photo is
 * read LIVE from this field by the payment-request email, the hosted
 * checkout, the paid receipt and the dispute-evidence pack — so a definition
 * that drifted between the two paths would end up showing a customer a car
 * they never rented, with the correct make and model printed beside it.
 *
 * `.transform()` is the OUTERMOST link, so it runs even when the value is
 * absent and coerces `undefined` to `null`. Every object embedding this field
 * must therefore keep it inside a `.partial()`: without one, an edit that
 * sends a vehicle group and simply does not mention the image would WIPE the
 * photo rather than leave it alone.
 */
const vehicleImageUrl = z
  .string()
  .trim()
  .max(2048)
  // Treat empty/whitespace as "no image" — Zod's url validator would
  // otherwise reject "" and block the optional case.
  .refine((v) => v === "" || /^https?:\/\//i.test(v), {
    message: "Enter a valid http(s) image URL",
  })
  .optional()
  .nullable()
  .transform((v) => (v && v.length > 0 ? v : null));

/** A rental provider's catalog key. Shared so an order edit cannot accept a key
 *  shape that order creation would have refused. */
const providerKey = z
  .string()
  .trim()
  .toUpperCase()
  .regex(PROVIDER_KEY_REGEX, "Select a rental provider");

/** One line of the rental charge breakdown. `timing` is REQUIRED here: this
 *  is the canonical shape, used wherever a caller states every field
 *  explicitly (notably the edit path, which must never have a timing chosen
 *  for it by position — see `chargesCreateArraySchema`). */
export const chargeInputSchema = z.object({
  name: z.string().trim().min(1, "Charge name is required").max(120, "Keep the charge name to 120 characters or fewer"),
  amount: z
    .number({ error: "Enter a valid amount" })
    .positive("Amount must be greater than zero")
    .max(1_000_000, "Amount looks unrealistic")
    .refine(hasAtMostTwoDecimals, "Use at most 2 decimal places"),
  timing: z.enum(PAYMENT_TIMINGS),
});

export type ChargeInput = z.infer<typeof chargeInputSchema>;

/** At least one positive PREPAID line, or the payment link has nothing to
 *  collect. Shared so the create and edit paths enforce it identically. */
const hasPositivePrepaidLine = (
  lines: ReadonlyArray<{ timing: PaymentTiming; amount: number }>,
) => lines.some((l) => l.timing === PaymentTiming.PREPAID && l.amount > 0);

const PREPAID_REQUIRED_MESSAGE =
  "At least one prepaid charge is required to collect payment";

const prepaidTotalAtLeastMinimum = (
  lines: ReadonlyArray<{ timing: PaymentTiming; amount: number }>,
) => {
  const prepaid = lines
    .filter((l) => l.timing === PaymentTiming.PREPAID)
    .reduce((sum, l) => sum + l.amount, 0);
  // A total with no prepaid line is reported by the rule above instead.
  return prepaid <= 0 || prepaid + 1e-9 >= MIN_PREPAID_TOTAL;
};

const PREPAID_MINIMUM_MESSAGE =
  "The prepaid total must be at least 0.50 — payment links cannot collect less";

/** RFC 5321 caps the part before "@" at 64 characters. Mail servers refuse
 *  longer ones, so accepting it only produced a request nobody received. */
const localPartFits = (v: string) => {
  const at = v.lastIndexOf("@");
  return at > 0 && at <= 64;
};

/** Customer contact fields, shared by create, edit and the payment-request
 *  send, so no path can store what another would have refused. */
export const customerName = z
  .string()
  .trim()
  .min(2, "Customer name is required")
  .max(120, "Keep the name to 120 characters or fewer")
  .refine(isPrintableName, "Enter the customer's name");
export const customerEmail = z
  .string()
  .trim()
  .max(EMAIL_MAX, "Email address is too long")
  .email("Enter a valid email")
  .refine(localPartFits, "The part of the email before @ is too long")
  .toLowerCase();
export const customerPhone = z
  .string()
  .trim()
  .regex(phoneRegex, "Enter a valid phone number")
  .max(32, "Enter a valid phone number")
  .refine(hasEnoughDigits, "Enter a valid phone number");

/**
 * CREATE-path charge array: `timing` may be omitted and is then resolved by
 * position (first line PREPAID, later lines DUE_AT_COUNTER).
 *
 * The default is applied HERE, server-side, rather than only in React state,
 * so an API client, an importer or a replayed request gets the same answer
 * as the form. The transform runs BEFORE the refine so the prepaid check
 * sees resolved timings, not undefined ones.
 *
 * Deliberately NOT reused by the edit path: re-defaulting by position on an
 * edit would silently reclassify a line the operator had deliberately set,
 * simply because another line above it was removed.
 */
export const chargesCreateArraySchema = z
  .array(chargeInputSchema.extend({ timing: z.enum(PAYMENT_TIMINGS).optional() }))
  .min(1, "Add at least one charge")
  .max(20, "Too many charge lines")
  .transform((lines) =>
    lines.map((line, index) => ({
      ...line,
      timing: line.timing ?? defaultTimingForIndex(index),
    })),
  )
  .refine(hasPositivePrepaidLine, { message: PREPAID_REQUIRED_MESSAGE })
  .refine(prepaidTotalAtLeastMinimum, { message: PREPAID_MINIMUM_MESSAGE });

/** EDIT-path charge array: every line states its own timing. Same size and
 *  prepaid rules as create, no positional defaulting. */
export const chargesEditArraySchema = z
  .array(chargeInputSchema)
  .min(1, "Add at least one charge")
  .max(20, "Too many charge lines")
  .refine(hasPositivePrepaidLine, { message: PREPAID_REQUIRED_MESSAGE })
  .refine(prepaidTotalAtLeastMinimum, { message: PREPAID_MINIMUM_MESSAGE });

export const createOrderSchema = z
  .object({
    bookingType: z.enum(BOOKING_TYPES),
    provider: providerKey,
    customer: z.object({
      name: customerName,
      email: customerEmail,
      phone: customerPhone,
    }),
    vehicle: z.object({
      company: z
        .string()
        .trim()
        .min(2, "Car company is required")
        .max(80, "Keep the car make to 80 characters or fewer"),
      type: z.string().trim().min(2, "Car type is required").max(80, "Keep the car model to 80 characters or fewer"),
      imageUrl: vehicleImageUrl,
    }),
    trip: z
      .object({
        pickupDate: isoDateString,
        dropoffDate: isoDateString,
        pickupLocation: z
          .string()
          .trim()
          .min(2, "Pick-up location is required")
          .max(200, "Keep the location to 200 characters or fewer"),
        dropoffLocation: z
          .string()
          .trim()
          .min(2, "Drop-off location is required")
          .max(200, "Keep the location to 200 characters or fewer"),
      })
      .refine(
        (t) => new Date(t.pickupDate) < new Date(t.dropoffDate),
        {
          path: ["dropoffDate"],
          message: "Drop-off must be after pick-up",
        },
      ),
    currency: z.enum(CURRENCIES),
    /** Charge breakdown. Prepaid lines are charged online via the initial
     *  payment link; due-at-counter lines are shown but never charged. */
    charges: chargesCreateArraySchema,
    // Note: the Stripe ~$0.50 minimum on the PREPAID total is enforced
    // downstream (the order model's `pricing.amount` min:0.5 + the gateway's
    // own floor), not at the schema layer — the schema only guarantees a
    // positive prepaid line, mirroring how the single-amount schema deferred
    // the sub-50¢ floor to the model/Stripe boundary before.
    notes: z.string().trim().max(2000).optional(),
  });

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

/** Staff edit of the supplier confirmation number from the admin portal.
 *  Empty string clears it. */
export const confirmationNumberSchema = z.object({
  confirmationNumber: z
    .string()
    .trim()
    .max(64, "Confirmation number must be 64 characters or fewer"),
});

export type ConfirmationNumberInput = z.infer<typeof confirmationNumberSchema>;

export const listOrdersQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  bookingType: z.enum(BOOKING_TYPES).optional(),
  state: z.enum(RECORD_STATES).optional().default("ACTIVE"),
  mine: z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

export const archiveOrderSchema = z.object({
  reason: z.string().trim().min(2).max(500).optional(),
});

export type ArchiveOrderInput = z.infer<typeof archiveOrderSchema>;

const objectIdRegex = /^[a-f0-9]{24}$/i;

export const deleteByIdsSchema = z.object({
  ids: z
    .array(z.string().regex(objectIdRegex, "Invalid id"))
    .min(1, "Select at least one record")
    .max(100, "Too many records selected"),
});

export type DeleteByIdsInput = z.infer<typeof deleteByIdsSchema>;

export const analyticsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

/**
 * Re-price an existing order (change the MCO — the amount charged now).
 *
 * Reuses the EDIT array, which requires an explicit `timing` on every line.
 * It deliberately does not reuse the create array: that one resolves an
 * omitted timing by position, which on an edit would silently reclassify a
 * line the operator had deliberately set, just because a line above it was
 * removed.
 */
export const repriceOrderSchema = z.object({
  charges: chargesEditArraySchema,
  reason: z.string().trim().max(500).optional(),
});

export type RepriceOrderInput = z.infer<typeof repriceOrderSchema>;

/**
 * Order edit — a customer-requested change to an existing booking.
 *
 * Every group is optional: an operator changing only a phone number sends
 * only that. Each supplied group is validated with the SAME rules as order
 * creation, so a modification cannot put the order into a shape creation
 * would have rejected.
 *
 * `charges` is included because a booking change frequently re-prices the
 * rental (different vehicle, longer hire). When present it is routed through
 * the re-price path so the payment-session rules apply; when absent the
 * amount is left completely alone.
 *
 * Deliberately NOT editable here:
 *   - orderNumber — identity. An edit amends order #123; it never mints #124.
 *   - currency — `pricing.currency` is written exactly once, at creation, and
 *     supersession triggers on the AMOUNT alone. Switching GBP to USD at an
 *     unchanged number would therefore supersede nothing: the customer's live
 *     link would still collect GBP while every surface in the app said USD,
 *     and because the gateway idempotency key is keyed on the price revision,
 *     regenerating the link could not even mint a replacement session.
 *     Making currency editable means widening the supersession trigger, which
 *     is a payment-architecture change and belongs in its own piece of work.
 *   - anything under `payment` — settled financial fact.
 *
 * `provider` IS editable, and the previous note here calling it "a
 * merchant-account pin" was wrong. The rental provider is a BRANDING snapshot
 * (Budget, Hertz); the payment gateway and its credentials resolve from the
 * ORGANIZATION in `server/payments/resolve-gateway.ts` and never consult this
 * field. Changing it re-brands the customer's emails and checkout, which is
 * exactly what an operator needs when a booking moves supplier. The service
 * still refuses it on a PAID order, because by then the snapshot is dispute
 * evidence — a receipt has to show what the customer actually saw.
 *
 * Every object here is `strictObject`, so a field this flow does NOT support
 * is REJECTED rather than silently dropped. Zod strips unknown keys by
 * default, which meant a caller could post `currency` or `notes`, receive a
 * 200 and a success toast, and have nothing change.
 */
export const modifyOrderSchema = z
  .strictObject({
    /** Rental provider (branding). Re-snapshotted server-side from the
     *  catalog, so a disabled or unknown key is refused rather than pinned. */
    provider: providerKey.optional(),
    customer: z
      .strictObject({
        name: customerName,
        email: customerEmail,
        phone: customerPhone,
      })
      .partial()
      .optional(),
    vehicle: z
      .strictObject({
        company: z.string().trim().min(2, "Car company is required").max(80, "Keep the car make to 80 characters or fewer"),
        type: z.string().trim().min(2, "Car type is required").max(80, "Keep the car model to 80 characters or fewer"),
        // The car-library picker writes make, model and photo as one
        // selection, so the photo has to travel with them. Without it the
        // commonest edit of all — "give me a different car" — updates the
        // text and leaves the customer looking at the old vehicle.
        //
        // The `.partial()` below is load-bearing for this field: see the
        // note on `vehicleImageUrl`.
        imageUrl: vehicleImageUrl,
      })
      .partial()
      .optional(),
    trip: z
      .strictObject({
        pickupDate: isoDateString,
        dropoffDate: isoDateString,
        pickupLocation: z
          .string()
          .trim()
          .min(2, "Pick-up location is required")
          .max(200, "Keep the location to 200 characters or fewer"),
        dropoffLocation: z
          .string()
          .trim()
          .min(2, "Drop-off location is required")
          .max(200, "Keep the location to 200 characters or fewer"),
      })
      .partial()
      .optional(),
    /** Present only when the change also re-prices the booking. */
    charges: chargesEditArraySchema.optional(),
    /** What the customer asked for. Surfaces in the audit trail — which is
     *  exactly where card data must never land. */
    reason: z
      .string()
      .trim()
      .max(500)
      .refine((v) => !containsCardData(v), CARD_DATA_MESSAGE)
      .optional(),
    /**
     * Precondition, not an order field: the `updatedAt` of the order the
     * operator was looking at. When the order has changed since, the edit is
     * refused instead of silently writing values the operator never saw over
     * a colleague's change.
     */
    expectedUpdatedAt: z.string().datetime().optional(),
  })
  .refine(
    (v) =>
      Boolean(v.customer || v.vehicle || v.trip || v.charges || v.provider),
    { message: "No changes supplied" },
  );

export type ModifyOrderInput = z.infer<typeof modifyOrderSchema>;

/** Move an unpaid order to a different payment gateway (REQ-2). */
export const switchGatewaySchema = z.object({
  gateway: z.enum(PAYMENT_GATEWAY_KEYS),
});

export type SwitchGatewayInput = z.infer<typeof switchGatewaySchema>;

/**
 * A payment collected outside PayOps.
 *
 * PayOps must never hold card data, and every one of these three fields is
 * free text an operator types while looking at a terminal. All three are
 * checked (see `containsCardData`): the reference used to be the only one,
 * and only for a value made entirely of digits, so card numbers typed into
 * the method or notes — or into the reference alongside other words — were
 * stored, audited and exported.
 *
 * A real terminal reference such as `AUTH-004521` or `TXN 99887766` still
 * passes: blocking legitimate references would push operators toward leaving
 * the field blank.
 *
 * `strictObject`: the amount is never an input. A manual payment always
 * settles the full prepaid total, so an `amount` in the request is refused
 * rather than silently ignored.
 */
export const recordManualPaymentSchema = z.strictObject({
  /** How the money was taken. A label, never card data. */
  method: z
    .string()
    .trim()
    .min(2, "Describe how the payment was taken")
    .max(40, "Keep this to 40 characters — e.g. Card terminal")
    .refine((v) => !containsCardData(v), CARD_DATA_MESSAGE),
  reference: z
    .string()
    .trim()
    .min(3, "A payment reference is required")
    .max(120, "Keep the reference to 120 characters or fewer")
    .refine((v) => !containsCardData(v), CARD_DATA_MESSAGE),
  notes: z
    .string()
    .trim()
    .max(500)
    .refine((v) => !containsCardData(v), CARD_DATA_MESSAGE)
    .optional(),
  /** The operator has checked a payment already held on an earlier link
   *  (refunded it, or is recording it as this order's payment). Required
   *  while one is outstanding — see `outstandingHeldPayments`. */
  heldPaymentReviewed: z.boolean().optional(),
});

export type RecordManualPaymentInput = z.infer<typeof recordManualPaymentSchema>;
