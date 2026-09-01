import {
  BookingType,
  CabinClass,
  CruiseCabinCategory,
  Currency,
  PaymentTiming,
  ServiceType,
  TripType,
} from "@/lib/constants/enums";
import { ProviderId } from "@/lib/constants/providers";
import type {
  CarRentalOrderInput,
  CruiseOrderInput,
  FlightOrderInput,
} from "@/lib/validation";

/**
 * Canonical valid CreateOrderInput. Each fixture returns a fresh object so
 * tests can mutate it without bleeding state. Use as the baseline for
 * "happy path" tests, then `{ ...validCreateOrderInput(), charges: ... }`
 * to assert a single field's behaviour.
 */
export function validCreateOrderInput(
  overrides: Partial<CarRentalOrderInput> = {},
): CarRentalOrderInput {
  const pickup = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const dropoff = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  return {
    serviceType: ServiceType.CAR_RENTAL,
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
  } as CarRentalOrderInput;
}

/** Input that should fail validation: pickup after dropoff. */
export function invalidTripDatesInput(): CarRentalOrderInput {
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
export function belowMinimumAmountInput(): CarRentalOrderInput {
  return validCreateOrderInput({
    charges: [
      { name: "Rental cost", amount: 0.4, timing: PaymentTiming.PREPAID },
    ],
  });
}

/* ─────────────────────────── Flights ─────────────────────────── */

/**
 * Canonical valid flight order input — a round trip, because that is the
 * shape with the extra required field (`returnDate`) and therefore the one
 * a happy-path test should be exercising.
 */
export function validFlightOrderInput(
  overrides: Partial<FlightOrderInput> = {},
): FlightOrderInput {
  const departure = new Date(Date.now() + 14 * 86_400_000).toISOString();
  const arrival = new Date(Date.now() + 14 * 86_400_000 + 8 * 3_600_000)
    .toISOString();
  const back = new Date(Date.now() + 21 * 86_400_000).toISOString();
  return {
    serviceType: ServiceType.FLIGHT,
    bookingType: BookingType.NEW_BOOKING,
    provider: "TESTAIR",
    customer: {
      name: "Ada Lovelace",
      email: "ada@payops.test",
      phone: "+15555550100",
    },
    flight: {
      tripType: TripType.ROUND_TRIP,
      airline: "British Airways",
      flightNumber: "BA117",
      origin: "LHR — London Heathrow",
      destination: "JFK — New York",
      departureDate: departure,
      departureTimePreference: "Morning",
      arrivalDate: arrival,
      returnDate: back,
      returnTimePreference: "Evening",
      cabinClass: CabinClass.ECONOMY,
      passengers: { adults: 2, children: 1, infants: 0 },
      passengerNotes: "Aisle seats together.",
      pnr: null,
    },
    currency: Currency.USD,
    charges: [
      { name: "Airfare", amount: 1240.5, timing: PaymentTiming.PREPAID },
    ],
    notes: "Test flight booking notes.",
    ...overrides,
  } as FlightOrderInput;
}

/** One-way variant — no return leg, which the schema must accept. */
export function validOneWayFlightOrderInput(): FlightOrderInput {
  const input = validFlightOrderInput();
  return {
    ...input,
    flight: {
      ...input.flight,
      tripType: TripType.ONE_WAY,
      returnDate: null,
      returnTimePreference: null,
    },
  };
}

/* ─────────────────────────── Cruises ─────────────────────────── */

/** Canonical valid cruise order input — a round trip from Miami. */
export function validCruiseOrderInput(
  overrides: Partial<CruiseOrderInput> = {},
): CruiseOrderInput {
  const sail = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const back = new Date(Date.now() + 37 * 86_400_000).toISOString();
  return {
    serviceType: ServiceType.CRUISE,
    bookingType: BookingType.NEW_BOOKING,
    provider: "TESTCRUISE",
    customer: {
      name: "Ada Lovelace",
      email: "ada@payops.test",
      phone: "+15555550100",
    },
    cruise: {
      cruiseLine: "Royal Caribbean",
      shipName: "Wonder of the Seas",
      itinerary: "Western Caribbean",
      departurePort: "Miami, FL",
      arrivalPort: null,
      departureDate: sail,
      returnDate: back,
      cabinCategory: CruiseCabinCategory.BALCONY,
      cabinNumber: null,
      guests: { adults: 2, children: 2 },
      guestNotes: "Adjoining staterooms if possible.",
      bookingReference: null,
    },
    currency: Currency.USD,
    charges: [
      { name: "Cruise fare", amount: 2480, timing: PaymentTiming.PREPAID },
      {
        name: "Gratuities",
        amount: 196,
        timing: PaymentTiming.DUE_AT_COUNTER,
      },
    ],
    notes: "Test cruise booking notes.",
    ...overrides,
  } as CruiseOrderInput;
}
