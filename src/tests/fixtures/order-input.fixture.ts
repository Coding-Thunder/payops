import {
  BookingType,
  Currency,
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

/** Canonical valid FLIGHT booking request (one way). */
export function validFlightOrderInput(
  overrides: Partial<FlightOrderInput> = {},
): FlightOrderInput {
  const departure = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
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
      tripType: "ONE_WAY",
      airline: "Test Airways",
      flightNumber: "TA123",
      origin: "LHR",
      destination: "JFK",
      departureDate: departure,
      departureTimePreference: "Morning",
      returnDate: null,
      returnTimePreference: null,
      cabinClass: "ECONOMY",
      passengers: { adults: 1, children: 0, infants: 0 },
      passengerNotes: null,
    },
    currency: Currency.USD,
    charges: [
      { name: "Air fare", amount: 420.5, timing: PaymentTiming.PREPAID },
    ],
    notes: "Test flight booking notes.",
    ...overrides,
  } as FlightOrderInput;
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
