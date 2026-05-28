import { MarketingSection, AccentWord } from "../section";

/**
 * Workflows chapter — the self-serve onboarding story. Three steps
 * from "create workspace" to "first paid order", followed by what
 * every workspace gets out of the box.
 *
 * File path kept (`org-setups.tsx`) and section id kept (`#orgs`) so
 * the page import contract and the nav anchor don't move.
 */

const STEPS: Array<{ k: string; title: string; body: string }> = [
  {
    k: "01",
    title: "Create your workspace",
    body: "Sign up, name your business, pick a vertical template — retail, services, rental, repair, dealership, generic. The catalog seeds itself; the operator console is live.",
  },
  {
    k: "02",
    title: "Connect Stripe",
    body: "One-click test, auto-registered webhook endpoint, deep links into your Stripe dashboard. Razorpay and Authorize.net adapters slot in next.",
  },
  {
    k: "03",
    title: "Run your first order",
    body: "Catalog → order → payment link → consent → paid. Every transition recorded on the evidence chain from minute one.",
  },
];

const INCLUDED: string[] = [
  "Org-isolated data — your tenant, your records",
  "Branded customer-facing payment pages",
  "Role + permission matrix (Admin, Staff, custom)",
  "Audit-grade hashed evidence chain",
  "Hosted consent capture",
  "PDF + CSV dispute exports",
  "Realtime SSE lifecycle updates",
  "Stripe live · Razorpay + Authorize.net adapters next",
];

export function OrgSetups() {
  return (
    <MarketingSection
      id="orgs"
      theme="ultraviolet"
      eyebrow="Self-serve onboarding · live in minutes"
      title={
        <>
          Create the workspace.{" "}
          <AccentWord>Run your first order</AccentWord> before the day ends.
        </>
      }
      description="Item types, orders, evidence, and consent are universal primitives. Pick a vertical template, connect Stripe, run a real order through the lifecycle — all of it inside your tenant from the first minute."
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
          What every workspace gets
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
