import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { OrderTable } from "@/components/features/orders/order-table";
import { resolveOrderAgent } from "@/lib/format";
import {
  BookingType,
  ConsentStatus,
  OrderStatus,
  RecordState,
} from "@/lib/constants/enums";
import type { OrderDTO } from "@/types";

// The table calls router.refresh() after a delete. Nothing here deletes, but
// the hook throws outside an app-router tree, so it is stubbed the same way
// the login-form test does it.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

/**
 * The Agent column.
 *
 * `OrderTable` is rendered by BOTH order-listing screens — the dashboard's
 * recent orders and /app/orders — so there is one column, one resolver and
 * one set of tests rather than a pair that can drift. The final test in this
 * file pins that sharing, because it is the property the requirement is
 * really about.
 *
 * The agent is read from `order.createdBy`, a snapshot the order already
 * carries. Nothing here looks a user up: that is what makes the column free
 * of per-row queries and impossible to point at another tenant's user.
 */

function order(overrides: Partial<OrderDTO> = {}): OrderDTO {
  return {
    id: "order-1",
    orderNumber: "ORD-1",
    bookingType: BookingType.NEW_BOOKING,
    status: OrderStatus.PAYMENT_PENDING,
    state: RecordState.ACTIVE,
    provider: { id: "SIXT", name: "Sixt", logo: "", primaryColor: null, onPrimaryColor: null },
    customer: { name: "Jane Guest", email: "jane@example.com", phone: null },
    vehicle: { company: "Toyota", type: "Camry", imageUrl: null },
    trip: {
      pickupDate: "2026-09-01T10:00:00.000Z",
      dropoffDate: "2026-09-03T10:00:00.000Z",
      pickupLocation: null,
      dropoffLocation: null,
    },
    pricing: { amount: 150, currency: "USD" },
    charges: [],
    createdBy: { userId: "u1", name: "Asha Verma", email: "asha@ops.test" },
    consent: { status: ConsentStatus.NOT_REQUESTED },
    createdAt: "2026-08-27T09:00:00.000Z",
    updatedAt: "2026-08-27T09:00:00.000Z",
    ...overrides,
  } as OrderDTO;
}

/** The Agent cell of the first data row. */
function agentCell(): string {
  const rows = screen.getAllByRole("row");
  const header = within(rows[0]!).getAllByRole("columnheader").map((h) => h.textContent);
  const index = header.indexOf("Agent");
  expect(index).toBeGreaterThan(-1);
  const cells = within(rows[1]!).getAllByRole("cell");
  return cells[index]!.textContent ?? "";
}

describe("the Agent column", () => {
  it("sits immediately after Customer", () => {
    render(<OrderTable items={[order()]} />);
    const headers = within(screen.getAllByRole("row")[0]!)
      .getAllByRole("columnheader")
      .map((h) => h.textContent);

    expect(headers).toContain("Agent");
    expect(headers.indexOf("Agent")).toBe(headers.indexOf("Customer") + 1);
  });

  it("gives every row as many cells as there are headers", () => {
    // A column added to the header and not the body silently shifts every
    // value one place to the left.
    render(<OrderTable items={[order()]} />);
    const rows = screen.getAllByRole("row");
    const headers = within(rows[0]!).getAllByRole("columnheader").length;
    expect(within(rows[1]!).getAllByRole("cell")).toHaveLength(headers);
  });

  it("shows the creator's display name", () => {
    render(<OrderTable items={[order()]} />);
    expect(agentCell()).toBe("Asha Verma");
  });

  it("falls back to the email when there is no display name", () => {
    render(
      <OrderTable
        items={[order({ createdBy: { userId: "u1", name: "", email: "asha@ops.test" } })]}
      />,
    );
    expect(agentCell()).toBe("asha@ops.test");
  });

  it('shows "System" for an order with no creator', () => {
    render(
      <OrderTable items={[order({ createdBy: { userId: "", name: "", email: "" } })]} />,
    );
    expect(agentCell()).toBe("System");
  });

  it('shows "System" without crashing when the creator is absent entirely', () => {
    // A row written before the creator snapshot existed. The DTO mapping
    // guards it, but the column must not assume the guard ran.
    const missing = order();
    delete (missing as { createdBy?: unknown }).createdBy;

    render(<OrderTable items={[missing]} />);
    expect(agentCell()).toBe("System");
  });

  it("renders an agent per row without conflating them", () => {
    render(
      <OrderTable
        items={[
          order({ id: "a", orderNumber: "ORD-A" }),
          order({
            id: "b",
            orderNumber: "ORD-B",
            createdBy: { userId: "u2", name: "Bilal Khan", email: "bilal@ops.test" },
          }),
          order({
            id: "c",
            orderNumber: "ORD-C",
            createdBy: { userId: "", name: "", email: "" },
          }),
        ]}
      />,
    );

    const rows = screen.getAllByRole("row");
    const index = within(rows[0]!)
      .getAllByRole("columnheader")
      .map((h) => h.textContent)
      .indexOf("Agent");
    const agents = rows
      .slice(1)
      .map((r) => within(r).getAllByRole("cell")[index]!.textContent);

    expect(agents).toEqual(["Asha Verma", "Bilal Khan", "System"]);
  });
});

describe("resolveOrderAgent", () => {
  it("prefers the name", () => {
    expect(resolveOrderAgent({ name: "Asha Verma", email: "asha@ops.test" })).toBe(
      "Asha Verma",
    );
  });

  it("falls back to the email", () => {
    expect(resolveOrderAgent({ name: "", email: "asha@ops.test" })).toBe("asha@ops.test");
  });

  it("treats whitespace as absent", () => {
    expect(resolveOrderAgent({ name: "   ", email: "  asha@ops.test  " })).toBe(
      "asha@ops.test",
    );
    expect(resolveOrderAgent({ name: "  ", email: "  " })).toBe("System");
  });

  it("handles null, undefined and empty creators", () => {
    expect(resolveOrderAgent(null)).toBe("System");
    expect(resolveOrderAgent(undefined)).toBe("System");
    expect(resolveOrderAgent({})).toBe("System");
    expect(resolveOrderAgent({ name: null, email: null })).toBe("System");
  });
});

describe("both listing screens resolve the agent the same way", () => {
  /**
   * Not a style preference — it is the requirement. The dashboard and
   * /app/orders render the same `OrderTable`, so there is exactly one
   * implementation and it cannot diverge. This asserts the property rather
   * than the arrangement: whatever `resolveOrderAgent` returns is what the
   * column shows, for every case that has its own branch.
   */
  it.each([
    [{ userId: "u1", name: "Asha Verma", email: "asha@ops.test" }],
    [{ userId: "u1", name: "", email: "asha@ops.test" }],
    [{ userId: "", name: "", email: "" }],
  ])("column output matches resolveOrderAgent for %o", (creator) => {
    render(<OrderTable items={[order({ createdBy: creator })]} />);
    expect(agentCell()).toBe(resolveOrderAgent(creator));
  });
});
