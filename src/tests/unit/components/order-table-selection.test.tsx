import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}));

// These exercise paid features, which are disabled by default — see
// src/lib/paid-features.ts. Switched on for this file.
vi.mock("@/lib/paid-features", () => import("@/tests/utils/paid-features-on"));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));
const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  api: { post },
}));

import { ExportOrdersButton } from "@/components/features/orders/export-orders-button";
import { OrderSelectionProvider } from "@/components/features/orders/order-selection";
import { OrderTable } from "@/components/features/orders/order-table";
import {
  BookingType,
  ConsentStatus,
  OrderStatus,
  RecordState,
} from "@/lib/constants/enums";
import type { OrderDTO } from "@/types";

/**
 * The selection outlives paging and filters (it is what Export acts on), so
 * everything else that touches it has to be honest about that: the bar and
 * Clear stay reachable, Delete says what it reaches, and deleting one row
 * does not throw the rest away.
 */

function order(n: number, overrides: Partial<OrderDTO> = {}): OrderDTO {
  const id = `bbbbbbbbbbbbbbbbbbbbbbb${n}`;
  return {
    id,
    orderNumber: `ORD-${n}`,
    bookingType: BookingType.NEW_BOOKING,
    status: OrderStatus.PAYMENT_PENDING,
    state: RecordState.ACTIVE,
    provider: { id: "SIXT", name: "Sixt", logo: "", primaryColor: null, onPrimaryColor: null },
    customer: { name: `Customer ${n}`, email: `c${n}@example.com`, phone: null },
    vehicle: { company: "Toyota", type: "Camry", imageUrl: null },
    pricing: { amount: 150, currency: "USD" },
    charges: [],
    createdBy: { userId: "u1", name: "Asha Verma", email: "asha@ops.test" },
    consent: { status: ConsentStatus.NOT_REQUESTED },
    createdAt: "2026-08-27T09:00:00.000Z",
    updatedAt: "2026-08-27T09:00:00.000Z",
    ...overrides,
  } as OrderDTO;
}

function List({ items }: { items: OrderDTO[] }) {
  return <OrderTable items={items} selectable canDelete filtered />;
}
function renderPage(items: OrderDTO[]) {
  const utils = render(
    <OrderSelectionProvider>
      <ExportOrdersButton />
      <List items={items} />
    </OrderSelectionProvider>,
  );
  // Same provider, new page of rows — what paging or a filter does.
  const showRows = (next: OrderDTO[]) =>
    utils.rerender(
      <OrderSelectionProvider>
        <ExportOrdersButton />
        <List items={next} />
      </OrderSelectionProvider>,
    );
  return { ...utils, showRows };
}
const tick = (n: number) =>
  fireEvent.click(screen.getByRole("checkbox", { name: `Select order ORD-${n}` }));
const bar = () => screen.queryByTestId("order-bulk-bar");

beforeEach(() => {
  post.mockReset();
});

describe("the shared selection in the Orders table", () => {
  it("keeps the count and Clear when a filter leaves no rows on screen", () => {
    const { showRows } = renderPage([order(1), order(2)]);
    tick(1);
    showRows([]);
    expect(screen.getByText("No orders match these filters")).toBeInTheDocument();
    expect(bar()).toHaveTextContent("1 selected (1 not on this page)");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(bar()).toBeNull();
    expect(screen.getByRole("button", { name: /export/i })).toBeDisabled();
  });

  it("Clear keeps keyboard focus in the table", async () => {
    renderPage([order(1), order(2)]);
    tick(1);
    screen.getByRole("button", { name: "Clear" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: /select all orders on this page/i }),
      ).toHaveFocus(),
    );
  });

  it("Delete says when the selection reaches orders that are not on screen", () => {
    const { showRows } = renderPage([order(1), order(2)]);
    tick(1);
    showRows([order(2, { status: OrderStatus.PAID }), order(3)]);
    tick(2);
    fireEvent.click(screen.getByRole("button", { name: /delete selected/i }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Delete 2 orders?");
    expect(dialog).toHaveTextContent("1 of them is not on this page.");
    expect(dialog).toHaveTextContent("1 is paid and will be kept.");
  });

  it("deleting one row from its menu leaves the rest of the selection alone", async () => {
    post.mockResolvedValue({ deleted: 1, blockedPaidIds: [] });
    renderPage([order(1), order(2), order(3)]);
    tick(1);
    tick(2);

    const trigger = screen.getByRole("button", { name: "Actions for order ORD-3" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /delete/i }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Delete" }),
      );
    });

    expect(post).toHaveBeenCalledWith("/api/orders/delete", {
      ids: ["bbbbbbbbbbbbbbbbbbbbbbb3"],
    });
    // Before: the whole selection was wiped.
    expect(screen.getByRole("button", { name: /export/i })).toHaveTextContent(
      "Export 2 orders",
    );
  });
});
