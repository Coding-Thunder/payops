import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("@/components/ui/sonner", () => ({ toast }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("status=PAID&q=ada&page=3"),
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
 * Export is a BULK ACTION ON THE SELECTION, not "download this list".
 *
 * These render the real table together with the real button, because the
 * thing worth pinning is the wiring between them: what the operator ticks is
 * what is sent, the count is on the button, and with nothing ticked the
 * action is unavailable rather than exporting everything.
 */

const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function order(id: string, overrides: Partial<OrderDTO> = {}): OrderDTO {
  return {
    id,
    orderNumber: `ORD-${id.toUpperCase()}`,
    bookingType: BookingType.NEW_BOOKING,
    status: OrderStatus.PAYMENT_PENDING,
    state: RecordState.ACTIVE,
    provider: { id: "SIXT", name: "Sixt", logo: "", primaryColor: null, onPrimaryColor: null },
    customer: { name: `Customer ${id}`, email: `${id}@example.com`, phone: null },
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

const ORDERS = [
  order("aaaaaaaaaaaaaaaaaaaaaaa1"),
  order("aaaaaaaaaaaaaaaaaaaaaaa2"),
  // Paid orders are exactly what charging data is exported for, so they
  // must be selectable too.
  order("aaaaaaaaaaaaaaaaaaaaaaa3", { status: OrderStatus.PAID }),
];

function renderList(items: OrderDTO[] = ORDERS) {
  return render(
    <OrderSelectionProvider>
      <ExportOrdersButton />
      <OrderTable items={items} selectable canDelete />
    </OrderSelectionProvider>,
  );
}

/** The bulk action in the page header. While it runs, the spinner puts
 *  "Loading" in front of its label, so the match is not anchored. */
const exportButton = () => screen.getByRole("button", { name: /export/i });

function select(orderNumber: string) {
  fireEvent.click(screen.getByRole("checkbox", { name: `Select order ${orderNumber}` }));
}

/** A workbook reply, as the export route sends it. */
function workbookResponse(count: number) {
  return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
    status: 200,
    headers: {
      "content-type": XLSX,
      "content-disposition": 'attachment; filename="payops-charges-20260918.xlsx"',
      "x-export-order-count": String(count),
    },
  });
}

/** Records what the browser was asked to download. */
function captureDownloads(): { names: string[]; restore: () => void } {
  const names: string[] = [];
  const original = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    names.push(this.download);
  };
  return {
    names,
    restore: () => {
      HTMLAnchorElement.prototype.click = original;
    },
  };
}

beforeEach(() => {
  toast.success.mockReset();
  toast.error.mockReset();
  toast.info.mockReset();
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = vi.fn(
    () => "blob:x",
  );
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Export XLSX is a bulk action on the selection", () => {
  it("is unavailable, and says why, until orders are selected", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderList();

    const button = exportButton();
    expect(button).toHaveTextContent("Export XLSX");
    expect(button).toBeDisabled();
    // Visible, not only a tooltip.
    const hint = screen.getByText("Select orders below to export them");
    expect(hint).toBeVisible();
    expect(button).toHaveAttribute("aria-describedby", hint.id);

    fireEvent.click(button);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts the selected orders on the button", () => {
    renderList();
    select("ORD-AAAAAAAAAAAAAAAAAAAAAAA1");
    expect(exportButton()).toHaveTextContent("Export 1 order");
    expect(exportButton()).toBeEnabled();

    select("ORD-AAAAAAAAAAAAAAAAAAAAAAA2");
    select("ORD-AAAAAAAAAAAAAAAAAAAAAAA3");
    expect(exportButton()).toHaveTextContent("Export 3 orders");
  });

  it("sends exactly the selected ids — never the list's filters", async () => {
    const fetchMock = vi.fn(async () => workbookResponse(2));
    vi.stubGlobal("fetch", fetchMock);
    const downloads = captureDownloads();
    renderList();
    // A paid order and a pending one; the third row stays unticked.
    select("ORD-AAAAAAAAAAAAAAAAAAAAAAA1");
    select("ORD-AAAAAAAAAAAAAAAAAAAAAAA3");
    try {
      await act(async () => {
        fireEvent.click(exportButton());
      });
    } finally {
      downloads.restore();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/orders/export");
    expect(init.method).toBe("POST");
    // The URL carries filters (status=PAID&q=ada&page=3); the request must not.
    expect(JSON.parse(String(init.body))).toEqual({
      ids: ["aaaaaaaaaaaaaaaaaaaaaaa1", "aaaaaaaaaaaaaaaaaaaaaaa3"],
    });
    expect(downloads.names).toEqual(["payops-charges-20260918.xlsx"]);
    expect(toast.success).toHaveBeenCalledWith(
      "Exported 2 orders to payops-charges-20260918.xlsx",
      expect.anything(),
    );
  });

  it("clearing the selection puts the action back out of reach", () => {
    renderList();
    select("ORD-AAAAAAAAAAAAAAAAAAAAAAA1");
    expect(exportButton()).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(exportButton()).toHaveTextContent("Export XLSX");
    expect(exportButton()).toBeDisabled();
  });

  it("select-all ticks every order on the page, paid ones included", () => {
    renderList();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /select all orders on this page/i }),
    );
    expect(exportButton()).toHaveTextContent("Export 3 orders");
  });

  it("starts one export however fast the button is clicked", async () => {
    let release: (r: Response) => void = () => {};
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderList();
    select("ORD-AAAAAAAAAAAAAAAAAAAAAAA1");
    const button = exportButton();
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(exportButton()).toHaveAttribute("aria-busy", "true");

    await act(async () => {
      release(
        new Response("{}", {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    // Restored, so the operator can try again.
    expect(exportButton()).toBeEnabled();
    expect(exportButton()).not.toHaveAttribute("aria-busy");
  });

  it("shows the server's reason when the export is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: {
                code: "NOT_FOUND",
                message:
                  "1 of the 2 selected orders are no longer available to you. Refresh the list and select again.",
              },
            }),
            { status: 404, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    renderList();
    select("ORD-AAAAAAAAAAAAAAAAAAAAAAA1");
    await act(async () => {
      fireEvent.click(exportButton());
    });
    expect(toast.error).toHaveBeenCalledWith(
      "1 of the 2 selected orders are no longer available to you. Refresh the list and select again.",
      expect.anything(),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("explains a rate limit and a lost session in the operator's terms", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: { code: "RATE_LIMITED", details: { retryAfterSec: 42 } },
            }),
            { status: 429, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    renderList();
    select("ORD-AAAAAAAAAAAAAAAAAAAAAAA1");
    await act(async () => {
      fireEvent.click(exportButton());
    });
    expect(toast.error).toHaveBeenCalledWith(
      "Too many exports in a row. Try again in 42 seconds.",
      expect.anything(),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401 })),
    );
    await act(async () => {
      fireEvent.click(exportButton());
    });
    expect(toast.error).toHaveBeenLastCalledWith(
      "Your session has ended. Sign in again (reload the page) to export.",
      expect.anything(),
    );
  });

  it("does not treat a non-workbook reply as a download", async () => {
    const downloads = captureDownloads();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>login</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    renderList();
    select("ORD-AAAAAAAAAAAAAAAAAAAAAAA1");
    try {
      await act(async () => {
        fireEvent.click(exportButton());
      });
    } finally {
      downloads.restore();
    }
    expect(downloads.names).toEqual([]);
    expect(toast.error).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
