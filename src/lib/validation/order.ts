import { z } from "zod";

import {
  BOOKING_TYPES,
  CURRENCIES,
  ORDER_STATUSES,
  PAYMENT_TIMINGS,
  PaymentTiming,
  RECORD_STATES,
  SERVICE_TYPES,
  ServiceType,
} from "@/lib/constants/enums";
import { PROVIDER_KEY_REGEX } from "@/lib/constants/providers";

const isoDateString = z
  .string()
  .min(1, "Date is required")
  .refine((v) => !Number.isNaN(Date.parse(v)), "Enter a valid date");

const phoneRegex = /^[+0-9()\-\s]{7,32}$/;

/** One line of the rental charge breakdown. */
export const chargeInputSchema = z.object({
  name: z.string().trim().min(1, "Charge name is required").max(120),
  amount: z
    .number({ error: "Enter a valid amount" })
    .positive("Amount must be greater than zero")
    .max(1_000_000, "Amount looks unrealistic"),
  timing: z.enum(PAYMENT_TIMINGS),
});

export type ChargeInput = z.infer<typeof chargeInputSchema>;

/** Customer contact block. Identical across all three service types. */
const customerInputSchema = z.object({
  name: z.string().trim().min(2, "Customer name is required").max(120),
  email: z.string().email("Enter a valid email").toLowerCase(),
  phone: z
    .string()
    .trim()
    .regex(phoneRegex, "Enter a valid phone number")
    .max(32),
});

/** Charge lines. Identical across all three service types — the money side
 *  of an order does not vary by what is being sold. */
const chargesInputSchema = z
  .array(chargeInputSchema)
  .min(1, "Add at least one charge")
  .max(20, "Too many charge lines")
  .refine(
    (lines) =>
      lines.some((l) => l.timing === PaymentTiming.PREPAID && l.amount > 0),
    {
      message: "At least one prepaid charge is required to collect payment",
    },
  );

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
    charges: z
      .array(chargeInputSchema)
      .min(1, "Add at least one charge")
      .max(20, "Too many charge lines")
      .refine(
        (lines) =>
          lines.some((l) => l.timing === PaymentTiming.PREPAID && l.amount > 0),
        {
          message: "At least one prepaid charge is required to collect payment",
        },
      ),
    // Note: the Stripe ~$0.50 minimum on the PREPAID total is enforced
    // downstream (the order model's `pricing.amount` min:0.5 + the gateway's
    // own floor), not at the schema layer — the schema only guarantees a
    // positive prepaid line, mirroring how the single-amount schema deferred
    // the sub-50¢ floor to the model/Stripe boundary before.
    notes: z.string().trim().max(2000).optional(),
  });

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

/* ------------------------------------------------------------------ *
 * Multi-service order input.
 *
 * `createOrderSchema` above is LEFT EXACTLY AS IT WAS. The existing
 * car-rental form binds to it, `validation.test.ts` pins its behaviour, and
 * the safest possible change to a schema two production brands depend on is
 * no change at all. The car-rental union member is derived from it with
 * `.extend()`, so the two can never drift.
 * ------------------------------------------------------------------ */

/** Car rental — the incumbent shape, plus its discriminator. */
export const carRentalOrderSchema = createOrderSchema.extend({
  serviceType: z.literal(ServiceType.CAR_RENTAL),
});

const flightPassengersSchema = z
  .object({
    adults: z.coerce
      .number()
      .int()
      .min(1, "At least one adult is required")
      .max(9, "Contact us for groups over 9"),
    children: z.coerce.number().int().min(0).max(9).default(0),
    infants: z.coerce.number().int().min(0).max(9).default(0),
  })
  .refine((p) => p.infants <= p.adults, {
    path: ["infants"],
    message: "Each infant must travel with an adult",
  });

/**
 * Flight booking REQUEST.
 *
 * No airline or GDS integration is implied — this platform holds no
 * inventory. The fields are what an operator needs to source a fare by
 * hand and quote it back.
 */
