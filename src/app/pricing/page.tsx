import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon, CheckIcon, MinusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BrandCtaStrip } from "@/components/marketing/brand-cta-strip";
import { BrandFooter } from "@/components/marketing/brand-footer";
import { BrandNav } from "@/components/marketing/brand-nav";

export const metadata: Metadata = {
  title: "Pricing — Starter, Growth, Scale",
  description:
    "TraceTxn pricing — three tiers from $39/month. Full evidence chain, audit trail, lifecycle tracking, and PDF export on every plan. Anchored against $500-$1,000/month enterprise dispute tools.",
  alternates: { canonical: "/pricing" },
};

/* ─────────────────────────── Tier content ────────────────────────────
 * Pricing numbers sourced from pricing-v1 memory (co-founder, 2026-05-31).
 * Do NOT invent alternative tiers or change gating without checking
 * with the user.
 * ────────────────────────────────────────────────────────────────── */

interface Tier {
  name: string;
  price: number;
  cadence: string;
  blurb: string;
  ordersLabel: string;
  usersLabel: string;
  highlights: string[];
  ctaLabel: string;
  ctaHref: string;
  recommended?: boolean;
}

const TIERS: Tier[] = [
  {
    name: "Starter",
    price: 39,
    cadence: "per month",
    blurb:
      "Everything a solo operator needs to take payments and resolve disputes — without an enterprise contract.",
    ordersLabel: "Up to 30 active orders at a time",
    usersLabel: "Solo operator",
    highlights: [
      "Hashed evidence chain on every order",
      "Full audit trail + payment lifecycle tracking",
      "PDF receipt + invoice export",
      "Hosted consent flow for dispute defence",
      "Per-org Stripe connect — your keys encrypted",
    ],
    ctaLabel: "Start with Starter",
    ctaHref: "/signup",
  },
  {
    name: "Growth",
    price: 99,
    cadence: "per month",
    blurb:
      "The conversion tier — 5–10× cheaper than enterprise dispute tools for the same core need.",
    ordersLabel: "Up to 150 active orders at a time",
    usersLabel: "Up to 3 team members",
    highlights: [
      "Everything in Starter",
      "Webhook delivery monitoring",
      "Reason-code analytics + dispute trends",
      "Priority email support",
      "Configurable order workflows",
      "Custom branding on payment + consent pages",
    ],
    ctaLabel: "Start with Growth",
    ctaHref: "/signup",
    recommended: true,
  },
  {
    name: "Scale",
    price: 249,
    cadence: "per month",
    blurb:
      "For teams where one won dispute per month more than covers the cost. Immediate ROI.",
    ordersLabel: "Unlimited orders",
    usersLabel: "Unlimited team members",
    highlights: [
      "Everything in Growth",
      "Full analytics suite",
      "API access for custom integrations",
      "Custom branding on PDF evidence exports",
      "Dedicated onboarding session",
      "SLA-backed support",
    ],
    ctaLabel: "Start with Scale",
    ctaHref: "/signup",
  },
];

/* Side-by-side feature matrix — quick comparison without re-listing
 * the bullets above. ✓ / "—" only; no "Coming soon" weasel-words. */
interface MatrixRow {
  label: string;
  starter: boolean | string;
  growth: boolean | string;
  scale: boolean | string;
}

const MATRIX: MatrixRow[] = [
  { label: "Active orders at a time", starter: "30", growth: "150", scale: "Unlimited" },
  { label: "Team members", starter: "Solo operator", growth: "Up to 3", scale: "Unlimited" },
  { label: "Hashed evidence chain", starter: true, growth: true, scale: true },
  { label: "Audit trail", starter: true, growth: true, scale: true },
  { label: "Payment lifecycle tracking", starter: true, growth: true, scale: true },
  { label: "PDF invoice + receipt export", starter: true, growth: true, scale: true },
  { label: "Hosted consent flow", starter: true, growth: true, scale: true },
  { label: "Per-org Stripe connect", starter: true, growth: true, scale: true },
  { label: "Webhook monitoring", starter: false, growth: true, scale: true },
  { label: "Reason-code analytics", starter: false, growth: true, scale: true },
  { label: "Configurable workflows", starter: false, growth: true, scale: true },
  { label: "Custom-branded payment pages", starter: false, growth: true, scale: true },
  { label: "Full analytics suite", starter: false, growth: false, scale: true },
  { label: "API access", starter: false, growth: false, scale: true },
  { label: "Custom-branded PDF evidence", starter: false, growth: false, scale: true },
  { label: "Dedicated onboarding", starter: false, growth: false, scale: true },
  { label: "Support", starter: "Email", growth: "Priority email", scale: "SLA-backed" },
];

