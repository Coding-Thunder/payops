import { CheckIcon } from "lucide-react";

/**
 * Marketing canvas — case-file artifact.
 *
 * Static React mock that mirrors the in-app evidence document
 * (`features/evidence/evidence-chain-view.tsx`). Same skeleton, same
 * typographic rhythm — visitors see the actual product surface
 * embedded in the landing, not a stylised abstraction of it.
 *
 * Hardcoded sample data is intentional. No coupling to the product
 * components — the marketing surface should never break when the
 * authed surface evolves, and vice versa.
 */
export function CaseFileCanvas() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-[0_24px_60px_-32px_rgba(0,0,0,0.35)]">
      {/* ── Dark header band ─────────────────────────────────── */}
      <div className="border-b border-white/10 bg-[oklch(0.13_0.012_286)] px-5 py-4 text-white">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
          tracetxn · case file
        </p>
        <p className="mt-1.5 font-mono text-[14px] tracking-tight tabular-nums">
          ORD-260805-K4M9P2RT3W
        </p>
        <p className="mt-1 font-mono text-[10.5px] text-white/55 tabular-nums">
          Generated 2026-05-26 08:14:35 UTC · 9 events ·{" "}
          <span className="text-emerald-300">Integrity VALID</span>
        </p>
      </div>

      {/* ── Body: two columns ───────────────────────────────── */}
      <div className="grid grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] gap-x-8 gap-y-6 px-5 py-6">
        {/* Left: summary + timeline */}
        <div className="space-y-5">
          <div>
            <SectionLabel>Order summary</SectionLabel>
            <dl className="mt-3 divide-y divide-border/60">
              {SUMMARY_ROWS.map((r) => (
                <SummaryRow key={r.k} k={r.k} v={r.v} mono={r.mono} />
              ))}
            </dl>
          </div>

          <div>
            <SectionLabel suffix="9 events">Evidence timeline</SectionLabel>
            <ol className="mt-3 divide-y divide-border/60">
              {TIMELINE.map((e) => (
                <li
                  key={e.seq}
                  className="grid grid-cols-[1.75rem_1fr_auto_1rem] items-baseline gap-x-3 py-2"
                >
                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                    {e.seq}
                  </span>
                  <div className="min-w-0">
                    <p className="text-[12px] font-medium leading-tight">
                      {e.label}
                    </p>
                    {e.meta ? (
                      <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground leading-snug">
                        {e.meta}
                      </p>
                    ) : null}
                  </div>
                  <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">
                    {e.time}
                  </span>
                  <CheckIcon
                    className="size-3 text-success justify-self-end"
                    aria-hidden
                  />
                </li>
              ))}
            </ol>
          </div>
        </div>

        {/* Right: outcome panel — READY variant */}
        <aside className="flex flex-col">
          <SectionLabel>Outcome</SectionLabel>

          <div className="mt-4 flex flex-col gap-5">
            <div>
              <div className="flex items-baseline gap-2.5">
                <span
                  aria-hidden
                  className="inline-block size-2 rounded-full bg-success"
                />
                <p className="text-[14px] font-semibold tracking-tight text-success">
                  READY
                </p>
              </div>
              <p className="mt-1.5 max-w-[26ch] text-[11.5px] leading-relaxed text-muted-foreground">
                Evidence chain captured. This order is dispute-ready as
                of 2026-05-26 08:21:35 UTC.
              </p>
            </div>

            <div>
              <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Evidence on file
              </p>
              <dl className="mt-2.5 divide-y divide-border/60">
                {EVIDENCE_FACTS.map((f) => (
                  <div
                    key={f.k}
                    className="grid grid-cols-[1fr_auto] items-baseline gap-3 py-1.5"
                  >
                    <dt className="text-[11px] text-muted-foreground">
                      {f.k}
                    </dt>
                    <dd className="font-mono text-[10.5px] tabular-nums">
                      {f.v}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </aside>
      </div>

      {/* ── Integrity statement footer ──────────────────────── */}
      <div className="grid grid-cols-[1fr_auto] items-end gap-4 border-t border-border/70 px-5 py-4 text-[10.5px] leading-relaxed text-muted-foreground">
        <p className="max-w-[60ch]">
          <span className="font-medium text-foreground">
            Integrity statement.
          </span>{" "}
          Each of the 9 events in this case file is cryptographically
          chained against the previous one.{" "}
          <span className="text-success">Verified chain.</span>
        </p>
        <p className="font-mono tabular-nums">
          <span className="text-muted-foreground">Chain head</span>
          <span className="ml-1.5 text-foreground">a1b2c3d4e5f6…</span>
        </p>
      </div>
    </div>
  );
}

/* ─────────── sample data + primitives ────────────────────────────────── */

function SectionLabel({
  children,
  suffix,
}: {
  children: React.ReactNode;
  suffix?: string;
}) {
  return (
    <div className="flex items-baseline justify-between border-b border-border/70 pb-1.5">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {children}
      </h3>
      {suffix ? (
        <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
          {suffix}
        </span>
      ) : null}
    </div>
  );
}

function SummaryRow({
  k,
  v,
  mono,
}: {
  k: string;
  v: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-baseline gap-x-3 py-1.5">
      <dt className="text-[11px] text-muted-foreground">{k}</dt>
      <dd
        className={
          mono
            ? "font-mono text-[11px] tabular-nums break-all"
            : "text-[11.5px]"
        }
      >
        {v}
      </dd>
    </div>
  );
}

const SUMMARY_ROWS: Array<{ k: string; v: string; mono?: boolean }> = [
  { k: "Customer", v: "Talia M. Berenson" },
  { k: "Email", v: "talia.berenson@example.com", mono: true },
  { k: "Amount", v: "$2,840.00 USD", mono: true },
  { k: "Status", v: "PAID", mono: true },
  { k: "Paid", v: "2026-05-26 08:21:35 UTC", mono: true },
  { k: "Gateway", v: "Stripe", mono: true },
];

const TIMELINE: Array<{
  seq: string;
  label: string;
  meta: string | null;
  time: string;
}> = [
  {
    seq: "01",
    label: "Order created",
    meta: "Agent · Mira Holst",
    time: "08:13:35",
  },
  {
    seq: "02",
    label: "Payment link generated",
    meta: "Session cs_test_a1B2c3…",
    time: "08:13:53",
  },
  {
    seq: "03",
    label: "Payment request email sent",
    meta: "To talia.berenson@example.com",
    time: "08:14:46",
  },
  {
    seq: "04",
    label: "Consent requested",
    meta: "Token cda61ecc5b18eb96…",
    time: "08:14:35",
  },
  {
    seq: "05",
    label: "Consent received",
    meta: "Customer · IP 73.114.142.18",
    time: "08:21:22",
  },
  {
    seq: "06",
    label: "Payment completed",
    meta: "Gateway Stripe · pi_3R7kx2KZ4m…",
    time: "08:21:35",
  },
];

const EVIDENCE_FACTS: Array<{ k: string; v: string }> = [
  { k: "Hashed event chain", v: "9 events" },
  { k: "Customer consent", v: "Signed 08:21:22" },
  { k: "Email delivery", v: "2 sent · 0 failed" },
  { k: "Gateway receipt", v: "Stripe · pi_3R7kx…" },
  { k: "Customer IP capture", v: "73.114.142.18" },
  { k: "Integrity verification", v: "Valid" },
];