export const flightOrderSchema = z
  .object({
    serviceType: z.literal(ServiceType.FLIGHT),
    bookingType: z.enum(BOOKING_TYPES),
    provider: z
      .string()
      .trim()
      .toUpperCase()
      .regex(PROVIDER_KEY_REGEX, "Select an airline or travel supplier"),
    customer: customerInputSchema,
    flight: z
      .object({
        tripType: z.enum(["ONE_WAY", "ROUND_TRIP"]),
        airline: z.string().trim().max(80).optional().nullable(),
        flightNumber: z.string().trim().max(16).optional().nullable(),
        origin: z.string().trim().min(2, "Origin is required").max(120),
        destination: z
          .string()
          .trim()
          .min(2, "Destination is required")
          .max(120),
        departureDate: isoDateString,
        departureTimePreference: z.string().trim().max(40).optional().nullable(),
        returnDate: z.string().optional().nullable(),
        returnTimePreference: z.string().trim().max(40).optional().nullable(),
        cabinClass: z.enum([
          "ECONOMY",
          "PREMIUM_ECONOMY",
          "BUSINESS",
          "FIRST",
        ]),
        passengers: flightPassengersSchema,
        passengerNotes: z.string().trim().max(2000).optional().nullable(),
      })
      .refine(
        (f) =>
          f.tripType !== "ROUND_TRIP" ||
          (typeof f.returnDate === "string" && f.returnDate.length > 0),
        {
          path: ["returnDate"],
          message: "Return date is required for a round trip",
        },
      )
      .refine(
        (f) =>
          f.tripType !== "ROUND_TRIP" ||
          !f.returnDate ||
          new Date(f.returnDate) >= new Date(f.departureDate),
        {
          path: ["returnDate"],
          message: "Return must be on or after departure",
        },
      )
      .refine(
        (f) =>
          f.origin.trim().toUpperCase() !== f.destination.trim().toUpperCase(),
        {
          path: ["destination"],
          message: "Destination must differ from origin",
        },
      ),
    currency: z.enum(CURRENCIES),
    charges: chargesInputSchema,
    notes: z.string().trim().max(2000).optional(),
  });

export type FlightOrderInput = z.infer<typeof flightOrderSchema>;

/** Hotel booking REQUEST. No hotel inventory API is implied. */
export const hotelOrderSchema = z
  .object({
    serviceType: z.literal(ServiceType.HOTEL),
    bookingType: z.enum(BOOKING_TYPES),
    provider: z
      .string()
      .trim()
      .toUpperCase()
      .regex(PROVIDER_KEY_REGEX, "Select a hotel group or travel supplier"),
    customer: customerInputSchema,
    hotel: z
      .object({
        destination: z
          .string()
          .trim()
          .min(2, "Destination is required")
          .max(120),
        propertyName: z.string().trim().max(160).optional().nullable(),
        checkInDate: isoDateString,
        checkOutDate: isoDateString,
        rooms: z.coerce
          .number()
          .int()
          .min(1, "At least one room is required")
          .max(20),
        guests: z.object({
          adults: z.coerce
            .number()
            .int()
            .min(1, "At least one adult is required")
            .max(20),
          children: z.coerce.number().int().min(0).max(20).default(0),
        }),
        roomPreference: z.string().trim().max(200).optional().nullable(),
        guestNotes: z.string().trim().max(2000).optional().nullable(),
      })
      // The hotel equivalent of the rental "drop-off after pick-up" rule.
      .refine(
        (h) => new Date(h.checkOutDate) > new Date(h.checkInDate),
        {
          path: ["checkOutDate"],
          message: "Check-out must be after check-in",
        },
      ),
    currency: z.enum(CURRENCIES),
    charges: chargesInputSchema,
    notes: z.string().trim().max(2000).optional(),
  });

export type HotelOrderInput = z.infer<typeof hotelOrderSchema>;

/**
 * The API-level entry point. A discriminated union on `serviceType`, so a
 * flight payload is validated by flight rules and a rental payload by the
 * unchanged rental rules — service-specific validation with no shared
 * "optional everything" object that would let a half-filled order through.
 *
 * Callers that predate `serviceType` are handled at the route by injecting
 * the CAR_RENTAL default before parsing, so an old client keeps working.
 */
export const createOrderRequestSchema = z.discriminatedUnion("serviceType", [
  carRentalOrderSchema,
  flightOrderSchema,
  hotelOrderSchema,
]);

export type CreateOrderRequestInput = z.infer<typeof createOrderRequestSchema>;

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
  serviceType: z.enum(SERVICE_TYPES).optional(),
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
