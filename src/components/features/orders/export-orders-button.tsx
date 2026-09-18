"use client";

import { useMemo, useRef, useState } from "react";
import { DownloadIcon } from "lucide-react";

import { LoadingButton } from "@/components/ui/loading-button";
import { toast } from "@/components/ui/sonner";

import { useOrderSelection } from "./order-selection";

const EXPORT_TOAST = "orders-export";

const XLSX_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

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
 * Export the orders the operator ticked in the list, as the charging
 * workbook.
 *
 * This is a bulk action on a selection, not "download the list": with
 * nothing ticked there is nothing to export and the button says so, and
 * what goes to the server is the selected ids — never the current filters.
 * The label carries the count so it is never a question whether this
 * exports three orders or four thousand.
 */
export function ExportOrdersButton() {
  const { selected } = useOrderSelection();
  const ids = useMemo(() => Array.from(selected), [selected]);
  const [exporting, setExporting] = useState(false);
  // A second click before the first render lands must not start a second
  // download.
  const busyRef = useRef(false);

  const count = ids.length;
  const label =
    count === 0 ? "Export XLSX" : `Export ${count} order${count === 1 ? "" : "s"}`;

  async function onExport() {
    if (busyRef.current || ids.length === 0) return;
    busyRef.current = true;
    setExporting(true);
    try {
      const res = await fetch("/api/orders/export", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: XLSX_TYPE },
        body: JSON.stringify({ ids }),
      });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !type.startsWith(XLSX_TYPE)) {
        toast.error(await errorMessage(res), { id: EXPORT_TOAST });
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
      const exported = Number(res.headers.get("x-export-order-count") ?? NaN);
      const n = Number.isFinite(exported) ? exported : ids.length;
      toast.success(
        `Exported ${n.toLocaleString()} order${n === 1 ? "" : "s"} to ${link.download}`,
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
        disabled={count === 0}
        title={count === 0 ? "Select orders below to export them" : undefined}
        aria-describedby="orders-export-hint"
      >
        {label}
      </LoadingButton>
      {/* With nothing selected the reason is on screen, not only in a
          tooltip a disabled button may never show. */}
      <span
        id="orders-export-hint"
        className={
          count === 0 ? "order-first text-[12px] text-muted-foreground" : "sr-only"
        }
      >
        {count === 0
          ? "Select orders below to export them"
          : `Downloads the ${count} selected order${count === 1 ? "" : "s"} as an Excel workbook.`}
      </span>
    </>
  );
}
