import { describe, expect, it } from "vitest";

import { idempotencyKeyFor } from "@/server/payments/gateways/stripe";

/**
 * The idempotency key must change when the price changes, and must not
 * change otherwise.
 *
 * Stripe's key here is derived from the order id, and the order id does NOT
 * change when the amount does. So a re-priced order asking for a new session
 * would either replay the ORIGINAL session at the ORIGINAL amount, or fail
 * with idempotency_key_in_use. The first outcome charges the customer the
 * wrong amount; the second leaves the order unpayable.
 */
describe("idempotencyKeyFor", () => {
  it("is unchanged for an order that has never been re-priced", () => {
    // Byte-identical to the key used before the revision existed, so every
    // existing order behaves exactly as it does today.
    const expected = "order:ord_1:checkout";
    expect(idempotencyKeyFor({ orderId: "ord_1" })).toBe(expected);
    expect(idempotencyKeyFor({ orderId: "ord_1", priceRevision: 0 })).toBe(expected);
  });

  it("changes once the order has been re-priced", () => {
    expect(idempotencyKeyFor({ orderId: "ord_1", priceRevision: 1 })).toBe(
      "order:ord_1:checkout:r1",
    );
  });

  it("gives every revision its own key", () => {
    const keys = [0, 1, 2, 3].map((r) =>
      idempotencyKeyFor({ orderId: "ord_1", priceRevision: r }),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps different orders apart at the same revision", () => {
    expect(idempotencyKeyFor({ orderId: "a", priceRevision: 2 })).not.toBe(
      idempotencyKeyFor({ orderId: "b", priceRevision: 2 }),
    );
  });
});

/**
 * A replacement session at the SAME price (regenerated link, switching back
 * to a gateway) needs its own key too. With the revision alone, real Stripe
 * returned the just-expired session or refused the call — and the PayPal
 * adapter, which used the order id alone, replayed the original-amount order
 * even after a re-price.
 */
describe("idempotencyKeyFor — replacement attempts", () => {
  it("adds the attempt ordinal only once there is one", () => {
    expect(idempotencyKeyFor({ orderId: "ord_1", attempt: 0 })).toBe(
      "order:ord_1:checkout",
    );
    expect(idempotencyKeyFor({ orderId: "ord_1", attempt: 1 })).toBe(
      "order:ord_1:checkout:a1",
    );
    expect(
      idempotencyKeyFor({ orderId: "ord_1", priceRevision: 2, attempt: 3 }),
    ).toBe("order:ord_1:checkout:r2:a3");
  });

  it("gives every attempt at one revision its own key", () => {
    const keys = [0, 1, 2, 3].map((attempt) =>
      idempotencyKeyFor({ orderId: "ord_1", priceRevision: 1, attempt }),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
