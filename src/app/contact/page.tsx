import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRightIcon,
  HeadphonesIcon,
  MailIcon,
  ShieldCheckIcon,
  ZapIcon,
} from "lucide-react";

import { BrandCtaStrip } from "@/components/marketing/brand-cta-strip";
import { ContactEnquiryForm } from "@/components/marketing/contact-enquiry-form";
import { BrandFooter } from "@/components/marketing/brand-footer";
import { BrandNav } from "@/components/marketing/brand-nav";

import { env } from "@/lib/env";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Contact",
  description: "Talk to TraceTxn \u2014 sales, support, security disclosure and press. Direct contact lines, no chatbot maze.",
  path: "/contact",
});

/**
 * Two ways to reach us, side by side: a general-enquiry form and the direct
 * mailto lanes.
 *
 * The form posts to the existing `/api/quotations` endpoint and is reviewable
 * at /admin/quotations — the admin surface that had to exist before a form
 * was defensible, since a form writing rows nobody reads is worse than no
 * form. The mailto lanes stay because plenty of people would rather just
 * send an email, and because support and security need their own addresses.
 *
 * ── Shape ───────────────────────────────────────────────────────────────
 *
 * Prominent enquiry card (copy + form, hello@ beside it) above three
 * specific lanes: support@, security@, and hello@ for press.
 *
 * ── Four things to keep right ───────────────────────────────────────────
 *
 *  1. Rows are keyed by `id`, not `email`. Press and general enquiry share
 *     hello@, so keying by address gave React a duplicate key.
 *  2. Only these three addresses exist. Do not add a fourth without a
 *     mailbox behind it. Security stays on security@.
 *  3. The mailto copy claims nothing about receipt — a mailto hands off to
 *     the visitor's mail client and we cannot know whether they sent it.
 *     The form's success state says "recorded", which is true of the row it
 *     just wrote, and does not claim an email was delivered.
 *  4. No operational claim this page cannot stand behind: there is no status
 *     page, no uptime monitoring and no response-time SLA. The strip below
 *     states what we actually aim for and marks it as a target.
 */

/** Prefills the subject so the recipient can triage without opening a thread. */
function mailto(email: string, subject: string): string {
  return `mailto:${email}?subject=${encodeURIComponent(subject)}`;
}

/** What an email should contain — the questions a form would have asked. */
const INCLUDE = [
  "Who you are and what your business does",
  "What you are trying to keep track of today",
  "Roughly how many clients, and what tools you use now",
];

interface Lane {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  email: string;
  subject: string;
  icon: React.ComponentType<{ className?: string }>;
  altCta?: { label: string; href: string };
}

