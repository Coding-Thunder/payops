import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRightIcon,
  BriefcaseIcon,
  HeadphonesIcon,
  ShieldCheckIcon,
  ZapIcon,
} from "lucide-react";

import { BrandCtaStrip } from "@/components/marketing/brand-cta-strip";
import { BrandFooter } from "@/components/marketing/brand-footer";
import { BrandNav } from "@/components/marketing/brand-nav";

export const metadata: Metadata = {
  title: "Contact, Sales, support, security",
  description:
    "Talk to TraceTxn. Sales for prospects, support for customers, security for vulnerability disclosure, careers + press inquiries, direct contact lines, no chatbot maze.",
  alternates: { canonical: "/contact" },
};

/**
 * Four contact lanes, each a direct mailto. No contact form -
 * intentional: a form adds friction without giving us better signal
 * than an email. Operators reading a contact page have a question;
 * the fastest path is one tap to mailto.
 *
 * Sales is the only lane that also has a "Open a workspace yourself"
 * affordance, most prospects don't need a call.
 */

interface Lane {
  eyebrow: string;
  title: string;
  body: string;
  email: string;
  icon: React.ComponentType<{ className?: string }>;
  altCta?: { label: string; href: string };
}

const LANES: Lane[] = [
  {
    eyebrow: "Sales",
    title: "Talk to sales",
    body: "Prospect questions on pricing, deployment, custom requirements, multi-team setup, or enterprise terms. Most prospects don't need a call, you can spin up a workspace directly and we'll reach out if you flag something on signup.",
    email: "sales@tracetxn.com",
    icon: BriefcaseIcon,
    altCta: { label: "Open a workspace yourself", href: "/signup" },
  },
  {
    eyebrow: "Support",
    title: "Customer support",
    body: "Already using TraceTxn? Stuck on a connect step, missing a payment in your dashboard, evidence chain showing wrong? Reach support, Growth + Scale tiers get priority email; Starter gets best-effort within 2 business days.",
    email: "support@tracetxn.com",
    icon: HeadphonesIcon,
  },
  {
    eyebrow: "Security",
    title: "Vulnerability disclosure",
    body: "Found a security issue? Email us before disclosing publicly. We acknowledge within 48 hours, validate quickly, and credit you in the disclosure log. See the security page for the responsible-disclosure terms.",
    email: "security@tracetxn.com",
    icon: ShieldCheckIcon,
    altCta: { label: "Read the security posture", href: "/security" },
  },
  {
    eyebrow: "Press + partnerships",
    title: "Press, partnerships, and everything else",
    body: "Media inquiries, integration partnerships, agency referrals, podcast invites. We're a small team, replies take 1-3 business days.",
    email: "hello@tracetxn.com",
    icon: ZapIcon,
  },
];

export default function ContactPage() {
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
            Contact
          </p>
          <h1 className="mx-auto mt-6 max-w-2xl font-display text-[clamp(2rem,5vw,3.6rem)] font-medium leading-[1.05] tracking-[-0.025em]">
            One inbox per intent.{" "}
            <span className="font-semibold text-[color:var(--brand-emerald)]">
              No chatbot maze.
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
            Direct email to a real person on our team. We reply during
            India business hours; expect a response within one business
            day on weekdays.
          </p>
        </div>
      </section>

      {/* ─── Lanes ──────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1280px] px-6 py-16 lg:px-10">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {LANES.map((lane) => (
            <LaneCard key={lane.email} lane={lane} />
          ))}
        </div>
      </section>

      {/* ─── Office strip ───────────────────────────────────────── */}
      <section className="border-t border-border bg-white py-16">
        <div className="mx-auto max-w-[1024px] px-6 lg:px-10">
          <div className="grid grid-cols-1 gap-10 sm:grid-cols-3">
            <div>
              <div className="font-display text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Where we operate
              </div>
              <p className="mt-3 text-[14px] text-foreground">
                Remote-first.
                <br />
                <span className="text-muted-foreground">
                  Customers in India, UAE, Singapore, US, UK.
                </span>
              </p>
            </div>
            <div>
              <div className="font-display text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Response time
              </div>
              <p className="mt-3 text-[14px] text-foreground">
                ≤ 1 business day{" "}
                <span className="text-muted-foreground">
                  on sales + support emails (Mon–Fri).
                </span>
              </p>
            </div>
            <div>
              <div className="font-display text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Status
              </div>
              <p className="mt-3 text-[14px] text-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="size-1.5 rounded-full"
                    style={{ background: "var(--brand-emerald)" }}
                  />
                  All systems operational
                </span>
              </p>
            </div>
          </div>
        </div>
      </section>

      <BrandCtaStrip />
      <BrandFooter />
    </div>
  );
}

function LaneCard({ lane }: { lane: Lane }) {
  const Icon = lane.icon;
  return (
    <div className="rounded-2xl border border-border bg-white p-7">
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
        <p className="font-display text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {lane.eyebrow}
        </p>
      </div>

      <h2 className="mt-4 font-display text-[20px] font-medium tracking-tight">
        {lane.title}
      </h2>
      <p className="mt-3 text-[13.5px] leading-relaxed text-muted-foreground">
        {lane.body}
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <a
          href={`mailto:${lane.email}`}
          className="inline-flex items-center gap-1.5 rounded-md px-3.5 py-2 font-display text-[13px] font-medium text-white transition-opacity hover:opacity-90"
          style={{ background: "var(--ink-navy)" }}
        >
          {lane.email}
          <ArrowRightIcon className="size-3.5" />
        </a>
        {lane.altCta ? (
          <Link
            href={lane.altCta.href}
            className="text-[12.5px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {lane.altCta.label} →
          </Link>
        ) : null}
      </div>
    </div>
  );
}
