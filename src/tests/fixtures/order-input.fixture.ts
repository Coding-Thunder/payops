import {
  BookingType,
  CabinClass,
  Currency,
  FlightTripType,
  PaymentTiming,
  ServiceType,
} from "@/lib/constants/enums";
import { ProviderId } from "@/lib/constants/providers";
import type {
  CreateOrderInput,
  FlightOrderInput,
  HotelOrderInput,
} from "@/lib/validation";

/**
 * Canonical valid CreateOrderInput. Each fixture returns a fresh object so
 * tests can mutate it without bleeding state. Use as the baseline for
 * "happy path" tests, then `{ ...validCreateOrderInput(), charges: ... }`
 * to assert a single field's behaviour.
 */
export function validCreateOrderInput(
  overrides: Partial<CreateOrderInput> = {},
): CreateOrderInput {
  const pickup = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const dropoff = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  return {
    bookingType: BookingType.NEW_BOOKING,
    provider: ProviderId.BUDGET,
    customer: {
      name: "Ada Lovelace",
      email: "ada@payops.test",
      phone: "+15555550100",
    },
    vehicle: {
      company: "Toyota",
      type: "Camry",
    },
    trip: {
      pickupDate: pickup,
      dropoffDate: dropoff,
      pickupLocation: "LAX Airport — Terminal 1",
      dropoffLocation: "San Diego Downtown",
    },
    currency: Currency.USD,
    charges: [
      { name: "Rental cost", amount: 249.99, timing: PaymentTiming.PREPAID },
    ],
    notes: "Test booking notes.",
    ...overrides,
  } as CreateOrderInput;
}

/** Input that should fail validation: pickup after dropoff. */
export function invalidTripDatesInput(): CreateOrderInput {
  const later = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const earlier = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return validCreateOrderInput({
    trip: {
      pickupDate: later,
      dropoffDate: earlier,
      pickupLocation: "LAX Airport — Terminal 1",
      dropoffLocation: "San Diego Downtown",
    },
  });
}

/** Input with a sub-cent prepaid total that Stripe would reject. */
export function belowMinimumAmountInput(): CreateOrderInput {
  return validCreateOrderInput({
    charges: [
      { name: "Rental cost", amount: 0.4, timing: PaymentTiming.PREPAID },
    ],
  });
}

/* ------------------------------------------------------------------ *
 * Multi-service inputs.
 *
 * `validCreateOrderInput` above is LEFT EXACTLY AS IT WAS — thirteen test
 * files bind to its shape. These two are additive siblings that satisfy
 * `flightOrderSchema` / `hotelOrderSchema` respectively, so a test can hand
 * either straight to `createOrderRequestSchema` or to the service.
 *
 * They keep `ProviderId.BUDGET` as the provider on purpose: it is a SEEDED
 * key, and `buildProviderSnapshotFromKey` rejects any key the providers
 * collection does not hold. A test that wants an airline or a hotel group
 * seeds one and passes it through `overrides`.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * FLIGHT itineraries.
 *
 * A flight is journeys of segments joined by connections (see
 * `@/lib/flight-itinerary`). Times are AIRPORT-LOCAL wall-clock strings, so
 * every date below is a fixed calendar day rather than "now + n days": the
 * strings are what every surface prints ("Sat, Oct 10, 2026", "10:30 AM"),
 * and a test can assert them exactly. Nothing validates that a flight is in
 * the future.
 *
 * Every journey is written already normalised — exactly one connection per
 * gap, `return` present (null unless ROUND_TRIP), `airlineFare` explicit —
 * so the same object is valid INPUT for `flightOrderSchema` and a valid
 * PARSED value for `createOrder`, which tests call directly.
 * ------------------------------------------------------------------ */

type FlightInput = FlightOrderInput["flight"];
type FlightJourneyInput = FlightInput["outbound"];
export type FlightSegmentInput = FlightJourneyInput["segments"][number];
export type FlightConnectionInput = FlightJourneyInput["connections"][number];

