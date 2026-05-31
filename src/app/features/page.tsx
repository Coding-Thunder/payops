import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRightIcon,
  CheckCircle2Icon,
  CreditCardIcon,
  FileTextIcon,
  GitBranchIcon,
  ReceiptIcon,
  ShieldCheckIcon,
  ZapIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { BrandCtaStrip } from "@/components/marketing/brand-cta-strip";
import { BrandFooter } from "@/components/marketing/brand-footer";
import { BrandNav } from "@/components/marketing/brand-nav";

export const metadata: Metadata = {
  title: "Features — Payment operations, simplified",
  description:
    "Hashed evidence chain on every order. Per-org Stripe connect. Configurable workflows. Hosted consent for dispute defence. PDF invoices + receipts. The operational console between you and your payment processor.",
  alternates: { canonical: "/features" },
};

/* ─────────────────────────── Pillars ─────────────────────────────────
 * Six top-level pillars match what's actually shipped. No "Coming
 * soon" rows. If you add a feature here, make sure the screenshot or
 * inline visual reflects real product state, not aspirational copy.
 * ────────────────────────────────────────────────────────────────── */

interface Pillar {
  eyebrow: string;
  title: string;
  body: string;
  Icon: React.ComponentType<{ className?: string }>;
  bullets: string[];
}

const PILLARS: Pillar[] = [
  {
    eyebrow: "Evidence",
    title: "Hashed evidence chain on every order",
    body: "Every state change appends a SHA-256-linked event to that order's chain — order created, link generated, consent verified, payment settled, dispute filed. Six weeks later when a chargeback lands, the evidence is already filed.",
    Icon: ShieldCheckIcon,
    bullets: [
      "Append-only — events never mutate after they're written",
      "Cryptographic hash chain proves no tampering",
      "Exported as a single PDF the cardholder's bank can read",
      "Captures IP + user agent + signed-name on every consent",
    ],
  },
  {
    eyebrow: "Lifecycle",
    title: "Track every transaction end-to-end",
    body: "From draft to paid to disputed to resolved. One console, one timeline, one source of truth for every order. No tab-switching between Stripe, your CRM, and a spreadsheet.",
    Icon: GitBranchIcon,
    bullets: [
      "Configurable status workflow per tenant",
      "Real-time SSE updates — no polling, no manual refresh",
      "Per-org filtering, search, and saved views",
      "Order detail page surfaces every event in one timeline",
    ],
  },
  {
    eyebrow: "Payments",
    title: "Per-org Stripe — your keys, encrypted",
    body: "Connect your own Stripe account in 60 seconds. We auto-register the webhook, capture the signing secret, encrypt your keys at rest, and never see your money. Your customers see your brand, not TraceTxn.",
    Icon: CreditCardIcon,
    bullets: [
      "BYOS (bring-your-own-Stripe) — TraceTxn never holds funds",
      "Webhook auto-registered + signing-secret stored encrypted",
      "Webhook health check + repair button on the connect page",
      "Per-tenant TEST + LIVE mode support",
    ],
  },
  {
    eyebrow: "Consent",
    title: "Hosted consent before every charge",
    body: "Customer clicks a single button to confirm the order details + acknowledge your terms BEFORE Stripe charges them. The signed acknowledgement lands on the evidence chain — strongest signal a card network sees in a dispute.",
    Icon: CheckCircle2Icon,
    bullets: [
      "HMAC-token-bound URL — single-use, customer-specific",
      "Captures customer IP, user agent, signed-name, timestamp",
      "Renders in your tenant brand, not TraceTxn brand",
      "Mobile-first; works in any email client's preview pane",
    ],
  },
  {
    eyebrow: "Documents",
    title: "Tenant-numbered invoices + receipts",
    body: "One click issues a brand-rendered invoice or receipt with a monotonic per-tenant number. Frozen snapshot at issue time — re-rendering reads the same bytes you sent the customer in March, even after your brand updates.",
    Icon: FileTextIcon,
    bullets: [
      "Monotonic numbering per (tenant, kind) — INV-2026-0001",
      "Append-only — issued docs never mutate",
      "Open in a new tab → browser print dialog → PDF",
      "Frozen brand + customer + line-item snapshot",
    ],
  },
  {
    eyebrow: "Operations",
    title: "Built for the team, not the spreadsheet",
    body: "Three roles out of the box (Super-Admin, Admin, Staff). Per-tenant audit log of every change. Email outbox with durable retry. The console an ops team can hand the keys to without losing sleep.",
    Icon: ZapIcon,
    bullets: [
      "Audit trail on every settings, status, and credential change",
      "Email outbox with exponential backoff + 5-attempt cap",
      "Soft-delete on financial data (orders never hard-vanish)",
      "Status-change webhook health surfaced inline",
    ],
  },
];

