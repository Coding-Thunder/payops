import { describe, expect, it } from "vitest";

import {
  diffOrder,
  orderToFormValues,
  touchesCheckoutDetails,
  type OrderFormValues,
} from "@/components/features/orders/order-form-model";
import {
  BookingType,
  ConsentStatus,
  OrderStatus,
  PaymentTiming,
  RecordState,
} from "@/lib/constants/enums";
import { createOrderSchema, modifyOrderSchema } from "@/lib/validation";
import type { OrderDTO } from "@/types";

/**
 * Edit Order renders the full create form and sends only what changed.
 * These rules decide what an edit SENDS — and so whether changing a phone
 * number could ever reach the payment machinery.
 */

function order(overrides: Partial<OrderDTO> = {}): OrderDTO {
  return {
    id: "order-1",
    orderNumber: "ORD-260916-ABC",
    bookingType: BookingType.NEW_BOOKING,
    status: OrderStatus.PAYMENT_PENDING,
    state: RecordState.ACTIVE,
    provider: { id: "BUDGET", name: "Budget", logo: "/providers/budget.png" },
    customer: { name: "Ada Lovelace", email: "ada@payops.test", phone: "+15555550100" },
    vehicle: {
      company: "Toyota",
      type: "Camry",
      imageUrl: "https://cdn.example.com/camry.jpg",
    },
    trip: {
      pickupDate: "2026-09-20T10:00:00.000Z",
      dropoffDate: "2026-09-23T10:00:00.000Z",
      pickupLocation: "MCO Airport — Terminal A",
      dropoffLocation: "Tampa Downtown",
    },
    pricing: { amount: 500, currency: "USD" },
    charges: [
      { name: "Rental cost", amount: 500, timing: PaymentTiming.PREPAID },
      { name: "Child seat", amount: 40, timing: PaymentTiming.DUE_AT_COUNTER },
    ],
    notes: "Frequent customer.",
    consent: { status: ConsentStatus.NOT_REQUESTED },
    createdAt: "2026-09-16T09:00:00.000Z",
    updatedAt: "2026-09-16T09:00:00.000Z",
    ...overrides,
  } as OrderDTO;
}

const edit = (o: OrderDTO, change: (v: OrderFormValues) => void) => {
  const v = orderToFormValues(o);
  change(v);
  return v;
};

describe("orderToFormValues", () => {
  it("produces values the create schema accepts unchanged", () => {
    // Edit mode validates with the create schema. A saved order must pass it
    // as-is, or the operator could not save any change at all.
    const parsed = createOrderSchema.safeParse(orderToFormValues(order()));
    expect(parsed.success).toBe(true);
  });

  it("carries the provider key, the photo, and every charge line", () => {
    const v = orderToFormValues(order());
    expect(v.provider).toBe("BUDGET");
    expect(v.vehicle.imageUrl).toBe("https://cdn.example.com/camry.jpg");
    expect(v.charges).toHaveLength(2);
    expect(v.charges[1]).toEqual({
      name: "Child seat",
      amount: 40,
      timing: PaymentTiming.DUE_AT_COUNTER,
    });
  });

  it("gives a legacy order with no charge lines its single prepaid line", () => {
    const v = orderToFormValues(order({ charges: [] }));
    expect(v.charges).toEqual([
      { name: "Rental cost", amount: 500, timing: PaymentTiming.PREPAID },
    ]);
  });

  it("maps missing optional values to empty inputs", () => {
    const v = orderToFormValues(
      order({
        vehicle: { company: "Toyota", type: "Camry", imageUrl: null },
        trip: {
          pickupDate: "2026-09-20T10:00:00.000Z",
          dropoffDate: "2026-09-23T10:00:00.000Z",
          pickupLocation: null,
          dropoffLocation: null,
        },
        notes: null,
      }),
    );
    expect(v.vehicle.imageUrl).toBe("");
    expect(v.trip.pickupLocation).toBe("");
    expect(v.notes).toBe("");
  });
});

describe("diffOrder — nothing changed", () => {
  it("sends nothing for an untouched form", () => {
    const d = diffOrder(orderToFormValues(order()), order());
    expect(d.payload).toBeNull();
    expect(d.changed).toEqual([]);
    expect(d.amountChanged).toBe(false);
  });

  it("does not count whitespace, email case or date spelling as a change", () => {
    const o = order();
    const v = edit(o, (v) => {
      v.customer.name = "  Ada Lovelace ";
      v.customer.email = "ADA@payops.test";
      v.provider = "budget";
      v.trip.pickupDate = "2026-09-20T10:00:00Z";
    });
    expect(diffOrder(v, o).payload).toBeNull();
  });

  it("does not send a change note on its own", () => {
    // The server refuses a reason-only request; there is nothing to amend.
    const d = diffOrder(orderToFormValues(order()), order(), "Customer called");
    expect(d.payload).toBeNull();
  });
});