const LANES: Lane[] = [
  {
    id: "support",
    eyebrow: "Support",
    title: "Customer support",
    // No tier language here: billing is not wired up and `getPlan()` in
    // billing.service.ts returns `starter` for every tenant, so a promise of
    // "priority email on Growth + Scale" describes a plan nobody can be on.
    // Two business days is what everyone actually gets today.
    body: "Already using TraceTxn? Stuck on a connect step, an invoice missing from a client's timeline, a payment not matching up? Reach support, replies land within 2 business days.",
    email: "support@tracetxn.com",
    subject: "TraceTxn support request",
    icon: HeadphonesIcon,
  },
  {
    id: "security",
    eyebrow: "Security",
    title: "Vulnerability disclosure",
    body: "Found a security issue? Email us before disclosing publicly. We acknowledge within 48 hours, validate quickly, and credit you in the disclosure log. See the security page for the responsible-disclosure terms.",
    email: "security@tracetxn.com",
    subject: "Security disclosure",
    icon: ShieldCheckIcon,
    altCta: { label: "Read the security posture", href: "/security" },
  },
  {
    id: "press",
    eyebrow: "Press + partnerships",
    title: "Press, partnerships, and everything else",
    body: "Media inquiries, integration partnerships, agency referrals, podcast invites. We're a small team, replies take 1-3 business days.",
    email: "hello@tracetxn.com",
    subject: "Press / partnership enquiry",
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

      {/* ─── Primary enquiry card ───────────────────────────────── */}
      <section className="mx-auto max-w-[1280px] px-6 pt-14 lg:px-10">
        <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04),0_18px_40px_-28px_rgba(15,23,42,0.18)]">
          <div className="grid grid-cols-1 gap-8 p-7 sm:p-10 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:items-center lg:gap-12">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <span
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg"
                  style={{
                    background:
                      "color-mix(in oklch, var(--brand-emerald) 12%, white)",
                    color: "var(--brand-emerald-strong)",
                  }}
                >
                  <MailIcon className="size-5" />
                </span>
                <p className="font-display text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  General enquiries
                </p>
              </div>

              <h2 className="mt-4 font-display text-[24px] font-medium leading-[1.2] tracking-tight sm:text-[28px]">
                Tell us what you&apos;re trying to keep track of.
              </h2>
              <p className="mt-3 max-w-[52ch] text-[14px] leading-relaxed text-muted-foreground">
                Questions about whether TraceTxn fits how you work, what it
                does today, pricing after the beta, or a setup that needs a
                conversation. One email reaches the people building it.
              </p>

              <ul className="mt-6 grid gap-2">
                {INCLUDE.map((line) => (
                  <li
                    key={line}
                    className="flex items-start gap-2.5 text-[13.5px] leading-relaxed text-muted-foreground"
                  >
                    <span
                      aria-hidden
                      className="mt-[7px] size-1.5 shrink-0 rounded-full"
                      style={{ background: "var(--brand-emerald)" }}
                    />
                    {line}
                  </li>
                ))}
              </ul>
            </div>

            <div className="min-w-0 space-y-3">
              <ContactEnquiryForm
                turnstileSiteKey={
                  env.public.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null
                }
              />
              {/* The form is the easier path for most people; the address is
                  kept visible for anyone who would rather use their own mail
                  client, and as the fallback the form's error state points at. */}
              <p className="text-center text-[12.5px] leading-relaxed text-muted-foreground">
                Rather just email?{" "}
                <a
                  href={mailto("hello@tracetxn.com", "TraceTxn enquiry")}
                  aria-label="Email hello@tracetxn.com with a general enquiry"
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  hello@tracetxn.com
                </a>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ─── Specific lanes ─────────────────────────────────────── */}
      <section className="mx-auto max-w-[1280px] px-6 pt-8 pb-16 lg:px-10">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {LANES.map((lane) => (
            <LaneCard key={lane.id} lane={lane} />
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
                What we aim for
              </div>
              {/* Two different numbers, because the lanes genuinely differ —
                  the old single "≤ 1 business day on sales + support"
                  contradicted the support card's own two-day expectation.
                  Framed as a target, not a guarantee: there is no SLA. */}
              <p className="mt-3 text-[14px] text-foreground">
                1 business day{" "}
                <span className="text-muted-foreground">
                  on enquiries, 2 on support (Mon–Fri). A target, not a
                  guaranteed SLA.
                </span>
              </p>
            </div>
            <div>
              <div className="font-display text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Product stage
              </div>
              {/* This said "All systems operational" with a green dot, which
                  reads as a live status feed. There is no status page and no
                  uptime monitoring wired up, so it was an unsupported claim.
                  Replaced with a fact about the product, not its uptime. */}
              <p className="mt-3 text-[14px] text-foreground">
                Private beta{" "}
                <span className="text-muted-foreground">
                  — invite-only, and free while it lasts.
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
    <div className="flex flex-col rounded-2xl border border-border bg-white p-7">
      <div className="flex items-center gap-3">
        <span
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg"
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

      <div className="mt-6 flex flex-wrap items-center gap-3 pt-0 lg:mt-auto lg:pt-6">
        <a
          href={mailto(lane.email, lane.subject)}
          aria-label={`Email ${lane.email} — ${lane.title}`}
          className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-3.5 py-2 font-display text-[13px] font-medium text-white transition-opacity hover:opacity-90"
          style={{ background: "var(--ink-navy)" }}
        >
          <span className="truncate">{lane.email}</span>
          <ArrowRightIcon className="size-3.5 shrink-0" />
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
