import { CheckIcon, MinusIcon } from "lucide-react";

/**
 * Comparison region, infrastructure-grade tracking vs. the spreadsheet
 * + processor-dashboard status quo it replaces.
 *
 * Every row maps to one positioning pillar: traceability, evidence,
 * dispute readiness, operational visibility, payment infrastructure.
 * The contrast column names the real alternative teams live with, not
 * a strawman, so the table reads as honest, not promotional.
 */

interface Row {
  dimension: string;
  tracetxn: string;
  baseline: string;
}

const ROWS: Row[] = [
  {
    dimension: "Transaction traceability",
    tracetxn:
      "A hashed chain links every milestone to its payment ledger event.",
    baseline:
      "Orders, logs, and payouts live in separate systems; reconciliation is manual.",
  },
  {
    dimension: "Evidence generation",
    tracetxn:
      "The dispute artifact is assembled inline, exported as a bank-grade PDF.",
    baseline:
      "Evidence is gathered by hand, after the chargeback has already landed.",
  },
  {
    dimension: "Dispute readiness",
    tracetxn:
      "Consent, IP, and the full timeline are frozen at dispute time.",
    baseline:
      "Screenshots and email threads stitched together under a deadline.",
  },
  {
    dimension: "Operational visibility",
    tracetxn:
      "One canonical record, pushed realtime to every surface that reads it.",
    baseline:
      "Status lives in spreadsheets, inboxes, and someone's memory.",
  },
  {
    dimension: "Payment infrastructure",
    tracetxn:
      "Gateway-agnostic orchestration on your own keys, encrypted at rest.",
    baseline:
      "Locked to a single processor's dashboard and its export limits.",
  },
];

export function ComparisonRegion() {
  return (
    <section id="comparison" className="scroll-mt-20 pt-20 sm:pt-28">
      <div className="max-w-3xl">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
          Comparison
        </p>
        <h2 className="mt-3 font-display text-[clamp(1.7rem,3.6vw,2.6rem)] font-medium leading-[1.1] tracking-[-0.02em]">
          Infrastructure-grade tracking{" "}
          <span className="font-semibold text-[color:var(--brand-emerald)]">
            vs. basic bookkeeping.
          </span>
        </h2>
        <p className="mt-5 text-[14.5px] leading-relaxed text-muted-foreground">
          Bookkeeping records what happened. TraceTxn proves it, link by
          link, in a form the bank and the auditor can re-verify.
        </p>
      </div>

      {/* Comparison table, scrolls horizontally rather than crushing
          its three columns on narrow screens. */}
      <div className="mt-12 overflow-x-auto rounded-2xl border border-border">
        <div className="min-w-[640px]">
        {/* Header row */}
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.4fr)] border-b border-border bg-white">
          <div className="px-5 py-4" />
          <div className="border-l border-border px-5 py-4">
            <p className="font-display text-[12.5px] font-semibold tracking-tight">
              TraceTxn
            </p>
            <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[color:var(--success-strong)]">
              Payment operations
            </p>
          </div>
          <div className="border-l border-border px-5 py-4">
            <p className="font-display text-[12.5px] font-semibold tracking-tight text-muted-foreground">
              Bookkeeping + processor dashboard
            </p>
            <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
              The status quo
            </p>
          </div>
        </div>

        {/* Body rows */}
        {ROWS.map((r, i) => (
          <div
            key={r.dimension}
            className={`grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.4fr)] ${
              i < ROWS.length - 1 ? "border-b border-border" : ""
            }`}
          >
            <div className="bg-white px-5 py-5">
              <p className="text-[13px] font-medium leading-snug">
                {r.dimension}
              </p>
            </div>
            <div
              className="border-l border-border px-5 py-5"
              style={{
                background:
                  "color-mix(in oklch, var(--brand-emerald) 5%, white)",
              }}
            >
              <div className="flex items-start gap-2.5">
                <CheckIcon
                  className="mt-[2px] size-3.5 shrink-0"
                  strokeWidth={2.75}
                  style={{ color: "var(--brand-emerald)" }}
                  aria-hidden
                />
                <p className="text-[13px] leading-relaxed text-foreground/85">
                  {r.tracetxn}
                </p>
              </div>
            </div>
            <div className="border-l border-border bg-white px-5 py-5">
              <div className="flex items-start gap-2.5">
                <MinusIcon
                  className="mt-[2px] size-3.5 shrink-0 text-muted-foreground/60"
                  strokeWidth={2.75}
                  aria-hidden
                />
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  {r.baseline}
                </p>
              </div>
            </div>
          </div>
        ))}
        </div>
      </div>
    </section>
  );
}
