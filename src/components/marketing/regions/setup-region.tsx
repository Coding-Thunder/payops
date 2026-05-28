import Link from "next/link";
import { ArrowRightIcon, CheckIcon } from "lucide-react";

/**
 * Setup region — closes the document with a numbered procedure.
 *
 * Sits in a soft inset surface for region rhythm + uses green
 * numbered ring pills on the steps (same operational identity
 * marker the reference's case-file timeline uses on its events).
 */

const STEPS: Array<{ k: string; title: string; body: string }> = [
  {
    k: "1",
    title: "Create your workspace",
    body: "Sign up, name your business, pick a vertical template — retail, services, rental, repair, dealership, generic. The catalog seeds itself; the operator console is live.",
  },
  {
    k: "2",
    title: "Connect Stripe",
    body: "One-click test, auto-registered webhook endpoint, deep links into your Stripe dashboard. Razorpay and Authorize.net adapters slot in next.",
  },
  {
    k: "3",
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

export function SetupRegion() {
  return (
    <section
      id="setup"
      className="scroll-mt-20 mt-20 sm:mt-28 -mx-6 lg:-mx-10 px-6 lg:px-10 py-16 sm:py-20"
      style={{ background: "var(--surface-1)" }}
    >
      <div className="grid grid-cols-1 gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] lg:items-start">
        <div>
          <p
            className="font-mono text-[10.5px] uppercase tracking-[0.16em]"
            style={{ color: "var(--success-strong)" }}
          >
            Setup
          </p>
          <h2 className="mt-3 max-w-[20ch] text-balance text-[24px] sm:text-[28px] font-semibold leading-[1.15] tracking-[-0.018em]">
            Create the workspace. Run your first order before the day
            ends.
          </h2>
          <p className="mt-4 max-w-[44ch] text-[14px] leading-relaxed text-muted-foreground">
            Item types, orders, evidence, and consent are universal
            primitives. Pick a vertical template, connect Stripe, run a
            real order through the lifecycle — all of it inside your
            tenant from the first minute.
          </p>

          <Link
            href="/signup"
            className="group mt-7 inline-flex items-center gap-2 rounded-md bg-foreground px-3.5 py-2 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
          >
            Start free
            <ArrowRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>

        {/* Numbered procedure — green ring pills + connector line.
            Same operational identity element the case-file timeline
            uses on its events. */}
        <ol className="relative space-y-6">
          {/* Vertical green connector line behind the pills */}
          <span
            aria-hidden
            className="pointer-events-none absolute left-[1.125rem] top-2 bottom-2 w-[2px] rounded-full"
            style={{ background: "var(--success)" }}
          />
          {STEPS.map((s) => (
            <li
              key={s.k}
              className="relative grid grid-cols-[2.25rem_1fr] items-start gap-x-4"
            >
              <span
                className="relative z-10 grid size-9 place-items-center rounded-full text-[13px] font-semibold text-white shadow-[0_4px_12px_-4px_color-mix(in_oklch,var(--success)_55%,transparent)]"
                style={{ background: "var(--success)" }}
              >
                {s.k}
              </span>
              <div className="pt-1">
                <h3 className="text-[15.5px] font-semibold tracking-tight">
                  {s.title}
                </h3>
                <p className="mt-1.5 max-w-[52ch] text-[13.5px] leading-relaxed text-muted-foreground">
                  {s.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* What every workspace gets */}
      <div className="mt-16 border-t border-border pt-8">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
          What every workspace gets
        </p>
        <ul className="mt-4 grid grid-cols-1 gap-x-8 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-2">
          {INCLUDED.map((item) => (
            <li
              key={item}
              className="grid grid-cols-[1rem_1fr] items-baseline gap-x-2 text-[13.5px] leading-relaxed"
            >
              <CheckIcon
                className="mt-[3px] size-3.5 shrink-0 text-success"
                strokeWidth={2.5}
                aria-hidden
              />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
