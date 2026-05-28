import { MarketingSection, AccentWord } from "../section";

/**
 * Trust chapter — editorial long-form instead of 6-card grid.
 *
 * Reads as a written argument with a focal stat strip up top and six
 * footnoted pillars below. The pillars sit in a two-column long-form
 * list (margin-mono index + body paragraph), not perfect 3×2 cards.
 * One pillar is intentionally lifted to read as the section's anchor
 * point — the rest support it.
 *
 * Same content from the prior pillars, recomposed away from the
 * "identical card syndrome" pattern.
 */

interface Pillar {
  k: string;
  title: string;
  body: string;
}

const ANCHOR: Pillar = {
  k: "00",
  title: "Compliance isn't an export feature. It's the schema.",
  body: "Every record TraceTxn writes is shaped for the conversation finance has with auditors and banks. The data model carries actor identity, request context, hash linkage, and immutability proofs — not as a reporting layer, but as the storage primitives themselves.",
};

const PILLARS: Pillar[] = [
  {
    k: "01",
    title: "Backend authority, never UI optimism",
    body: "Every status badge derives from the canonical record. The dashboard, the order detail, and the dispute log read the same row at the same time.",
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

const STATS: Array<{ label: string; value: string; note: string }> = [
  {
    label: "Webhook idempotency",
    value: "100%",
    note: "Every gateway event collapses to one transition.",
  },
  {
    label: "Drift between surfaces",
    value: "0",
    note: "One record · realtime push + polling backstop.",
  },
  {
    label: "Evidence retention",
    value: "∞",
    note: "Paid, refunded, disputed — kept forever.",
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
      description="Compliance is not added on. It is the schema. Every record TraceTxn writes assumes someone might ask, two years from now, exactly what happened on a specific order."
    >
      {/* ── Focal stat strip — flat, borderless, typographic only ─── */}
      <dl
        data-reveal
        data-reveal-order={0}
        className="grid grid-cols-1 gap-y-6 border-y py-7 sm:grid-cols-3 sm:gap-x-10"
        style={{ borderColor: "var(--m-border)" }}
      >
        {STATS.map((s, i) => (
          <div
            key={s.label}
            data-reveal
            data-reveal-order={i}
            className="space-y-1.5"
          >
            <dt
              className="text-[11px] font-medium uppercase tracking-[0.14em]"
              style={{ color: "var(--m-eyebrow)" }}
            >
              {s.label}
            </dt>
            <dd className="font-mono text-[40px] font-semibold leading-none tracking-tight tabular-nums">
              {s.value}
            </dd>
            <p
              className="max-w-[34ch] text-[12.5px] leading-relaxed"
              style={{ color: "var(--m-fg-soft)" }}
            >
              {s.note}
            </p>
          </div>
        ))}
      </dl>

      {/* ── Anchor pillar (lifted) ──────────────────────────────── */}
      <div
        data-reveal
        data-reveal-order={1}
        className="mt-16 grid grid-cols-[3rem_1fr] items-baseline gap-x-4"
      >
        <span
          className="font-mono text-[12px] tabular-nums"
          style={{ color: "var(--m-eyebrow)" }}
        >
          {ANCHOR.k}
        </span>
        <div>
          <h3 className="text-balance text-[22px] sm:text-[26px] font-semibold leading-[1.18] tracking-[-0.015em]">
            {ANCHOR.title}
          </h3>
          <p
            className="mt-4 max-w-[58ch] text-[15px] leading-relaxed"
            style={{ color: "var(--m-fg-soft)" }}
          >
            {ANCHOR.body}
          </p>
        </div>
      </div>

      {/* ── Six pillars — two-column footnoted list ─────────────── */}
      <div
        className="mt-14 grid grid-cols-1 gap-x-12 gap-y-10 border-t pt-12 md:grid-cols-2"
        style={{ borderColor: "var(--m-border)" }}
      >
        {PILLARS.map((p, i) => (
          <div
            key={p.k}
            data-reveal
            data-reveal-order={i % 4}
            className="grid grid-cols-[2.5rem_1fr] items-baseline gap-x-3"
          >
            <span
              className="font-mono text-[11px] tabular-nums"
              style={{ color: "var(--m-eyebrow)" }}
            >
              {p.k}
            </span>
            <div>
              <h4 className="text-[14.5px] font-semibold tracking-tight">
                {p.title}
              </h4>
              <p
                className="mt-1.5 text-[13.5px] leading-relaxed"
                style={{ color: "var(--m-fg-soft)" }}
              >
                {p.body}
              </p>
            </div>
          </div>
        ))}
      </div>
    </MarketingSection>
  );
}
