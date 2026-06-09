import {
  ActivityIcon,
  GavelIcon,
  GitBranchIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  WalletIcon,
} from "lucide-react";

/**
 * Features region, the high-altitude capability map.
 *
 * Six cards, one per operational dimension the rest of the document
 * then proves in depth (Evidence case file, Integrity schema, Gateways
 * interface). Deliberately terse, this is the index, not the deep
 * dive, so it never duplicates the regions below it. Every card names
 * a concrete, shipped capability, no roadmap language.
 */

interface Feature {
  icon: React.ComponentType<{ className?: string }>;
  eyebrow: string;
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    icon: ShieldCheckIcon,
    eyebrow: "Evidence",
    title: "Hashed evidence chain per order",
    body: "Every transition appends a SHA-256-linked event. When a chargeback lands weeks later, the dispute artifact is already built, exportable as a bank-grade PDF.",
  },
  {
    icon: GitBranchIcon,
    eyebrow: "Traceability",
    title: "Every milestone anchored to the ledger",
    body: "Order, link, consent, payment, refund, each stage links to the canonical chain. No transaction floats free of the event that produced it.",
  },
  {
    icon: ScrollTextIcon,
    eyebrow: "Auditability",
    title: "Append-only audit log",
    body: "Typed rows carry actor, IP, user-agent, and metadata. Not editable, even by admins. The record an auditor or bank can re-verify on demand.",
  },
  {
    icon: WalletIcon,
    eyebrow: "Payment operations",
    title: "Gateway-agnostic orchestration",
    body: "Connect your own Stripe in 60 seconds, your keys encrypted at rest. Routing, webhooks, and reconciliation run through one contract per provider.",
  },
  {
    icon: GavelIcon,
    eyebrow: "Dispute readiness",
    title: "Consent captured before the charge",
    body: "Hosted, token-bound consent freezes IP, user-agent, and signed name onto the chain, the strongest signal a card network reads in a dispute.",
  },
  {
    icon: ActivityIcon,
    eyebrow: "Operational intelligence",
    title: "Realtime canonical record",
    body: "SSE push the moment a webhook fires, polling backstop behind it. Reason-code analytics surface why losses happen, not just that they did.",
  },
];

export function FeaturesRegion() {
  return (
    <section
      id="features"
      className="scroll-mt-20 -mx-6 lg:-mx-10 px-6 lg:px-10 py-20 sm:py-24 mt-20 sm:mt-28"
      style={{ background: "var(--background)" }}
    >
      <div className="mx-auto max-w-[1280px]">
        {/* Header */}
        <div className="max-w-3xl">
          <p className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-3 py-1 font-display text-[10.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ background: "var(--brand-emerald)" }}
            />
            Features
          </p>
          <h2 className="mt-6 font-display text-[clamp(1.8rem,4vw,2.8rem)] font-medium leading-[1.08] tracking-[-0.022em]">
            Core features built for{" "}
            <span className="font-semibold text-[color:var(--brand-emerald)]">
              high-signal operations.
            </span>
          </h2>
          <p className="mt-5 max-w-xl text-[14.5px] leading-relaxed text-muted-foreground">
            Six capabilities, every one of them shipped. The sections below
            walk each in depth, this is the map.
          </p>
        </div>

        {/* Feature grid */}
        <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <FeatureCard key={f.title} feature={f} />
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureCard({ feature }: { feature: Feature }) {
  const Icon = feature.icon;
  return (
    <div className="rounded-2xl border border-border bg-white p-6">
      <div className="flex items-center gap-3">
        <span
          className="inline-flex size-10 items-center justify-center rounded-lg"
          style={{
            background:
              "color-mix(in oklch, var(--brand-emerald) 12%, white)",
            color: "var(--brand-emerald-strong)",
          }}
        >
          <Icon className="size-5" />
        </span>
        <span className="font-display text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {feature.eyebrow}
        </span>
      </div>
      <h3 className="mt-4 font-display text-[16px] font-semibold tracking-tight">
        {feature.title}
      </h3>
      <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
        {feature.body}
      </p>
    </div>
  );
}
