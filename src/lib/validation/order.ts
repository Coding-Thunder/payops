import { z } from "zod";

import { FLIGHT_SERVICE_CHARGE_LINE_NAME } from "@/lib/charges";
import {
  BOOKING_TYPES,
  CABIN_CLASSES,
  CURRENCIES,
  FLIGHT_TRIP_TYPES,
  FlightTripType,
  ORDER_STATUSES,
  PAYMENT_TIMINGS,
  PaymentTiming,
  RECORD_STATES,
  SERVICE_TYPES,
  ServiceType,
} from "@/lib/constants/enums";
import { PROVIDER_KEY_REGEX } from "@/lib/constants/providers";
import {
  isLocalDate,
  isLocalTime,
  itineraryIssues,
  MAX_LAYOVER_OVERRIDE_MINUTES,
  MAX_SEGMENTS_PER_JOURNEY,
} from "@/lib/flight-itinerary";

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

/** Airport-local wall-clock date and time — see `@/lib/flight-itinerary`
 *  for why these are strings rather than instants. */
const localDateInputSchema = z
  .string()
  .trim()
  .min(1, "Date is required")
  .refine(isLocalDate, "Enter a valid date");
const localTimeInputSchema = z
  .string()
  .trim()
  .min(1, "Time is required")
  .refine(isLocalTime, "Enter a valid time");

/** One flight: from, to, departure, arrival, carrier. */
export const flightSegmentInputSchema = z.object({
  // Two checks so a blank field says "required" and a one-letter entry
  // says what is actually wrong. `abort` stops a blank at the first, so it
  // reports exactly one message (to the form and to an API caller alike).
  origin: z
    .string()
    .trim()
    .min(1, { error: "From is required", abort: true })
    .min(2, "Enter at least 2 characters")
    .max(120),
  destination: z
    .string()
    .trim()
    .min(1, { error: "To is required", abort: true })
    .min(2, "Enter at least 2 characters")
    .max(120),
  departure: z.object({ date: localDateInputSchema, time: localTimeInputSchema }),
  arrival: z.object({ date: localDateInputSchema, time: localTimeInputSchema }),
  airline: z.string().trim().max(80).optional().nullable(),
  flightNumber: z.string().trim().max(16).optional().nullable(),
  details: z.string().trim().max(500).optional().nullable(),
});

/**
 * A layover on the connection between two adjacent flights. Its start and
 * end are NOT here — they are the previous flight's arrival and the next
 * flight's departure — so only what those cannot express is accepted.
 */
const flightLayoverInputSchema = z.object({
  location: z.string().trim().max(120).optional().nullable(),
  durationMinutesOverride: z
    .number({ error: "Enter a valid duration" })
    .int("Enter a whole number of minutes")
    .min(1, "Enter a duration of at least 1 minute")
    .max(MAX_LAYOVER_OVERRIDE_MINUTES, "A layover can't be longer than 7 days")
    .optional()
    .nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
});

const flightConnectionInputSchema = z.object({
  layover: flightLayoverInputSchema.optional().nullable(),
});

/**
 * One direction of travel: an ordered list of flights and the connections
 * between them. `connections` is normalised to exactly one entry per gap,
 * so connection `i` always means "between flight i+1 and flight i+2".
 */
export const flightJourneyInputSchema = z
  .object({
    segments: z
      .array(flightSegmentInputSchema)
      .min(1, "Add at least one flight")
      .max(
        MAX_SEGMENTS_PER_JOURNEY,
        `A journey can have at most ${MAX_SEGMENTS_PER_JOURNEY} flights`,
      ),
    connections: z
      .array(flightConnectionInputSchema)
      .max(MAX_SEGMENTS_PER_JOURNEY - 1)
      .optional()
      .nullable(),
  })
  .transform((journey) => ({
    segments: journey.segments,
    connections: journey.segments.slice(1).map((_, i) => ({
      layover: journey.connections?.[i]?.layover ?? null,
    })),
  }));

/**
 * A required amount that a form starts EMPTY (null): refused with `message`
 * until one is entered, so a forgotten field can never pass as 0.
 */
function requiredAmount(amount: z.ZodNumber, message: string) {
  return amount.nullable().transform((value, ctx) => {
    if (value === null) {
      ctx.addIssue({ code: "custom", message });
      return z.NEVER;
    }
    return value;
  });
}

