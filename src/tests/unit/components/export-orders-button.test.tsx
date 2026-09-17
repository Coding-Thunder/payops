import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("@/components/ui/sonner", () => ({ toast }));

let search = "status=PAID&q=ada&page=3&pageSize=20";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
}));

import {
  ExportOrdersButton,
  exportUrlFor,
} from "@/components/features/orders/export-orders-button";

/**
 * The Orders list had no way to reach the XLSX export. The button sends the
 * list's own filters to the existing endpoint and downloads what comes back.
 */

const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

beforeEach(() => {
  search = "status=PAID&q=ada&page=3&pageSize=20";
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

describe("exportUrlFor", () => {
  it("keeps the filters and drops paging", () => {
    expect(exportUrlFor("status=PAID&q=ada&page=3&pageSize=20")).toBe(
      "/api/orders/export?status=PAID&q=ada",
    );
    expect(exportUrlFor("")).toBe("/api/orders/export");
  });
});

describe("ExportOrdersButton", () => {
  it("downloads the workbook for the current filters", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          status: 200,
          headers: {
            "content-type": XLSX,
            "content-disposition": 'attachment; filename="payops-charges-20260916.xlsx"',
            "x-export-order-count": "2",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const clicks: string[] = [];
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      clicks.push(this.download);
    };
    try {
      render(<ExportOrdersButton />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /export xlsx/i }));
      });
    } finally {
      HTMLAnchorElement.prototype.click = origClick;
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      "/api/orders/export?status=PAID&q=ada",
    );
    expect(clicks).toEqual(["payops-charges-20260916.xlsx"]);
    expect(toast.success).toHaveBeenCalled();
  });

  it("starts one export however fast the button is clicked", async () => {
    let release: (r: Response) => void = () => {};
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ExportOrdersButton />);
    const button = screen.getByRole("button", { name: /export xlsx/i });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Loading state while the workbook is built.
    expect(screen.getByRole("button")).toHaveAttribute("aria-busy", "true");
    await act(async () => {
      release(new Response("{}", { status: 500, headers: { "content-type": "application/json" } }));
    });
  });

  it("shows the server's reason when the export is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: { code: "VALIDATION_ERROR", message: "Narrow the date range and try again." },
            }),
            { status: 422, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    render(<ExportOrdersButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /export xlsx/i }));
    });
    expect(toast.error).toHaveBeenCalledWith(
      "Narrow the date range and try again.",
      expect.anything(),
    );
  });

  it("does not treat a non-workbook reply as a download", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } })),
    );
    render(<ExportOrdersButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /export xlsx/i }));
    });
    expect(toast.error).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("says there is nothing to export when no orders match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([0x50, 0x4b]), {
            status: 200,
            headers: { "content-type": XLSX, "x-export-order-count": "0" },
          }),
      ),
    );
    const clicks: string[] = [];
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      clicks.push(this.download);
    };
    try {
      render(<ExportOrdersButton />);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /export xlsx/i }));
      });
    } finally {
      HTMLAnchorElement.prototype.click = origClick;
    }
    expect(clicks).toEqual([]);
    expect(toast.info).toHaveBeenCalled();
  });

  it("uses the filters just chosen, even before the list has updated", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("{}", { status: 500, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { setIntendedOrderFilters } = await import(
      "@/components/features/orders/order-list-intent"
    );
    setIntendedOrderFilters("q=new-search&status=FAILED");
    render(<ExportOrdersButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /export xlsx/i }));
    });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(
      "/api/orders/export?q=new-search&status=FAILED",
    );
    // A server failure says so, rather than "something went wrong".
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/server problem/),
      expect.anything(),
    );
    const { settleOrderFilters } = await import(
      "@/components/features/orders/order-list-intent"
    );
    settleOrderFilters("q=new-search&status=FAILED");
  });

  it("tells the operator how long to wait when rate limited", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ ok: false, error: { code: "RATE_LIMITED", message: "x", details: { retryAfterSec: 42 } } }),
            { status: 429, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    render(<ExportOrdersButton />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /export xlsx/i }));
    });
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringMatching(/42 seconds/),
      expect.anything(),
    );
  });
});

describe("order-list intent", () => {
  it("is dropped once the page moves to other filters", async () => {
    const intent = await import("@/components/features/orders/order-list-intent");
    intent.resetOrderFilters("status=PAID");
    intent.setIntendedOrderFilters("status=FAILED");
    expect(intent.currentOrderFilters("status=PAID")).toBe("status=FAILED");
    // The operator navigated elsewhere before the change applied.
    intent.settleOrderFilters("q=other");
    expect(intent.currentOrderFilters("q=other")).toBe("q=other");
  });
});
