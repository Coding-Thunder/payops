import { BookingType, Currency } from "@/lib/constants/enums";
import { ProviderId } from "@/lib/constants/providers";
import type { CreateOrderInput } from "@/lib/validation";

/**
 * Canonical valid CreateOrderInput. Each fixture returns a fresh object so
 * tests can mutate it without bleeding state. Use as the baseline for
 * "happy path" tests, then `{ ...validCreateOrderInput(), pricing: ... }`
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
    },
    pricing: {
      amount: 249.99,
      currency: Currency.USD,
    },
    notes: "Test booking notes.",
    ...overrides,
  } as CreateOrderInput;
}

/** Input that should fail validation: pickup after dropoff. */
export function invalidTripDatesInput(): CreateOrderInput {
  const later = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const earlier = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return validCreateOrderInput({
    trip: { pickupDate: later, dropoffDate: earlier },
  });
}

/** Input with a sub-cent amount that Stripe would reject. */
export function belowMinimumAmountInput(): CreateOrderInput {
  return validCreateOrderInput({
    pricing: { amount: 0.4, currency: Currency.USD },
  });
}
