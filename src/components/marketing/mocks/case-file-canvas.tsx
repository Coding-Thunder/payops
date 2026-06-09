import { CheckIcon, ShieldIcon, TrophyIcon } from "lucide-react";

/**
 * Case-file canvas, the WON variant.
 *
 * Static React mock that mirrors the reference's "CHARGEBACK SOLVED"
 * artifact layout, point-for-point:
 *   - Dark navy header band with document metadata
 *   - Two tall rounded white panels side-by-side
 *   - Left: chain-integrity pill, ORDER SUMMARY grid, EVIDENCE
 *     TIMELINE with bold numbered green ring nodes connected by a
 *     thick green vertical line, integrity statement footer
 *   - Right: CHARGEBACK OUTCOME (dark header) over a big green
 *     CASE WON panel, key facts, WHY WE WON checklist, "case
 *     closed" callout
 *
 * Hardcoded sample data. No coupling to authed components.
 */

const TIMELINE: Array<{
  seq: number;
  label: string;
  sub: string | null;
  time: string;
}> = [
  { seq: 1, label: "Order created", sub: "Agent · Mira Holst", time: "22:13:35" },
  {
    seq: 2,
    label: "Payment gateway selected",
    sub: "Agent · Mira Holst",
    time: "22:13:53",
  },
  {
    seq: 3,
    label: "Payment link generated",
    sub: "Session cs_test_a1B2c3… · Intent pi_3R7kx2KZ4m…",
    time: "22:13:53",
  },
  {
    seq: 4,
    label: "Payment request email sent",
    sub: "To talia.berenson@example.com",
    time: "22:14:46",
  },
  {
    seq: 5,
    label: "Consent requested",
    sub: "Token cda61ecc5b18eb96…",
    time: "22:14:35",
  },
  {
    seq: 6,
    label: "Consent received",
    sub: "Customer · Talia M. Berenson · IP 73.114.142.18",
    time: "22:21:22",
  },
  {
    seq: 7,
    label: "Payment completed",
    sub: "Gateway Stripe · Intent pi_3R7kx2KZ4m…",
    time: "22:21:35",
  },
  {
    seq: 8,
    label: "Confirmation email sent",
    sub: "To talia.berenson@example.com",
    time: "22:21:35",
  },
  { seq: 9, label: "Order confirmed", sub: "System", time: "22:21:35" },
];

const WHY_WE_WON = [
  "Complete end-to-end transaction trail",
  "Customer consent on file",
  "Payment successfully completed",
  "Email communication verified",
  "Immutable evidence with integrity proof",
];

