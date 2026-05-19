import { MarketingSection, AccentWord } from "../section";

/**
 * Deployment chapter — reframes the old "OrgSetups" section as the
 * private-deployment story. Ultraviolet wash for "exclusive,
 * premium" rather than "we don't have signup". File name kept so the
 * page import contract doesn't need to move.
 */

const STEPS: Array<{ k: string; title: string; body: string }> = [
  {
    k: "01",
    title: "Quotation",
    body: "Share volume, current stack, and gateway preferences. We respond within one business day with a scoped proposal.",
  },
  {
    k: "02",
    title: "Customisation",
    body: "Branding, policy snapshots, role matrix, gateway routing — configured to your org before the first deploy.",
  },
  {
    k: "03",
    title: "Private deployment",
    body: "Provisioned on a domain you own. Reserved for one merchant per instance. No shared tenant, no public sign-up.",
  },
];

const INCLUDED: string[] = [
  "Branded customer-facing pages",
  "Role + permission matrix to your spec",
  "Gateway adapters (Stripe live, others on demand)",
  "Audit-grade evidence chain",
  "Hosted consent flow",
  "PDF + CSV dispute exports",
  "Realtime SSE — single instance ready",
  "DigitalOcean / GCP / AWS targets",
];

export function OrgSetups() {
  return (
    <MarketingSection
      id="orgs"
      theme="ultraviolet"
      eyebrow="Privately deployed · reserved per merchant"
      title={
        <>
          Not shrink-wrap SaaS. A{" "}
          <AccentWord>managed deployment</AccentWord> sized to your stack.
        </>
      }
      description="PayOps is reserved for one merchant per instance. After quotation, your deployment is scoped, branded, and provisioned on a domain you own — not a tenant on someone else's cluster."
    >
      {/* ── Step diagram ────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-3">
        {STEPS.map((s, i) => (
          <div
            key={s.k}
            data-reveal
            data-reveal-order={i}
            className="group relative overflow-hidden rounded-2xl border p-7 backdrop-blur-sm transition-transform hover:-translate-y-px"
            style={{
              borderColor: "var(--m-border)",
              background: "var(--m-surface-strong)",
            }}
          >
            <div
              aria-hidden
              className="pointer-events-none absolute -right-10 -top-10 size-32 rounded-full opacity-30 blur-2xl transition-opacity group-hover:opacity-60"
              style={{
                background:
                  "radial-gradient(circle, var(--m-ultraviolet) 0%, transparent 70%)",
              }}
            />
            <p
              className="font-mono text-[11px] uppercase tracking-[0.18em]"
              style={{ color: "var(--m-eyebrow)" }}
            >
              {s.k}
            </p>
            <h3 className="mt-4 text-[20px] font-semibold tracking-tight">
              {s.title}
            </h3>
            <p
              className="mt-2.5 text-[13.5px] leading-relaxed"
              style={{ color: "var(--m-fg-soft)" }}
            >
              {s.body}
            </p>
            {i < STEPS.length - 1 ? (
              <span
                aria-hidden
                className="absolute right-5 top-7 hidden text-[22px] lg:block"
                style={{ color: "var(--m-eyebrow)" }}
              >
                →
              </span>
            ) : null}
          </div>
        ))}
      </div>

      {/* ── Included strip ──────────────────────────────────────── */}
      <div
        data-reveal
        data-reveal-order={3}
        className="mt-12 rounded-2xl border p-7 backdrop-blur-sm"
        style={{
          borderColor: "var(--m-border)",
          background: "var(--m-surface)",
        }}
      >
        <p
          className="font-mono text-[10.5px] uppercase tracking-[0.18em]"
          style={{ color: "var(--m-eyebrow)" }}
        >
          Included with every deployment
        </p>
        <ul className="mt-5 grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {INCLUDED.map((it) => (
            <li key={it} className="flex items-start gap-2.5 text-[13px]">
              <span
                aria-hidden
                className="mt-1.5 size-1.5 shrink-0 rounded-full"
                style={{ background: "var(--m-ultraviolet)" }}
              />
              {it}
            </li>
          ))}
        </ul>
      </div>
    </MarketingSection>
  );
}