const FAQS: Array<{ q: string; a: string }> = [
  {
    q: "What counts as an active order?",
    a: "Any order created in TraceTxn during the calendar month — paid, pending, failed, or in dispute. Archived orders from previous months don't count; you can keep historical evidence chains indefinitely.",
  },
  {
    q: "Can I switch tiers later?",
    a: "Yes, up or down at any time. Tier change takes effect on the next billing cycle. Order limits, user seats, and feature gates flip immediately on the new tier.",
  },
  {
    q: "What happens if I exceed my order limit?",
    a: "We notify you when you hit 80% of your tier's monthly limit. If you cross the limit, new orders queue as drafts until you upgrade or until the next month rolls over. We never silently fail payments mid-month.",
  },
  {
    q: "Do you charge per transaction or take a cut of payments?",
    a: "No. TraceTxn is a flat subscription. Your Stripe processing fees stay between you and Stripe — we never touch the money. Your customers see your business name + Stripe as the processor.",
  },
  {
    q: "Is there a free trial?",
    a: "Every workspace gets a 14-day full-feature trial on the Growth tier. No card required to start. At day 14 you pick a plan or your workspace becomes read-only until you do.",
  },
  {
    q: "How does pricing compare to ChargeSentry or enterprise dispute tools?",
    a: "ChargeSentry starts at $99.95/month for an entry tier that gets weak reviews. Enterprise dispute platforms (Justt, Chargebacks911, etc.) typically run $500–$1,000/month for small businesses. TraceTxn covers the core lifecycle + evidence + consent flow that those tools sell, at a fraction of the price.",
  },
];