export function CaseFileCanvas() {
  return (
    <div
      className="relative overflow-hidden rounded-2xl shadow-[0_30px_80px_-40px_rgba(15,40,80,0.35)]"
      style={{ background: "oklch(0.97 0.005 240)" }}
    >
      {/* ── Dark navy header band ─────────────────────────────── */}
      <header
        className="relative border-b border-white/10 px-6 py-7 text-white sm:px-8"
        style={{ background: "var(--ink-navy)" }}
      >
        <p className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-white/55">
          TraceTxn · case file
        </p>
        <p className="mt-2 font-mono text-[16px] tracking-tight tabular-nums">
          ORD-260805-K4M9P2RT3W
        </p>
        <p className="mt-1.5 font-mono text-[11.5px] text-white/60 tabular-nums">
          Generated 2026-05-26 08:14:35 UTC · 9 events ·{" "}
          <span style={{ color: "oklch(0.78 0.18 148)" }}>
            Integrity VALID
          </span>
        </p>
      </header>

      {/* ── Two-column body ───────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-5 p-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:p-7">
        {/* ── LEFT PANEL: order evidence ──────────────────────── */}
        <div className="rounded-xl bg-card p-5 ring-1 ring-border/70 sm:p-6">
          <h2 className="text-[16px] font-semibold tracking-tight">
            Order evidence -{" "}
            <span className="font-mono tabular-nums">
              ORD-260805-K4M9P2RT3W
            </span>
          </h2>

          <ChainPill />

          {/* ORDER SUMMARY */}
          <SectionLabel>Order summary</SectionLabel>
          <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-5">
            <SummaryCell label="Customer" value="Talia M. Berenson" />
            <SummaryCell label="Amount" value="$2,840.00 USD" mono />
            <SummaryCell label="Status" value={<PaidPill />} />
            <SummaryCell label="Provider" value="Budget" />
            <SummaryCell
              label="Vehicle"
              value="Toyota Camry XLE 2025"
            />
          </div>

          {/* TIMELINE */}
          <div className="mt-7">
            <div className="flex items-baseline justify-between">
              <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Evidence timeline
              </p>
              <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
                (9 events)
              </span>
            </div>

            <ol className="relative mt-4">
              {/* Vertical green connector line behind the nodes */}
              <span
                aria-hidden
                className="pointer-events-none absolute left-[0.875rem] top-3 bottom-3 w-[2.5px] rounded-full"
                style={{ background: "var(--success)" }}
              />
              {TIMELINE.map((e) => (
                <li
                  key={e.seq}
                  className="relative grid grid-cols-[1.75rem_1fr_auto_1rem] items-start gap-x-3 py-2"
                >
                  <span
                    className="relative z-10 grid size-7 place-items-center rounded-full text-[11px] font-semibold text-white"
                    style={{ background: "var(--success)" }}
                  >
                    {e.seq}
                  </span>
                  <div className="pt-1 min-w-0">
                    <p className="text-[13px] font-semibold leading-tight">
                      {e.label}
                    </p>
                    {e.sub ? (
                      <p className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground">
                        {e.sub}
                      </p>
                    ) : null}
                  </div>
                  <span className="pt-1 font-mono text-[11px] text-muted-foreground tabular-nums">
                    {e.time}
                  </span>
                  <CheckIcon
                    className="mt-2 size-3.5 justify-self-end text-success"
                    strokeWidth={2.5}
                  />
                </li>
              ))}
            </ol>
          </div>

          {/* Integrity callout */}
          <div
            className="mt-6 grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg border px-4 py-3"
            style={{ borderColor: "var(--success-border)" }}
          >
            <ShieldIcon
              className="size-5 text-success"
              strokeWidth={2}
            />
            <div>
              <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-success-strong">
                Evidence integrity
              </p>
              <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                Each event is cryptographically chained. Any tampering
                would break the chain.
              </p>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <span
                className="inline-flex items-center rounded-md px-2 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.16em] text-white"
                style={{ background: "var(--success)" }}
              >
                VALID
              </span>
              <span className="inline-flex items-center gap-1 text-[10.5px] text-success-strong">
                <CheckIcon className="size-3" strokeWidth={3} />
                Chain verified
              </span>
            </div>
          </div>
        </div>

        {/* ── RIGHT PANEL: chargeback outcome ─────────────────── */}
        <aside className="space-y-4">
          {/* Header strip */}
          <div
            className="overflow-hidden rounded-t-xl px-5 py-3 text-white"
            style={{ background: "var(--ink-navy)" }}
          >
            <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.18em] text-white/65">
              Chargeback outcome
            </p>
          </div>

          {/* Big GREEN CASE WON panel */}
          <div
            className="-mt-4 grid grid-cols-[auto_1fr] items-center gap-4 rounded-b-xl px-5 py-5 text-white shadow-[0_18px_44px_-20px_oklch(0.62_0.17_148_/_0.45)]"
            style={{ background: "var(--success)" }}
          >
            <span className="grid size-12 place-items-center rounded-full bg-white/20 ring-2 ring-white/70">
              <CheckIcon className="size-6 text-white" strokeWidth={3} />
            </span>
            <div>
              <p className="text-[20px] font-bold leading-tight tracking-tight">
                CASE WON
              </p>
              <p className="mt-1 text-[12.5px] leading-snug text-white/85">
                Chargeback reversed in your favor
              </p>
            </div>
          </div>

          {/* Outcome facts grid */}
          <div className="rounded-xl bg-card p-5 ring-1 ring-border/70">
            <OutcomeRow label="Reason code" value="13.1, Merchandise/Service Not Received" />
            <OutcomeRow label="Received" value="2026-05-05" mono />
            <OutcomeRow label="Represented" value="2026-05-07" mono />
            <OutcomeRow label="Decision" value="2026-05-21" mono />
            <OutcomeRow label="Outcome" value="Won, Reversed" toned />
            <OutcomeRow
              label="Recovered amount"
              value="$2,840.00 USD"
              mono
              recovered
            />
          </div>

          {/* WHY WE WON */}
          <div className="rounded-xl bg-card p-5 ring-1 ring-border/70">
            <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Why we won
            </p>
            <ul className="mt-3 space-y-2.5">
              {WHY_WE_WON.map((reason) => (
                <li
                  key={reason}
                  className="grid grid-cols-[auto_1fr] items-baseline gap-2.5 text-[12.5px]"
                >
                  <CheckIcon
                    className="mt-[3px] size-3.5 shrink-0 text-success"
                    strokeWidth={2.5}
                  />
                  <span className="leading-snug">{reason}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Case closed callout */}
          <div
            className="grid grid-cols-[auto_1fr] gap-3 rounded-xl px-4 py-3.5"
            style={{
              background: "var(--success-soft)",
              border: "1px solid var(--success-border)",
            }}
          >
            <TrophyIcon
              className="size-5 text-amber-500"
              style={{ color: "oklch(0.75 0.16 78)" }}
              strokeWidth={2}
            />
            <div>
              <p className="text-[12.5px] font-semibold text-success-strong">
                This case is now closed.
              </p>
              <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                Funds have been returned to your account.
              </p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ─── primitives ──────────────────────────────────────────────────── */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-6 mb-3 inline-flex items-center gap-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
      <span aria-hidden className="text-success">
        ▣
      </span>
      {children}
    </p>
  );
}

function ChainPill() {
  return (
    <span
      className="mt-4 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium"
      style={{
        background: "var(--success-soft)",
        color: "var(--success-strong)",
        border: "1px solid var(--success-border)",
      }}
    >
      <CheckIcon className="size-3" strokeWidth={3} />
      Chain integrity verified
    </span>
  );
}

function SummaryCell({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </p>
      <div className={`mt-1 text-[12.5px] ${mono ? "font-mono tabular-nums" : ""}`}>
        {value}
      </div>
    </div>
  );
}

function PaidPill() {
  return (
    <span
      className="inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em]"
      style={{
        background: "var(--success-soft)",
        color: "var(--success-strong)",
        border: "1px solid var(--success-border)",
      }}
    >
      PAID
    </span>
  );
}

function OutcomeRow({
  label,
  value,
  mono,
  toned,
  recovered,
}: {
  label: string;
  value: string;
  mono?: boolean;
  toned?: boolean;
  recovered?: boolean;
}) {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-baseline gap-3 border-b border-border/60 py-2 last:border-b-0">
      <dt className="text-[11.5px] text-muted-foreground">{label}</dt>
      <dd
        className={`text-[12.5px] ${
          mono ? "font-mono tabular-nums" : ""
        } ${toned || recovered ? "font-semibold" : ""}`}
        style={
          recovered
            ? { color: "var(--success-strong)" }
            : toned
              ? { color: "var(--success-strong)" }
              : undefined
        }
      >
        {value}
      </dd>
    </div>
  );
}
