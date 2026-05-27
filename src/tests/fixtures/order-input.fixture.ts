import { Currency } from "@/lib/constants/enums";
import { SchedulingType } from "@/lib/constants/items";
import type { CreateOrderUniversalInput } from "@/lib/validation";

/**
 * Canonical valid universal-shape CreateOrder input. Each fixture
 * returns a fresh object so tests can mutate it without bleeding state.
 *
 * The default fixture mimics the auto-seeded `rental_booking` ItemType
 * (the one Tenant #1 uses) so existing tests that depend on a rental
 * order can swap their old fixture for this one with minimal damage.
 * Tests for other verticals (milk shop, pharmacy, etc.) should seed
 * their own ItemType and pass `lineItems[].itemTypeKey` accordingly.
 */
export function validCreateOrderInput(
  overrides: Partial<CreateOrderUniversalInput> = {},
): CreateOrderUniversalInput {
  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const endsAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
  return {
    customer: {
      name: "Ada Lovelace",
      email: "ada@payops.test",
      phone: "+15555550100",
    },
    lineItems: [
      {
        itemTypeKey: "rental_booking",
        name: "Toyota Camry rental",
        description: null,
        quantity: 1,
        unitPrice: 249.99,
        total: 249.99,
        attributes: {},
        itemId: null,
        scheduling: null,
      },
    ],
    pricing: {
      amount: 249.99,
      currency: Currency.USD,
    },
    scheduling: {
      type: SchedulingType.FIXED_WINDOW,
      startsAt,
      endsAt,
    },
    notes: "Test booking notes.",
    ...overrides,
  };
}

/** Input that should fail validation: scheduling end before start. */
export function invalidSchedulingInput(): CreateOrderUniversalInput {
  const later = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const earlier = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return validCreateOrderInput({
    scheduling: {
      type: SchedulingType.FIXED_WINDOW,
      startsAt: later,
      endsAt: earlier,
    },
  });
}

/** Input with a sub-cent amount that Stripe would reject. */
export function belowMinimumAmountInput(): CreateOrderUniversalInput {
  return validCreateOrderInput({
    pricing: { amount: 0.4, currency: Currency.USD },
    lineItems: [
      {
        itemTypeKey: "rental_booking",
        name: "Tiny test",
        description: null,
        quantity: 1,
        unitPrice: 0.4,
        total: 0.4,
        attributes: {},
        itemId: null,
        scheduling: null,
      },
    ],
  });
}
