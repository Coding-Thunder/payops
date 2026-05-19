import { MarketingSection, AccentWord } from "../section";

/**
 * "Trust" chapter — merges what used to be three separate sections
 * (WhyPayOps + EnterpriseChoose + AuditCompliance) into one
 * cream-toned editorial moment. The big stats up top earn the visit;
 * the bento below carries the dense substance.
 *
 * File path kept as `enterprise-choose.tsx` so the page import doesn't
 * have to be renamed — the file *content* is now the Trust section.
 */

const STATS: Array<{
  label: string;
  target: number;
  suffix: string;
  note: string;
}> = [
  {
    label: "Webhook idempotency",
    target: 100,
    suffix: "%",
    note: "every gateway event collapses to one transition",
  },
  {
    label: "Drift between surfaces",
    target: 0,
    suffix: "",
    note: "one record · realtime push + polling backstop",
  },
  {
    label: "Evidence retention",
    target: 0, // overridden visually below
    suffix: "",
    note: "paid, refunded, disputed — kept forever",
  },
];

const PILLARS: Array<{ k: string; title: string; body: string }> = [
  {
    k: "01",
    title: "Backend authority, never UI optimism",
    body: "Every badge derives from the canonical record. Dashboard, order detail, and dispute log can never disagree.",
  },
  {
    k: "02",
    title: "Append-only audit log",
    body: "Typed audit rows with actor, IP, user-agent, and metadata. Not editable, even by admins.",
  },
  {
    k: "03",
    title: "Hashed evidence chain",
    body: "Per-order events chain-hash to the previous entry. Any rewrite breaks the chain — provable to disputes and regulators.",
  },
  {
    k: "04",
    title: "Atomic webhook handling",
    body: "Idempotent, defensively ordered, conditional updates. Duplicate Stripe delivery is a no-op. Retried reconcile is a no-op.",
  },
  {
    k: "05",
    title: "Operations-grade idempotency",
    body: "Consent recorded once. Confirmation emails sent once. Refunds ratchet forward, never backward.",
  },
  {
    k: "06",
    title: "Retention by design",
    body: "Paid orders never delete. Refunded orders never delete. Risk-flagged orders persist through archive — surfaces dim, records stay.",
  },
];

export function EnterpriseChoose() {
  return (
    <MarketingSection
      id="enterprise"
      theme="cream"
      eyebrow="Trust where it matters"
      title={
        <>
          The data model{" "}
          <AccentWord>was designed for the conversation</AccentWord>{" "}
          finance has with auditors and banks.
        </>
      }
      description="Compliance isn't an export feature added later. It's the schema. Every record on PayOps was designed assuming someone might ask, two years from now, exactly what happened on a specific order."
    >
      {/* ── Hero stat strip ─────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-3">
        {STATS.map((s, i) => (
          <div
            key={s.label}
            data-reveal
            data-reveal-order={i}
            className="relative overflow-hidden rounded-2xl border p-7 backdrop-blur-sm"
            style={{
              borderColor: "var(--m-border)",
              background: "var(--m-surface-strong)",
            }}
          >
            <div
              aria-hidden
              className="pointer-events-none absolute -right-10 -top-10 size-40 rounded-full opacity-40 blur-2xl"
              style={{
                background:
                  "radial-gradient(circle, var(--m-cream-accent) 0%, transparent 70%)",
              }}
            />
            <p
              className="font-mono text-[10.5px] uppercase tracking-[0.18em]"
              style={{ color: "var(--m-eyebrow)" }}
            >
              {s.label}
            </p>
            <p className="mt-4 font-mono text-[44px] font-semibold leading-none tracking-tight">
              {i === 2 ? (
                <span>∞</span>
              ) : (
                <span
                  data-counter={s.target}
                  data-counter-suffix={s.suffix}
                >
                  0{s.suffix}
                </span>
              )}
            </p>
            <p
              className="mt-3 text-[12.5px] leading-relaxed"
              style={{ color: "var(--m-fg-soft)" }}
            >
              {s.note}
            </p>
          </div>
        ))}
      </div>

      {/* ── Pillars bento ───────────────────────────────────────── */}
      <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {PILLARS.map((p, i) => (
          <div
            key={p.k}
            data-reveal
            data-reveal-order={i % 3}
            className="group relative overflow-hidden rounded-2xl border p-7 transition-transform hover:-translate-y-px"
            style={{
              borderColor: "var(--m-border)",
              background: "var(--m-surface)",
            }}
          >
            <span
              aria-hidden
              className="absolute inset-x-0 top-0 h-px opacity-0 transition-opacity group-hover:opacity-100"
              style={{
                background:
                  "linear-gradient(90deg, transparent 0%, var(--m-cream-accent) 50%, transparent 100%)",
              }}
            />
            <p
              className="font-mono text-[11px] uppercase tracking-[0.18em]"
              style={{ color: "var(--m-eyebrow)" }}
            >
              {p.k}
            </p>
            <h3 className="mt-3 text-[16.5px] font-semibold tracking-tight">
              {p.title}
            </h3>
            <p
              className="mt-2.5 text-[13px] leading-relaxed"
              style={{ color: "var(--m-fg-soft)" }}
            >
              {p.body}
            </p>
          </div>
        ))}
      </div>
    </MarketingSection>
  );
}