describe("diffOrder — what an edit sends", () => {
  it("sends only the customer field that moved", () => {
    const o = order();
    const d = diffOrder(edit(o, (v) => (v.customer.phone = "+15555550199")), o);
    expect(d.payload).toEqual({ customer: { phone: "+15555550199" } });
    expect(d.amountChanged).toBe(false);
  });

  it("never sends booking type, currency or internal notes", () => {
    const o = order();
    const d = diffOrder(
      edit(o, (v) => {
        v.bookingType = BookingType.MODIFICATION;
        v.currency = "EUR" as OrderFormValues["currency"];
        v.notes = "changed";
        v.customer.name = "Grace Hopper";
      }),
      o,
    );
    expect(d.payload).toEqual({ customer: { name: "Grace Hopper" } });
    // And the server schema would reject them if they ever were sent.
    expect(modifyOrderSchema.safeParse({ ...d.payload, currency: "EUR" }).success).toBe(false);
  });

  it("sends the photo with a car-library pick", () => {
    const o = order();
    const d = diffOrder(
      edit(o, (v) => {
        v.vehicle.company = "BMW";
        v.vehicle.type = "3 Series";
        v.vehicle.imageUrl = "https://cdn.example.com/bmw.jpg";
      }),
      o,
    );
    expect(d.payload).toEqual({
      vehicle: {
        company: "BMW",
        type: "3 Series",
        imageUrl: "https://cdn.example.com/bmw.jpg",
      },
    });
  });

  it("sends a provider change as the upper-case key", () => {
    const o = order();
    const d = diffOrder(edit(o, (v) => (v.provider = "hertz")), o);
    expect(d.payload).toEqual({ provider: "HERTZ" });
    expect(d.changed).toEqual(["provider"]);
  });

  it("sends trip dates as instants", () => {
    const o = order();
    const d = diffOrder(
      edit(o, (v) => (v.trip.dropoffDate = "2026-09-24T12:30:00.000Z")),
      o,
    );
    expect(d.payload).toEqual({ trip: { dropoffDate: "2026-09-24T12:30:00.000Z" } });
  });

  it("attaches the change note to a real change", () => {
    const o = order();
    const d = diffOrder(
      edit(o, (v) => (v.trip.dropoffLocation = "Orlando Downtown")),
      o,
      "  Customer asked to return in Orlando ",
    );
    expect(d.payload?.reason).toBe("Customer asked to return in Orlando");
  });

  it("produces a request the server schema accepts", () => {
    const o = order();
    const d = diffOrder(
      edit(o, (v) => {
        v.provider = "HERTZ";
        v.customer.email = "grace@payops.test";
        v.vehicle.imageUrl = "";
        v.trip.pickupLocation = "Orlando Airport";
        v.charges[0].amount = 650;
      }),
      o,
      "Upgrade",
    );
    expect(modifyOrderSchema.safeParse(d.payload).success).toBe(true);
  });
});

describe("diffOrder — charges", () => {
  it("sends the whole breakdown when only a counter line changes", () => {
    const o = order();
    const d = diffOrder(edit(o, (v) => (v.charges[1].amount = 65)), o);
    expect(d.changed).toEqual(["charges"]);
    expect(d.payload?.charges).toEqual([
      { name: "Rental cost", amount: 500, timing: PaymentTiming.PREPAID },
      { name: "Child seat", amount: 65, timing: PaymentTiming.DUE_AT_COUNTER },
    ]);
    // A counter line is not what the payment link collects.
    expect(d.amountChanged).toBe(false);
  });

  it("flags the amount only when the prepaid total moves", () => {
    const o = order();
    const d = diffOrder(edit(o, (v) => (v.charges[0].amount = 650)), o);
    expect(d.amountChanged).toBe(true);
    expect(d.previousPrepaid).toBe(500);
    expect(d.nextPrepaid).toBe(650);
  });

  it("treats a same-total split as a breakdown change, not an amount change", () => {
    const o = order();
    const d = diffOrder(
      edit(o, (v) => {
        v.charges = [
          { name: "Rental cost", amount: 300, timing: PaymentTiming.PREPAID },
          { name: "Insurance", amount: 200, timing: PaymentTiming.PREPAID },
          { name: "Child seat", amount: 40, timing: PaymentTiming.DUE_AT_COUNTER },
        ];
      }),
      o,
    );
    expect(d.changed).toEqual(["charges"]);
    expect(d.amountChanged).toBe(false);
  });

  it("omits charges when the breakdown is identical", () => {
    const o = order();
    const d = diffOrder(
      edit(o, (v) => {
        v.customer.name = "Ada King";
        // Same value, typed with float dust.
        v.charges[0].amount = 500.0000001;
      }),
      o,
    );
    expect(d.payload).toEqual({ customer: { name: "Ada King" } });
  });
});

describe("diffOrder — a paid order", () => {
  it("never sends provider or charges, even if the form still holds edits", () => {
    const o = order({ status: OrderStatus.PAID });
    const d = diffOrder(
      edit(o, (v) => {
        v.provider = "HERTZ";
        v.charges[0].amount = 620;
        v.customer.phone = "+15555550188";
      }),
      o,
      "",
      { settled: true },
    );
    // The descriptive change still goes through; the settled money does not.
    expect(d.payload).toEqual({ customer: { phone: "+15555550188" } });
    expect(d.changed).toEqual(["customer.phone"]);
    expect(d.amountChanged).toBe(false);
  });
});

describe("touchesCheckoutDetails", () => {
  it("is true for anything the checkout page shows", () => {
    expect(touchesCheckoutDetails(["provider"])).toBe(true);
    expect(touchesCheckoutDetails(["vehicle.type"])).toBe(true);
    expect(touchesCheckoutDetails(["trip.dropoffDate"])).toBe(true);
    expect(touchesCheckoutDetails(["customer.email"])).toBe(true);
  });

  it("is false for details the checkout page never shows", () => {
    expect(touchesCheckoutDetails([])).toBe(false);
    expect(touchesCheckoutDetails(["customer.name", "customer.phone"])).toBe(false);
    expect(touchesCheckoutDetails(["vehicle.imageUrl"])).toBe(false);
  });
});