/** One flight. `departure` / `arrival` are `[date, time]` at each airport. */
export function flightSegmentInput(
  origin: string,
  destination: string,
  departure: [date: string, time: string],
  arrival: [date: string, time: string],
  extra: Partial<FlightSegmentInput> = {},
): FlightSegmentInput {
  return {
    origin,
    destination,
    departure: { date: departure[0], time: departure[1] },
    arrival: { date: arrival[0], time: arrival[1] },
    airline: null,
    flightNumber: null,
    details: null,
    ...extra,
  };
}

/** A journey with exactly `segments.length - 1` connections — the given
 *  ones first, the rest "no layover recorded". */
export function flightJourneyInput(
  segments: FlightSegmentInput[],
  connections: FlightConnectionInput[] = [],
): FlightJourneyInput {
  return {
    segments,
    connections: segments
      .slice(1)
      .map((_, i) => connections[i] ?? { layover: null }),
  };
}

/** The service charge as a single PREPAID line — the only shape a new
 *  flight's charges take. */
export function flightServiceCharge(
  amount: number,
  name = "Service charge",
): FlightOrderInput["charges"] {
  return [{ name, amount, timing: PaymentTiming.PREPAID }];
}

/**
 * Named flights, fresh objects on every call. Varanasi is the connection
 * point in both directions: outbound lands 12:00 and departs 14:30 (a
 * 2h 30m layover); the return lands 11:00 and departs 13:15 (2h 15m
 * calculated).
 */
export const FLIGHT_SEGMENTS = {
  londonNewYork: () =>
    flightSegmentInput("LHR", "JFK", ["2026-11-01", "09:15"], ["2026-11-01", "12:20"], {
      airline: "Test Airways",
      flightNumber: "TA123",
    }),
  delhiVaranasi: () =>
    flightSegmentInput("Delhi", "Varanasi", ["2026-10-10", "10:30"], ["2026-10-10", "12:00"], {
      airline: "Air India",
      flightNumber: "AI123",
    }),
  varanasiMumbai: () =>
    flightSegmentInput("Varanasi", "Mumbai", ["2026-10-10", "14:30"], ["2026-10-10", "16:30"], {
      airline: "IndiGo",
      flightNumber: "6E456",
    }),
  mumbaiVaranasi: () =>
    flightSegmentInput("Mumbai", "Varanasi", ["2026-10-15", "09:00"], ["2026-10-15", "11:00"], {
      airline: "IndiGo",
      flightNumber: "6E789",
    }),
  varanasiDelhi: () =>
    flightSegmentInput("Varanasi", "Delhi", ["2026-10-15", "13:15"], ["2026-10-15", "14:45"], {
      airline: "Air India",
      flightNumber: "AI124",
    }),
  mumbaiGoa: () =>
    flightSegmentInput("Mumbai", "Goa", ["2026-10-14", "19:45"], ["2026-10-14", "21:00"]),
};

/**
 * Canonical valid FLIGHT booking: a DIRECT one-way, airline fare $400 plus a
 * $100 service charge. `flight` merges over the default flight block, so a
 * test changes one itinerary field without restating the rest.
 */
export function validFlightOrderInput(
  overrides: Partial<FlightOrderInput> = {},
  flight: Partial<FlightInput> = {},
): FlightOrderInput {
  return {
    serviceType: ServiceType.FLIGHT,
    bookingType: BookingType.NEW_BOOKING,
    provider: ProviderId.BUDGET,
    customer: {
      name: "Grace Hopper",
      email: "grace@payops.test",
      phone: "+15555550101",
    },
    flight: {
      tripType: FlightTripType.ONE_WAY,
      outbound: flightJourneyInput([FLIGHT_SEGMENTS.londonNewYork()]),
      return: null,
      cabinClass: CabinClass.ECONOMY,
      passengers: { adults: 1, children: 0, infants: 0 },
      passengerNotes: null,
      pnr: null,
      airlineFare: 400,
      ...flight,
    },
    currency: Currency.USD,
    charges: flightServiceCharge(100),
    notes: "Test flight booking notes.",
    ...overrides,
  };
}

