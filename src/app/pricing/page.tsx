import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon, CheckIcon, MinusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BrandCtaStrip } from "@/components/marketing/brand-cta-strip";
import { BrandFooter } from "@/components/marketing/brand-footer";
import { BrandNav } from "@/components/marketing/brand-nav";

export const metadata: Metadata = {
  title: "Pricing, Starter, Growth, Scale",
  description:
    "TraceTxn pricing, three tiers from $39/month. Full evidence chain, audit trail, lifecycle tracking, and PDF export on every plan. Anchored against $500-$1,000/month enterprise dispute tools.",
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
  trialLine: string;
}

const TRIAL_LINE = "15 day free trial. No credit card required.";

const TIERS: Tier[] = [
  {
    name: "Starter",
    price: 39,
    cadence: "per month",
    blurb:
      "Everything you need to take payments and win disputes from day one.",
    ordersLabel: "Up to 30 active orders at a time",
    usersLabel: "Solo operator",
    highlights: [
      "Dispute-ready evidence chain on every order",
      "Full payment lifecycle and audit trail",
      "Customer consent flow with timestamp and IP capture",
      "PDF evidence export, bank-submittable",
      "Real-time payment monitoring via Stripe",
      "PDF receipt and invoice export",
      "Stripe connection with encrypted key storage",
    ],
    ctaLabel: "Start with Starter",
    ctaHref: "/signup",
    trialLine: TRIAL_LINE,
  },
  {
    name: "Growth",
    price: 99,
    cadence: "per month",
    blurb:
      "For growing teams handling real dispute volume. Cheaper than one lost chargeback per month.",
    ordersLabel: "Up to 150 active orders at a time",
    usersLabel: "Up to 3 team members",
    highlights: [
      "Everything in Starter",
      "Up to 3 team members in one workspace",
      "5x the active-order headroom",
      "Priority email support with 48 hour response",
    ],
    ctaLabel: "Start with Growth",
    ctaHref: "/signup",
    recommended: true,
    trialLine: TRIAL_LINE,
  },
  {
    name: "Scale",
    price: 249,
    cadence: "per month",
    blurb:
      "For operations where dispute readiness is a daily job, not a monthly fire drill.",
    ordersLabel: "Unlimited orders",
    usersLabel: "Unlimited team members",
    highlights: [
      "Everything in Growth",
      "Unlimited active orders, no soft caps",
      "Unlimited team members",
      "Dedicated onboarding session plus 30 day check-in call",
      "Priority support with 12 hour SLA",
    ],
    ctaLabel: "Start with Scale",
    ctaHref: "/signup",
    trialLine: TRIAL_LINE,
  },
];

/* Side-by-side feature matrix, quick comparison without re-listing
 * the bullets above. ✓ / "-" only; no "Coming soon" weasel-words. */
interface MatrixRow {
  label: string;
  starter: boolean | string;
  growth: boolean | string;
  scale: boolean | string;
}

/* What actually differs between tiers, capacity and the human-side
 * commitments. Every feature in the product (evidence chain, audit
 * trail, consent flow, Stripe connect, workflow customisation, PDF
 * export, analytics) is available on every plan today and listed
 * once in the tier cards above. We don't pad this table with
 * ✓✓✓ rows that would lie about gating, the upgrade story is
 * capacity and support, not a feature-flag fence. */
const MATRIX: MatrixRow[] = [
  {
    label: "Active orders at a time",
    starter: "30",
    growth: "150",
    scale: "Unlimited",
  },
  {
    label: "Team members",
    starter: "Solo operator",
    growth: "Up to 3",
    scale: "Unlimited",
  },
  {
    label: "Dedicated onboarding + 30 day check-in",
    starter: false,
    growth: false,
    scale: true,
  },
  {
    label: "Support",
    starter: "Email",
    growth: "Priority, 48h response",
    scale: "Priority, 12h SLA",
  },
];

const FAQS: Array<{ q: string; a: string }> = [
  {
    q: "What counts as an active order?",
    a: "An order with a status that is not yet terminal: NOT_INITIATED, LINK_GENERATED, or PAYMENT_PENDING. Once an order is paid, failed, or expired it frees a slot. You can keep historical evidence chains indefinitely.",
  },
  {
    q: "Can I switch tiers later?",
    a: "Yes, up or down at any time. Tier change takes effect on the next billing cycle. Order limits, team-member seats, and feature gates flip immediately on the new tier.",
  },
  {
    q: "What happens if I exceed my order limit?",
    a: "Order creation is blocked with a clear upgrade prompt the moment you reach the cap. Existing orders stay editable and payments keep flowing. Resolve a pending order (mark it paid, expire it, or archive it) to free a slot, or upgrade for more headroom.",
  },
  {
    q: "Do you charge per transaction or take a cut of payments?",
    a: "No. TraceTxn is a flat subscription. Your Stripe processing fees stay between you and Stripe, and we never touch the money. Your customers see your business name plus Stripe as the processor.",
  },
  {
    q: "Is there a free trial?",
    a: "Every paid tier starts with a 15 day full-feature trial. No credit card required. At day 15, order creation pauses until you pick a plan or email sales to extend, your existing orders and evidence stay intact either way.",
  },
  {
    q: "How does pricing compare to enterprise dispute tools?",
    a: "Most enterprise dispute platforms run $500 to $1,000 a month for small businesses. TraceTxn covers the core lifecycle, evidence, and consent flow that those tools sell, at a fraction of the price.",
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
            Simple pricing.{" "}
            <span className="font-semibold text-[color:var(--brand-emerald)]">
              No enterprise contracts.
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
            Start free for 15 days. No credit card required.
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
          Pricing shown in USD. Per-region pricing rolls out later this year.
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

      <div className="mt-7 space-y-2.5">
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
        <p className="text-center text-[11px] text-muted-foreground">
          {tier.trialLine}
        </p>
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
