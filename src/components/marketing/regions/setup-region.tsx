import Link from "next/link";
import {
  ArrowRightIcon,
  CheckIcon,
  LinkIcon,
  PlayCircleIcon,
  SparklesIcon,
} from "lucide-react";

/**
 * Setup region, brand-v1 rebuild.
 *
 * Replaces the two-column "copy left, numbered ol right" layout with
 * the same vocabulary used on Pricing and Security: cloud band
 * background, emerald eyebrow chip, navy headline with an emerald
 * accent, three step cards in a grid, then a compact "What you get"
 * chip row inside its own card.
 */

interface SetupStep {
  index: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
}

const STEPS: SetupStep[] = [
  {
    index: "01",
    icon: SparklesIcon,
    title: "Create your workspace",
    body: "Sign up, name your business, pick a vertical template (retail, services, rental, repair, dealership, generic). The catalog seeds itself; the operator console is live.",
  },
  {
    index: "02",
    icon: LinkIcon,
    title: "Connect Stripe",
    body: "One-click test, auto-registered webhook endpoint, deep links into your Stripe dashboard. Razorpay and Authorize.net adapters slot in next.",
  },
  {
    index: "03",
    icon: PlayCircleIcon,
    title: "Run your first order",
    body: "Catalog, order, payment link, consent, paid. Every transition recorded on the evidence chain from minute one.",
  },
];

const INCLUDED: string[] = [
  "Org-isolated data, your tenant, your records",
  "Branded customer-facing payment pages",
  "Role + permission matrix (Admin, Staff, custom)",
  "Audit-grade hashed evidence chain",
  "Hosted consent capture",
  "PDF + CSV dispute exports",
  "Realtime SSE lifecycle updates",
  "Stripe live, Razorpay + Authorize.net adapters next",
];

export function SetupRegion() {
  return (
    <section
      id="setup"
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
            Setup
          </p>
          <h2 className="mt-6 font-display text-[clamp(1.8rem,4vw,2.8rem)] font-medium leading-[1.08] tracking-[-0.022em]">
            Create the workspace.{" "}
            <span className="font-semibold text-[color:var(--brand-emerald)]">
              Run your first paid order before the day ends.
            </span>
          </h2>
          <p className="mt-5 max-w-xl text-[14.5px] leading-relaxed text-muted-foreground">
            Item types, orders, evidence, and consent are universal
            primitives. Pick a vertical template, connect Stripe, run a
            real order through the lifecycle, all of it inside your tenant
            from the first minute.
          </p>
          <div className="mt-7">
            <Link
              href="/signup"
              className="group inline-flex items-center gap-2 rounded-md bg-foreground px-3.5 py-2 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
            >
              Start free
              <ArrowRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>
        </div>

        {/* Step cards */}
        <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3">
          {STEPS.map((s) => (
            <StepCard key={s.index} step={s} />
          ))}
        </div>

        {/* Included card */}
        <div className="mt-10 rounded-2xl border border-border bg-white p-7">
          <p className="font-display text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            What every workspace gets
          </p>
          <ul className="mt-5 grid grid-cols-1 gap-x-8 gap-y-2.5 sm:grid-cols-2">
            {INCLUDED.map((item) => (
              <li
                key={item}
                className="flex items-start gap-2 text-[13.5px] leading-relaxed"
              >
                <CheckIcon
                  className="mt-[3px] size-3.5 shrink-0"
                  strokeWidth={2.5}
                  style={{ color: "var(--brand-emerald)" }}
                  aria-hidden
                />
                <span className="text-foreground/85">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function StepCard({ step }: { step: SetupStep }) {
  const Icon = step.icon;
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
        <span className="font-mono text-[11px] tabular-nums uppercase tracking-[0.16em] text-muted-foreground">
          Step {step.index}
        </span>
      </div>
      <h3 className="mt-4 font-display text-[16px] font-semibold tracking-tight">
        {step.title}
      </h3>
      <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
        {step.body}
      </p>
    </div>
  );
}
