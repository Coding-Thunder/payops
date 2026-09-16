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

const isoDateString = z
  .string()
  .min(1, "Date is required")
  .refine((v) => !Number.isNaN(Date.parse(v)), "Enter a valid date");

const phoneRegex = /^[+0-9()\-\s]{7,32}$/;

/** One line of the rental charge breakdown. `timing` is REQUIRED here: this
 *  is the canonical shape, used wherever a caller states every field
 *  explicitly (notably the edit path, which must never have a timing chosen
 *  for it by position — see `chargesCreateArraySchema`). */
export const chargeInputSchema = z.object({
  name: z.string().trim().min(1, "Charge name is required").max(120),
  amount: z
    .number({ error: "Enter a valid amount" })
    .positive("Amount must be greater than zero")
    .max(1_000_000, "Amount looks unrealistic"),
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
  .refine(hasPositivePrepaidLine, { message: PREPAID_REQUIRED_MESSAGE });

/** EDIT-path charge array: every line states its own timing. Same size and
 *  prepaid rules as create, no positional defaulting. */
export const chargesEditArraySchema = z
  .array(chargeInputSchema)
  .min(1, "Add at least one charge")
  .max(20, "Too many charge lines")
  .refine(hasPositivePrepaidLine, { message: PREPAID_REQUIRED_MESSAGE });

export const createOrderSchema = z
  .object({
    bookingType: z.enum(BOOKING_TYPES),
    provider: z
      .string()
      .trim()
      .toUpperCase()
      .regex(PROVIDER_KEY_REGEX, "Select a rental provider"),
    customer: z.object({
      name: z.string().trim().min(2, "Customer name is required").max(120),
      email: z.string().email("Enter a valid email").toLowerCase(),
      phone: z
        .string()
        .trim()
        .regex(phoneRegex, "Enter a valid phone number")
        .max(32),
    }),
    vehicle: z.object({
      company: z
        .string()
        .trim()
        .min(2, "Car company is required")
        .max(80),
      type: z.string().trim().min(2, "Car type is required").max(80),
      imageUrl: z
        .string()
        .trim()
        .max(2048)
        // Treat empty/whitespace as "no image" — Zod's url validator
        // would otherwise reject "" and block the optional case.
        .refine((v) => v === "" || /^https?:\/\//i.test(v), {
          message: "Enter a valid http(s) image URL",
        })
        .optional()
        .nullable()
        .transform((v) => (v && v.length > 0 ? v : null)),
    }),
    trip: z
      .object({
        pickupDate: isoDateString,
        dropoffDate: isoDateString,
        pickupLocation: z
          .string()
          .trim()
          .min(2, "Pick-up location is required")
          .max(200),
        dropoffLocation: z
          .string()
          .trim()
          .min(2, "Drop-off location is required")
          .max(200),
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
 * Re-price an existing order (the "MCO amount" edit).
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
 * MCO — a customer-requested change to an existing booking.
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
 * Deliberately NOT editable here: orderNumber, provider, currency, and
 * anything under `payment`. Those are either identity, a merchant-account
 * pin, or settled financial fact.
 */
export const modifyOrderSchema = z
  .object({
    customer: z
      .object({
        name: z.string().trim().min(2, "Customer name is required").max(120),
        email: z.string().email("Enter a valid email").toLowerCase(),
        phone: z
          .string()
          .trim()
          .regex(phoneRegex, "Enter a valid phone number")
          .max(32),
      })
      .partial()
      .optional(),
    vehicle: z
      .object({
        company: z.string().trim().min(2, "Car company is required").max(80),
        type: z.string().trim().min(2, "Car type is required").max(80),
      })
      .partial()
      .optional(),
    trip: z
      .object({
        pickupDate: isoDateString,
        dropoffDate: isoDateString,
        pickupLocation: z
          .string()
          .trim()
          .min(2, "Pick-up location is required")
          .max(200),
        dropoffLocation: z
          .string()
          .trim()
          .min(2, "Drop-off location is required")
          .max(200),
      })
      .partial()
      .optional(),
    /** Present only when the change also re-prices the booking. */
    charges: chargesEditArraySchema.optional(),
    /** What the customer asked for. Surfaces in the audit trail. */
    reason: z.string().trim().max(500).optional(),
  })
  .refine(
    (v) => Boolean(v.customer || v.vehicle || v.trip || v.charges),
    { message: "No changes supplied" },
  );

export type ModifyOrderInput = z.infer<typeof modifyOrderSchema>;

/** Move an unpaid order to a different payment gateway (REQ-2). */
export const switchGatewaySchema = z.object({
  gateway: z.enum(PAYMENT_GATEWAY_KEYS),
});

export type SwitchGatewayInput = z.infer<typeof switchGatewaySchema>;

/**
 * Reference for a payment collected outside PayOps.
 *
 * The 13–19 digit rejection is a hard requirement, not a nicety: PayOps must
 * never hold a PAN, and the most likely way one arrives is an operator
 * pasting the card number into a free-text "reference" box. Separators are
 * stripped before counting so `4111 1111 1111 1111` and `4111-1111-1111-1111`
 * are caught too.
 *
 * It deliberately only rejects strings that are ALL digits once separators go
 * — a terminal auth code like `AUTH-004521` or `TXN 99887766` stays valid,
 * because blocking legitimate references would push operators toward leaving
 * the field blank.
 */
const looksLikeCardNumber = (value: string): boolean => {
  const digitsOnly = value.replace(/[\s-]/g, "");
  return /^\d{13,19}$/.test(digitsOnly);
};

export const recordManualPaymentSchema = z.object({
  /** How the money was taken. A label, never card data. */
  method: z
    .string()
    .trim()
    .min(2, "Describe how the payment was taken")
    .max(40),
  reference: z
    .string()
    .trim()
    .min(3, "A payment reference is required")
    .max(120)
    .refine((v) => !looksLikeCardNumber(v), {
      message:
        "That looks like a card number. Enter the terminal reference or authorisation code instead — never card details.",
    }),
  notes: z.string().trim().max(500).optional(),
});

export type RecordManualPaymentInput = z.infer<typeof recordManualPaymentSchema>;
