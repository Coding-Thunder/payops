import { z } from "zod";

import {
  BOOKING_TYPES,
  CURRENCIES,
  ORDER_STATUSES,
  PAYMENT_TIMINGS,
  PaymentTiming,
  RECORD_STATES,
  CABIN_CLASSES,
  FLIGHT_TRIP_TYPES,
  FlightTripType,
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

/* ──────────────────────── service-typed creation ─────────────────────────
 *
 * `createOrderSchema` above is the CAR schema and is deliberately left
 * untouched — every rule, message and refinement a car order has ever been
 * validated by still lives there, and the car member of the union below is
 * literally that schema with a discriminant added. There is no second copy
 * to drift.
 */

/** Passenger counts. At least one adult; an infant cannot travel alone. */
const flightPassengersSchema = z.object({
  adults: z.coerce.number().int().min(1, "At least one adult").max(9),
  children: z.coerce.number().int().min(0).max(9),
  infants: z.coerce.number().int().min(0).max(9),
});

const flightDetailsSchema = z
  .object({
    tripType: z.enum(FLIGHT_TRIP_TYPES),
    airline: z.string().trim().max(80).optional().nullable(),
    flightNumber: z.string().trim().max(16).optional().nullable(),
    origin: z.string().trim().min(2, "Origin is required").max(120),
    destination: z.string().trim().min(2, "Destination is required").max(120),
    departureDate: isoDateString,
    departureTimePreference: z.string().trim().max(40).optional().nullable(),
    arrivalDate: isoDateString.optional().nullable(),
    returnDate: isoDateString.optional().nullable(),
    returnTimePreference: z.string().trim().max(40).optional().nullable(),
    cabinClass: z.enum(CABIN_CLASSES),
    passengers: flightPassengersSchema,
    passengerNotes: z.string().trim().max(2000).optional().nullable(),
    pnr: z.string().trim().max(32).optional().nullable(),
  })
  // A round trip without a return leg is the one combination the operator
  // can get wrong that the model would also reject — catch it at the form.
  .refine((f) => f.tripType !== FlightTripType.ROUND_TRIP || !!f.returnDate, {
    path: ["returnDate"],
    message: "A round trip needs a return date",
  })
  // Same-day returns are legitimate, so this is `<`, not `<=`.
  .refine(
    (f) => !f.returnDate || new Date(f.returnDate) >= new Date(f.departureDate),
    { path: ["returnDate"], message: "Return cannot be before departure" },
  )
  .refine(
    (f) =>
      !f.arrivalDate || new Date(f.arrivalDate) >= new Date(f.departureDate),
    { path: ["arrivalDate"], message: "Arrival cannot be before departure" },
  );

/** The car member: the existing schema, plus the discriminant. */
export const createCarOrderSchema = createOrderSchema.extend({
  serviceType: z.literal(ServiceType.CAR_RENTAL),
});

/**
 * The flight member. Reuses the shared customer / charges / currency rules
 * by picking them off the car schema, so those can never diverge, and
 * swaps the car-only `vehicle` + `trip` for `flight`.
 */
export const createFlightOrderSchema = createOrderSchema
  .omit({ vehicle: true, trip: true })
  .extend({
    serviceType: z.literal(ServiceType.FLIGHT),
    flight: flightDetailsSchema,
  });

/**
 * What POST /api/orders accepts.
 *
 * A discriminated union rather than one object with everything optional:
 * optional-everything would happily accept a flight with no route and a car
 * with no vehicle, and the first time anyone noticed would be a customer
 * receiving a payment link for a booking with no detail on it.
 *
 * The route defaults `serviceType` to CAR_RENTAL BEFORE parsing, so a client
 * that has never heard of service types — which is every existing caller —
 * keeps working unchanged.
 */
export const createOrderRequestSchema = z.discriminatedUnion("serviceType", [
  createCarOrderSchema,
  createFlightOrderSchema,
]);

export type CreateCarOrderInput = z.infer<typeof createCarOrderSchema>;
export type CreateFlightOrderInput = z.infer<typeof createFlightOrderSchema>;
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
