import Link from "next/link";
import { ArrowLeftIcon, DownloadIcon } from "lucide-react";

import { formatUtcTimestamp } from "@/lib/format";

/**
 * Dark header band at the top of the evidence case file.
 *
 * Designed to read as the cover sheet of an exported document — not
 * an app page header. Wordmark + case ref on the left, document
 * metadata in the center, single muted export action on the right.
 * No call-to-action buttons; the export is a small inline link, not
 * a primary CTA.
 *
 * Stays visually intact in print mode so the in-app and PDF versions
 * share the same identity.
 */

interface CaseFileHeaderProps {
  orderId: string;
  orderNumber: string;
  generatedAt: string;
  eventCount: number;
  integrityValid: boolean;
  canExport: boolean;
}

export function CaseFileHeader({
  orderId,
  orderNumber,
  generatedAt,
  eventCount,
  integrityValid,
  canExport,
}: CaseFileHeaderProps) {
  const exportHref = `/app/orders/${orderId}/evidence/export`;

  return (
    <header className="border-b border-white/10 bg-[oklch(0.13_0.012_286)] text-white print:border-b print:border-[oklch(0.13_0.012_286)] print:bg-white print:text-[oklch(0.13_0.012_286)]">
      {/* Top utility row — back to order, no chrome */}
      <div className="border-b border-white/5 px-8 py-2.5 print:hidden">
        <Link
          href={`/app/orders/${orderId}`}
          className="inline-flex items-center gap-1.5 text-[12px] text-white/55 transition-colors hover:text-white/90"
        >
          <ArrowLeftIcon className="size-3" />
          Back to order
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-6 px-8 py-7 sm:grid-cols-[1fr_auto] sm:items-center">
        <div className="space-y-2">
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-[12px] uppercase tracking-[0.18em] text-white/55">
              tracetxn · case file
            </span>
          </div>
          <h1 className="font-mono text-[18px] font-medium tracking-tight tabular-nums">
            {orderNumber}
          </h1>
          <p className="font-mono text-[11.5px] text-white/55 tabular-nums">
            Generated {formatUtcTimestamp(generatedAt)} · {eventCount}{" "}
            {eventCount === 1 ? "event" : "events"}
            {" · "}
            <span
              className={
                integrityValid ? "text-emerald-300" : "text-rose-300"
              }
            >
              Integrity {integrityValid ? "VALID" : "BROKEN"}
            </span>
          </p>
        </div>

        {canExport ? (
          <a
            href={exportHref}
            download={`case-file-${orderNumber}.pdf`}
            className="inline-flex items-center gap-2 self-start justify-self-start rounded-md border border-white/15 px-3.5 py-2 text-[12px] font-medium text-white/85 transition-colors hover:border-white/30 hover:text-white sm:self-auto sm:justify-self-end print:hidden"
          >
            <DownloadIcon className="size-3.5" />
            Export PDF
          </a>
        ) : null}
      </div>
    </header>
  );
}