export default function PricingPage() {
  return (
    <div className="bg-background text-foreground">
      <BrandNav />

      {/* ─── Hero ────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b border-border bg-[color:var(--background)]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background:
              "linear-gradient(180deg, #F8FAFC 0%, #FFFFFF 100%)",
          }}
        />
        <div className="mx-auto max-w-[1024px] px-6 pt-20 pb-12 text-center sm:px-10 sm:pt-24">
          <p className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-3 py-1 font-display text-[10.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ background: "var(--brand-emerald)" }}
            />
            Pricing
          </p>
          <h1 className="mx-auto mt-6 max-w-2xl font-display text-[clamp(2rem,5vw,3.6rem)] font-medium leading-[1.05] tracking-[-0.025em]">
            Three tiers. No transaction fees.{" "}
            <span className="font-semibold text-[color:var(--brand-emerald)]">
              Cancel anytime.
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
            Flat monthly pricing. Your Stripe processing fees stay between
            you and Stripe — TraceTxn never touches the money.
          </p>
        </div>
      </section>

      {/* ─── Tier cards ──────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1280px] px-6 py-16 lg:px-10">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {TIERS.map((t) => (
            <TierCard key={t.name} tier={t} />
          ))}
        </div>

        <p className="mx-auto mt-10 max-w-2xl text-center text-[12.5px] text-muted-foreground">
          14-day full-feature trial on Growth. No credit card required to
          start. Pricing applies in USD; per-region pricing rolls out
          later this year.
        </p>
      </section>

      {/* ─── Feature matrix ──────────────────────────────────────── */}
      <section className="border-t border-border bg-white py-16">
        <div className="mx-auto max-w-[1024px] px-6 lg:px-10">
          <div className="text-center">
            <p className="font-display text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Compare plans
            </p>
            <h2 className="mt-3 font-display text-[clamp(1.6rem,3vw,2.2rem)] font-medium leading-[1.15] tracking-[-0.015em]">
              Everything that&apos;s in each tier, side by side.
            </h2>
          </div>

          <div className="mt-10 overflow-hidden rounded-2xl border border-border bg-white">
            <table className="w-full border-collapse text-left text-[13px]">
              <thead>
                <tr className="bg-[color:var(--background)]">
                  <th className="px-5 py-4 font-display text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    &nbsp;
                  </th>
                  {TIERS.map((t) => (
                    <th
                      key={t.name}
                      className="px-5 py-4 font-display text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground"
                    >
                      {t.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {MATRIX.map((row, i) => (
                  <tr
                    key={row.label}
                    className={
                      i % 2 === 0
                        ? "border-t border-border"
                        : "border-t border-border bg-[color:var(--background)]"
                    }
                  >
                    <td className="px-5 py-3 text-muted-foreground">
                      {row.label}
                    </td>
                    <Cell value={row.starter} />
                    <Cell value={row.growth} />
                    <Cell value={row.scale} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ─── FAQ ─────────────────────────────────────────────────── */}
      <section className="border-t border-border bg-[color:var(--background)] py-20">
        <div className="mx-auto max-w-[760px] px-6 lg:px-10">
          <div className="text-center">
            <p className="font-display text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              FAQ
            </p>
            <h2 className="mt-3 font-display text-[clamp(1.6rem,3vw,2.2rem)] font-medium leading-[1.15] tracking-[-0.015em]">
              The five questions every prospect asks.
            </h2>
          </div>

          <dl className="mt-10 divide-y divide-border rounded-2xl border border-border bg-white">
            {FAQS.map((item) => (
              <div key={item.q} className="px-6 py-5">
                <dt className="font-display text-[14.5px] font-medium text-foreground">
                  {item.q}
                </dt>
                <dd className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
                  {item.a}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <BrandCtaStrip />
      <BrandFooter />
    </div>
  );
}

/* ────────────────────────── Sub-components ─────────────────────────── */

function TierCard({ tier }: { tier: Tier }) {
  const recommended = tier.recommended === true;
  return (
    <div
      className={
        recommended
          ? "relative overflow-hidden rounded-2xl border-2 p-7 shadow-md transition-transform"
          : "relative overflow-hidden rounded-2xl border border-border bg-white p-7"
      }
      style={
        recommended
          ? {
              borderColor: "var(--brand-emerald)",
              background:
                "linear-gradient(180deg, #FFFFFF 0%, color-mix(in oklch, var(--brand-emerald) 4%, white) 100%)",
            }
          : undefined
      }
    >
      {recommended ? (
        <span
          className="absolute right-5 top-5 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-display text-[10px] font-semibold uppercase tracking-[0.14em] text-white"
          style={{ background: "var(--brand-emerald)" }}
        >
          Most popular
        </span>
      ) : null}

      <div className="font-display text-[13px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {tier.name}
      </div>
      <div className="mt-4 flex items-baseline gap-1">
        <span className="font-display text-[44px] font-semibold leading-none tracking-[-0.02em]">
          ${tier.price}
        </span>
        <span className="text-[13px] text-muted-foreground">
          /{tier.cadence.replace("per ", "")}
        </span>
      </div>
      <p className="mt-3 text-[13.5px] leading-relaxed text-muted-foreground">
        {tier.blurb}
      </p>

      <div className="mt-5 space-y-1 border-t border-border pt-5 text-[12.5px]">
        <div className="text-muted-foreground">{tier.ordersLabel}</div>
        <div className="text-muted-foreground">{tier.usersLabel}</div>
      </div>

      <ul className="mt-5 space-y-2 text-[13px]">
        {tier.highlights.map((h) => (
          <li key={h} className="flex items-start gap-2">
            <CheckIcon
              className="mt-[3px] size-3.5 shrink-0"
              style={{ color: "var(--brand-emerald)" }}
            />
            <span>{h}</span>
          </li>
        ))}
      </ul>

      <div className="mt-7">
        <Button
          asChild
          className="w-full gap-1.5"
          variant={recommended ? "default" : "outline"}
        >
          <Link href={tier.ctaHref}>
            {tier.ctaLabel}
            <ArrowRightIcon className="size-3.5" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

function Cell({ value }: { value: boolean | string }) {
  if (value === true) {
    return (
      <td className="px-5 py-3">
        <CheckIcon
          className="size-4"
          style={{ color: "var(--brand-emerald)" }}
        />
      </td>
    );
  }
  if (value === false) {
    return (
      <td className="px-5 py-3">
        <MinusIcon className="size-4 text-muted-foreground/40" />
      </td>
    );
  }
  return (
    <td className="px-5 py-3 font-medium text-foreground">{value}</td>
  );
}
