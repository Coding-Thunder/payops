"use client";

import { useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { DownloadIcon } from "lucide-react";

import { LoadingButton } from "@/components/ui/loading-button";
import { toast } from "@/components/ui/sonner";

import { currentOrderFilters } from "./order-list-intent";

const EXPORT_TOAST = "orders-export";

const XLSX_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * The export endpoint takes the order list's own filters and exports every
 * order they match — all pages, not just the one on screen — so paging is
 * the only thing left out.
 */
export function exportUrlFor(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("page");
  params.delete("pageSize");
  const qs = params.toString();
  return `/api/orders/export${qs ? `?${qs}` : ""}`;
}

function filenameFrom(disposition: string | null): string {
  const match = disposition ? /filename="?([^";]+)"?/i.exec(disposition) : null;
  return match?.[1] ?? "orders.xlsx";
}

async function errorMessage(res: Response): Promise<string> {
  if (res.status === 401) {
    return "Your session has ended. Sign in again (reload the page) to export.";
  }
  let body: {
    error?: { code?: string; message?: string; details?: { retryAfterSec?: number } };
  } | null = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON — use the generic messages below.
  }
  if (res.status === 429) {
    const wait = body?.error?.details?.retryAfterSec;
    return `Too many exports in a row. Try again${wait ? ` in ${wait} seconds` : " in a minute"}.`;
  }
  if (res.status >= 500) {
    return "The export could not be created because of a server problem. Nothing was downloaded — try again in a moment.";
  }
  return body?.error?.message ?? "The export could not be created. Please try again.";
}

/**
 * "Export XLSX" on the Orders list: downloads the charging workbook for
 * exactly the orders the current filters show.
 */
export function ExportOrdersButton() {
  const params = useSearchParams();
  const [exporting, setExporting] = useState(false);
  // A second click before the first render lands must not start a second
  // download.
  const busyRef = useRef(false);

  async function onExport() {
    if (busyRef.current) return;
    busyRef.current = true;
    setExporting(true);
    try {
      // The filters just chosen, even if the list is still updating to them.
      const res = await fetch(exportUrlFor(currentOrderFilters(params.toString())), {
        credentials: "include",
        headers: { Accept: XLSX_TYPE },
      });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !type.startsWith(XLSX_TYPE)) {
        toast.error(await errorMessage(res), { id: EXPORT_TOAST });
        return;
      }
      const count = Number(res.headers.get("x-export-order-count") ?? NaN);
      if (count === 0) {
        toast.info("No orders match the current filters, so there is nothing to export.", {
          id: EXPORT_TOAST,
        });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filenameFrom(res.headers.get("content-disposition"));
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Give the browser a moment to start the download before releasing.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success(
        Number.isFinite(count)
          ? `Exported ${count.toLocaleString()} order${count === 1 ? "" : "s"} to ${link.download}`
          : `Downloaded ${link.download}`,
        // One toast for exports, replaced each time, so a burst of exports
        // does not stack over the page's own buttons.
        { id: EXPORT_TOAST },
      );
    } catch {
      toast.error(
        "The export could not be downloaded. Check your connection and try again.",
        { id: EXPORT_TOAST },
      );
    } finally {
      busyRef.current = false;
      setExporting(false);
    }
  }

  return (
    <>
      <LoadingButton
        type="button"
        variant="outline"
        onClick={onExport}
        loading={exporting}
        loadingText="Exporting"
        icon={<DownloadIcon className="size-4" />}
        aria-describedby="orders-export-hint"
      >
        Export XLSX
      </LoadingButton>
      <span id="orders-export-hint" className="sr-only">
        Downloads every order matching the current filters as an Excel workbook.
      </span>
    </>
  );
}
