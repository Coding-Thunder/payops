import { describe, expect, it, vi } from "vitest";

import {
  findJustCreatedOrder,
  isUnknownCreateOutcome,
  matchesSubmittedOrder,
} from "@/components/features/orders/create-outcome";
import { ApiClientError } from "@/lib/api-client";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";
import type { OrderDTO, PaginatedResult } from "@/types";

/**
 * A create request that fails without saying whether the order was written
 * must not be blindly retried — that is how one booking became two orders.
 */

const err = (status: number, code = "X") =>
  new ApiClientError(status, { code, message: "m" });

describe("isUnknownCreateOutcome", () => {
  it("treats a dropped connection, a 5xx and an unreadable reply as unknown", () => {
    expect(isUnknownCreateOutcome(new TypeError("Failed to fetch"))).toBe(true);
    expect(isUnknownCreateOutcome(err(500))).toBe(true);
    expect(isUnknownCreateOutcome(err(504))).toBe(true);
    expect(isUnknownCreateOutcome(err(200, "BAD_RESPONSE"))).toBe(true);
  });

  it("treats a refusal as known — nothing was saved", () => {
    expect(isUnknownCreateOutcome(err(400, "VALIDATION_ERROR"))).toBe(false);
    expect(isUnknownCreateOutcome(err(401, "UNAUTHORIZED"))).toBe(false);
    expect(isUnknownCreateOutcome(err(403, "FORBIDDEN"))).toBe(false);
    expect(isUnknownCreateOutcome(err(429, "RATE_LIMITED"))).toBe(false);
  });
});

function asOrder(values: ReturnType<typeof validCreateOrderInput>, id = "o1") {
  return {
    id,
    orderNumber: `ORD-${id}`,
    customer: { ...values.customer, email: values.customer.email.toUpperCase() },
    provider: { id: values.provider },
    trip: {
      ...values.trip,
      // Same instant, different spelling.
      pickupDate: new Date(values.trip.pickupDate).toISOString().replace("Z", "+00:00"),
    },
  } as unknown as OrderDTO;
}

describe("matchesSubmittedOrder", () => {
  it("matches the same customer, provider and trip", () => {
    const v = validCreateOrderInput();
    expect(matchesSubmittedOrder(asOrder(v), v)).toBe(true);
  });

  it("does not match a different trip for the same customer", () => {
    const v = validCreateOrderInput();
    const other = validCreateOrderInput({
      trip: { ...v.trip, dropoffDate: new Date(Date.now() + 9e8).toISOString() },
    });
    expect(matchesSubmittedOrder(asOrder(other), v)).toBe(false);
  });
});

describe("findJustCreatedOrder", () => {
  it("asks for this operator's recent orders for the customer", async () => {
    const v = validCreateOrderInput();
    const fetcher = vi.fn<(path: string) => Promise<PaginatedResult<OrderDTO>>>(async () => ({
      items: [asOrder(v, "found")],
      total: 1,
      page: 1,
      pageSize: 10,
    }));
    const found = await findJustCreatedOrder(v, Date.parse("2026-09-16T12:00:00Z"), fetcher);
    expect(found?.id).toBe("found");
    const url = new URL(fetcher.mock.calls[0][0], "http://x");
    expect(url.pathname).toBe("/api/orders");
    expect(url.searchParams.get("mine")).toBe("true");
    expect(url.searchParams.get("q")).toBe(v.customer.email);
    expect(Date.parse(url.searchParams.get("from")!)).toBeLessThan(
      Date.parse("2026-09-16T12:00:00Z"),
    );
  });

  it("returns null when nothing matches", async () => {
    const v = validCreateOrderInput();
    const fetcher = vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 10 }));
    expect(await findJustCreatedOrder(v, Date.now(), fetcher)).toBeNull();
  });

  it("throws when the lookup fails, so the outcome stays unknown", async () => {
    const v = validCreateOrderInput();
    const fetcher = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(findJustCreatedOrder(v, Date.now(), fetcher)).rejects.toThrow();
  });
});