const SERVICE_CHARGE_REQUIRED = "Enter the service charge";
const AIRLINE_CHARGE_REQUIRED = "Enter the airline charge (0 if there is none)";

/** A flight charge is always collected online, now. There is no
 *  due-at-counter for a flight — nothing is paid at an airport desk. Its
 *  name is not the caller's to choose (see below). */
const flightChargeInputSchema = chargeInputSchema.extend({
  name: z.string().trim().max(120).optional(),
  amount: requiredAmount(
    z
      .number({ error: SERVICE_CHARGE_REQUIRED })
      .positive("The service charge must be greater than zero")
      .max(1_000_000, "Amount looks unrealistic"),
    SERVICE_CHARGE_REQUIRED,
  ),
  timing: z.literal(PaymentTiming.PREPAID, {
    error: "Flight charges are always prepaid",
  }),
});

/**
 * A flight's charges: EXACTLY ONE line — the service charge, the only amount
 * the payment link collects. The airline charge has its own field
 * (`flight.airlineFare`) and is never a line, so a second line — the way an
 * airline charge could otherwise ride along into the gateway amount — is
 * refused rather than charged. Whatever the line was called, it is stored
 * as the service charge.
 */
const flightChargesInputSchema = z
  .array(flightChargeInputSchema)
  .min(1, SERVICE_CHARGE_REQUIRED)
  .max(
    1,
    "A flight has one charge: its service charge. Enter the airline charge in its own field — it is never collected through the payment link.",
  )
  .transform((lines) =>
    lines.map((line) => ({ ...line, name: FLIGHT_SERVICE_CHARGE_LINE_NAME })),
  );

/**
 * Flight booking.
 *
 * No airline or GDS integration is implied — this platform holds no
 * inventory. The operator enters the itinerary they sourced: every flight,
 * every connection, and the money split between the airline charge (never
 * collected here) and the service charge (the only thing the payment link
 * charges).
 *
 * Every business rule about the itinerary itself — chronology, connections,
 * round-trip ordering, multi-city size — lives in `itineraryIssues`, so the
 * form's live warnings and this schema can never disagree.
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
        tripType: z.enum(FLIGHT_TRIP_TYPES),
        /** The whole itinerary for ONE_WAY / MULTI_CITY; the outbound
         *  journey for ROUND_TRIP. */
        outbound: flightJourneyInputSchema,
        /** ROUND_TRIP only. Dropped for every other trip type. */
        return: flightJourneyInputSchema.optional().nullable(),
        cabinClass: z.enum(CABIN_CLASSES),
        passengers: flightPassengersSchema,
        passengerNotes: z.string().trim().max(2000).optional().nullable(),
        /** Airline record locator, entered once the booking is ticketed. */
        pnr: z.string().trim().max(32).optional().nullable(),
        /**
         * The AIRLINE CHARGE — the ticket cost. Its own field, required (0
         * when there is none) so every new flight states its booking value.
         * Shown to the customer as part of that value; NEVER sent to the
         * payment gateway, which charges only the service charge in
         * `charges`.
         */
        airlineFare: requiredAmount(
          z
            .number({ error: AIRLINE_CHARGE_REQUIRED })
            .min(0, "The airline charge can't be negative")
            .max(1_000_000, "Amount looks unrealistic"),
          AIRLINE_CHARGE_REQUIRED,
        ),
      })
      .superRefine((flight, ctx) => {
        for (const issue of itineraryIssues(flight)) {
          if (issue.severity !== "error") continue;
          ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
        }
      })
      .transform((flight) =>
        flight.tripType === FlightTripType.ROUND_TRIP
          ? { ...flight, return: flight.return ?? null }
          : { ...flight, return: null },
      ),
    currency: z.enum(CURRENCIES),
    /** The operator's service charge — the ONLY amount the payment link
     *  collects. Prepaid by definition, and the only line. */
    charges: flightChargesInputSchema,
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
        /** Catalog row the operator picked. Optional — a property that is
         *  not yet in the catalog can still be typed by hand. */
        hotelId: z
          .string()
          .regex(/^[a-f0-9]{24}$/i, "Invalid hotel id")
          .optional()
          .nullable(),
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