/** One way, CONNECTING: Delhi → Varanasi → Mumbai with a recorded layover
 *  at Varanasi (calculated 2h 30m, no override). */
export function oneWayConnectingFlightInput(
  overrides: Partial<FlightOrderInput> = {},
  flight: Partial<FlightInput> = {},
): FlightOrderInput {
  return validFlightOrderInput(overrides, {
    tripType: FlightTripType.ONE_WAY,
    outbound: flightJourneyInput(
      [FLIGHT_SEGMENTS.delhiVaranasi(), FLIGHT_SEGMENTS.varanasiMumbai()],
      [
        {
          layover: {
            location: null,
            durationMinutesOverride: null,
            notes: "Change terminals",
          },
        },
      ],
    ),
    ...flight,
  });
}

/**
 * ROUND TRIP with two INDEPENDENT journeys, a layover in each direction:
 * outbound Delhi → Varanasi → Mumbai (2h 30m at Varanasi, calculated) and
 * return Mumbai → Varanasi → Delhi (calculated 2h 15m, overridden to 2h).
 * Airline fare $1,240 plus a $95 service charge.
 */
export function roundTripFlightInput(
  overrides: Partial<FlightOrderInput> = {},
  flight: Partial<FlightInput> = {},
): FlightOrderInput {
  return validFlightOrderInput(
    { charges: flightServiceCharge(95), ...overrides },
    {
      tripType: FlightTripType.ROUND_TRIP,
      outbound: flightJourneyInput(
        [FLIGHT_SEGMENTS.delhiVaranasi(), FLIGHT_SEGMENTS.varanasiMumbai()],
        [
          {
            layover: {
              location: null,
              durationMinutesOverride: null,
              notes: "Change terminals",
            },
          },
        ],
      ),
      return: flightJourneyInput(
        [FLIGHT_SEGMENTS.mumbaiVaranasi(), FLIGHT_SEGMENTS.varanasiDelhi()],
        [
          {
            layover: {
              location: null,
              durationMinutesOverride: 120,
              notes: "Lounge access included",
            },
          },
        ],
      ),
      cabinClass: CabinClass.BUSINESS,
      passengers: { adults: 2, children: 1, infants: 0 },
      pnr: "ABC123",
      airlineFare: 1240,
      ...flight,
    },
  );
}

/** MULTI-CITY: Delhi → Varanasi → Mumbai → Goa, three flights on three
 *  days, no layovers recorded. */
export function multiCityFlightInput(
  overrides: Partial<FlightOrderInput> = {},
  flight: Partial<FlightInput> = {},
): FlightOrderInput {
  return validFlightOrderInput(overrides, {
    tripType: FlightTripType.MULTI_CITY,
    outbound: flightJourneyInput([
      FLIGHT_SEGMENTS.delhiVaranasi(),
      flightSegmentInput("Varanasi", "Mumbai", ["2026-10-12", "08:00"], ["2026-10-12", "10:05"]),
      FLIGHT_SEGMENTS.mumbaiGoa(),
    ]),
    ...flight,
  });
}

/** Canonical valid HOTEL booking request. */
export function validHotelOrderInput(
  overrides: Partial<HotelOrderInput> = {},
): HotelOrderInput {
  const checkIn = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const checkOut = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  return {
    serviceType: ServiceType.HOTEL,
    bookingType: BookingType.NEW_BOOKING,
    provider: ProviderId.BUDGET,
    customer: {
      name: "Katherine Johnson",
      email: "katherine@payops.test",
      phone: "+15555550102",
    },
    hotel: {
      destination: "Paris",
      propertyName: "Hilton",
      checkInDate: checkIn,
      checkOutDate: checkOut,
      rooms: 1,
      guests: { adults: 2, children: 0 },
      roomPreference: "King bed, high floor",
      guestNotes: null,
    },
    currency: Currency.USD,
    charges: [
      { name: "Room total", amount: 640, timing: PaymentTiming.PREPAID },
    ],
    notes: "Test hotel booking notes.",
    ...overrides,
  } as HotelOrderInput;
}