/* Secondary capabilities — surfaced as a tighter grid, no big icons.
 * Lets the page communicate breadth without padding the hero with
 * a 12-feature list. */
const SECONDARY: Array<{ label: string; body: string }> = [
  {
    label: "Multi-tenant from day one",
    body: "Every business-data row is org-scoped. Cross-tenant id-guesses fail at the query layer, not the controller.",
  },
  {
    label: "Configurable order statuses",
    body: "Define your own lifecycle — Lead → Trial → Active for SaaS, Booked → Confirmed → Checked-in for hospitality, etc.",
  },
  {
    label: "Hosted payment + cancel pages",
    body: "Token-bound URLs the customer can't share or replay. Branded in your colors, mobile-first.",
  },
  {
    label: "Dispute timeline + analytics",
    body: "Every Stripe dispute event lands on the order's chain. Reason-code analytics surface why losses happen.",
  },
  {
    label: "Per-org email templates",
    body: "Operators edit copy without HTML. Versioned + rollback-able. Customer emails carry your brand.",
  },
  {
    label: "Onboarding wizard",
    body: "Six-step guided setup so a non-engineer can take their first payment in 10 minutes.",
  },
];

export default function FeaturesPage() {
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
            Features
          </p>
          <h1 className="mx-auto mt-6 max-w-3xl font-display text-[clamp(2rem,5vw,3.6rem)] font-medium leading-[1.05] tracking-[-0.025em]">
            The operational console between you and{" "}
            <span className="font-semibold text-[color:var(--brand-emerald)]">
              your payment processor.
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
            Six pillars that turn payment chaos into payment operations.
            Every feature here is shipped — no roadmap chrome.
          </p>
        </div>
      </section>

      {/* ─── Six pillars — alternating columns ───────────────────── */}
      <section className="mx-auto max-w-[1280px] px-6 py-20 lg:px-10">
        <div className="space-y-20">
          {PILLARS.map((p, i) => (
            <PillarRow key={p.title} pillar={p} flipped={i % 2 === 1} />
          ))}
        </div>
      </section>

      {/* ─── Secondary capabilities — tighter grid ───────────────── */}
      <section className="border-y border-border bg-white py-20">
        <div className="mx-auto max-w-[1280px] px-6 lg:px-10">
          <div className="text-center">
            <p className="font-display text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              And every other operational nicety
            </p>
            <h2 className="mt-3 font-display text-[clamp(1.6rem,3vw,2.2rem)] font-medium leading-[1.15] tracking-[-0.015em]">
              The small things that make a workspace feel right.
            </h2>
          </div>

          <div className="mt-12 grid grid-cols-1 gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
            {SECONDARY.map((s) => (
              <div
                key={s.label}
                className="border-l-2 pl-5"
                style={{ borderColor: "var(--brand-emerald)" }}
              >
                <div className="font-display text-[14px] font-semibold tracking-tight">
                  {s.label}
                </div>
                <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                  {s.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── In-page CTA before the brand strip ──────────────────── */}
      <section className="mx-auto max-w-[760px] px-6 py-20 text-center lg:px-10">
        <h2 className="font-display text-[clamp(1.6rem,3.4vw,2.4rem)] font-medium leading-[1.1] tracking-[-0.02em]">
          See the full evidence flow on{" "}
          <span className="font-semibold">your own order</span>.
        </h2>
        <p className="mx-auto mt-4 max-w-md text-[14px] leading-relaxed text-muted-foreground">
          Open a workspace, connect Stripe, take a test payment — every
          event lands on the chain, every artifact is exportable.
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <Button asChild size="lg" className="gap-1.5">
            <Link href="/signup">
              Start your workspace
              <ArrowRightIcon className="size-4" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/pricing">See pricing</Link>
          </Button>
        </div>
      </section>

      <BrandCtaStrip />
      <BrandFooter />
    </div>
  );
}

/* ──────────────────────── Sub-components ───────────────────────────── */

function PillarRow({
  pillar,
  flipped,
}: {
  pillar: Pillar;
  flipped: boolean;
}) {
  return (
    <div
      className={
        flipped
          ? "grid grid-cols-1 items-center gap-12 lg:grid-cols-[1fr_1.1fr]"
          : "grid grid-cols-1 items-center gap-12 lg:grid-cols-[1.1fr_1fr]"
      }
    >
      {/* Copy */}
      <div className={flipped ? "lg:order-2" : ""}>
        <div className="flex items-center gap-3">
          <span
            className="inline-flex size-9 items-center justify-center rounded-lg"
            style={{
              background:
                "color-mix(in oklch, var(--brand-emerald) 12%, white)",
              color: "var(--brand-emerald-strong)",
            }}
          >
            <pillar.Icon className="size-5" />
          </span>
          <p className="font-display text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {pillar.eyebrow}
          </p>
        </div>
        <h3 className="mt-4 font-display text-[clamp(1.5rem,3vw,2.1rem)] font-medium leading-[1.15] tracking-[-0.015em]">
          {pillar.title}
        </h3>
        <p className="mt-4 text-[14.5px] leading-relaxed text-muted-foreground">
          {pillar.body}
        </p>
        <ul className="mt-6 space-y-2 text-[13.5px]">
          {pillar.bullets.map((b) => (
            <li key={b} className="flex items-start gap-2">
              <CheckCircle2Icon
                className="mt-[3px] size-3.5 shrink-0"
                style={{ color: "var(--brand-emerald)" }}
              />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Visual placeholder card — a quiet operational artifact in the
          brand language. Real screenshots would slot in here later. */}
      <div className={flipped ? "lg:order-1" : ""}>
        <PillarVisual pillar={pillar} />
      </div>
    </div>
  );
}

function PillarVisual({ pillar }: { pillar: Pillar }) {
  return (
    <div className="relative">
      <div className="overflow-hidden rounded-2xl border border-border bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between border-b border-border pb-4">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ background: "var(--brand-emerald)" }}
            />
            <span className="font-display text-[10.5px] font-semibold uppercase tracking-[0.14em] text-foreground">
              {pillar.eyebrow} preview
            </span>
          </div>
          <ReceiptIcon className="size-3.5 text-muted-foreground" />
        </div>

        {/* Stylised mock rows — each pillar gets the same chrome but a
            distinct content stripe, so the page feels consistent
            without re-rendering different illustrations. */}
        <div className="mt-5 space-y-3">
          {pillar.bullets.slice(0, 3).map((b, idx) => (
            <div
              key={b}
              className="flex items-start gap-3 rounded-lg border border-border bg-[color:var(--background)] p-3"
            >
              <span
                className="mt-[2px] inline-flex size-5 shrink-0 items-center justify-center rounded font-mono text-[10px] font-semibold"
                style={{
                  background:
                    "color-mix(in oklch, var(--brand-emerald) 12%, white)",
                  color: "var(--brand-emerald-strong)",
                }}
              >
                {String(idx + 1).padStart(2, "0")}
              </span>
              <span className="text-[12.5px] leading-relaxed text-foreground/85">
                {b}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-5 flex items-center justify-between border-t border-border pt-4 text-[10.5px] text-muted-foreground">
          <span className="font-mono uppercase tracking-[0.14em]">
            {pillar.eyebrow.toLowerCase()}.tracetxn
          </span>
          <span>{pillar.bullets.length} items</span>
        </div>
      </div>
    </div>
  );
}
