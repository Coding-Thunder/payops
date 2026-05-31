import Link from "next/link";
import * as React from "react";

import { BrandFooter } from "@/components/marketing/brand-footer";
import { BrandNav } from "@/components/marketing/brand-nav";
import { cn } from "@/lib/utils";

/**
 * Shared shell for long-form legal documents (Terms, Privacy, Refunds,
 * DPA). Wraps the page in BrandNav + hero (badge + title + intro +
 * last-updated stamp) + a two-column section layout with a sticky TOC
 * on the left at lg+. Mobile collapses to single column with an
 * inline "On this page" pill row.
 *
 * Each page passes a `sections` array — { id, title, children } — and
 * the shell handles anchor links + TOC + dividers. Page bodies stay
 * focused on the legal copy.
 */

export interface LegalSection {
  id: string;
  title: string;
  children: React.ReactNode;
}

interface LegalDocProps {
  badge: string;
  title: string;
  intro: string;
  lastUpdated: string;
  effectiveDate?: string;
  sections: LegalSection[];
}

export function LegalDoc({
  badge,
  title,
  intro,
  lastUpdated,
  effectiveDate,
  sections,
}: LegalDocProps) {
  return (
    <div className="bg-background text-foreground">
      <BrandNav />

      {/* ─── Hero ───────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b border-border bg-[color:var(--background)]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background:
              "linear-gradient(180deg, #F8FAFC 0%, #FFFFFF 100%)",
          }}
        />
        <div className="mx-auto max-w-[1024px] px-6 pt-20 pb-12 sm:px-10 sm:pt-24">
          <p className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-3 py-1 font-display text-[10.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ background: "var(--brand-emerald)" }}
            />
            {badge}
          </p>
          <h1 className="mt-6 max-w-3xl font-display text-[clamp(2rem,5vw,3.4rem)] font-medium leading-[1.05] tracking-[-0.025em]">
            {title}
          </h1>
          <p className="mt-5 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
            {intro}
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
            <span>Last updated · {lastUpdated}</span>
            {effectiveDate ? (
              <>
                <span aria-hidden>·</span>
                <span>Effective · {effectiveDate}</span>
              </>
            ) : null}
          </div>
        </div>
      </section>

      {/* ─── Body: TOC + sections ───────────────────────────────────── */}
      <section className="mx-auto max-w-[1280px] px-6 py-16 lg:px-10">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[14rem_1fr]">
          {/* Sticky TOC (lg+) */}
          <aside className="hidden lg:block">
            <nav
              aria-label="On this page"
              className="sticky top-24 self-start"
            >
              <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70">
                On this page
              </p>
              <ol className="space-y-1.5">
                {sections.map((s, i) => (
                  <li key={s.id}>
                    <a
                      href={`#${s.id}`}
                      className="grid grid-cols-[1.5rem_1fr] items-baseline gap-2 py-1 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground/70">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span className="leading-snug">{s.title}</span>
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
          </aside>

          {/* Mobile TOC strip */}
          <nav
            aria-label="On this page"
            className="-mx-6 flex gap-2 overflow-x-auto border-b border-border px-6 pb-4 lg:hidden"
          >
            {sections.map((s, i) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="shrink-0 rounded-full border border-border bg-white px-3 py-1 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <span className="font-mono tabular-nums text-muted-foreground/70">
                  {String(i + 1).padStart(2, "0")}
                </span>{" "}
                {s.title}
              </a>
            ))}
          </nav>

          {/* Sections column */}
          <div className="min-w-0 space-y-14">
            {sections.map((s, i) => (
              <section
                key={s.id}
                id={s.id}
                className="scroll-mt-24"
                aria-labelledby={`${s.id}-h`}
              >
                <div className="mb-5 flex items-baseline gap-3">
                  <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground/70">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <h2
                    id={`${s.id}-h`}
                    className="font-display text-[clamp(1.4rem,2.4vw,1.85rem)] font-semibold tracking-tight"
                  >
                    {s.title}
                  </h2>
                </div>
                <div className="text-[14px] leading-[1.75] text-foreground/85">
                  {s.children}
                </div>
              </section>
            ))}
          </div>
        </div>
      </section>

      <BrandFooter />
    </div>
  );
}

/* ─── Prose helpers ─────────────────────────────────────────────────────
 * Used inside section `children` to keep typography consistent across
 * the four legal pages. Keep tokens small + named so pages don't drift.
 * ─────────────────────────────────────────────────────────────────── */

export function P({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <p className={cn("mb-4 last:mb-0", className)}>{children}</p>;
}

export function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-7 mb-3 font-display text-[15.5px] font-semibold tracking-tight text-foreground">
      {children}
    </h3>
  );
}

export function UL({ children }: { children: React.ReactNode }) {
  return (
    <ul className="mb-4 space-y-2 pl-5 last:mb-0 [&_li]:list-disc [&_li]:marker:text-[color:var(--brand-emerald-strong)]">
      {children}
    </ul>
  );
}

export function OL({ children }: { children: React.ReactNode }) {
  return (
    <ol className="mb-4 space-y-2 pl-5 last:mb-0 [&_li]:list-decimal">
      {children}
    </ol>
  );
}

export function Note({ children }: { children: React.ReactNode }) {
  return (
    <aside className="my-5 rounded-xl border border-border bg-[color:var(--background)] px-5 py-4 text-[13px] leading-relaxed text-foreground/80">
      {children}
    </aside>
  );
}

export function Mail({ address }: { address: string }) {
  return (
    <a
      href={`mailto:${address}`}
      className="font-medium text-[color:var(--brand-emerald-strong)] underline decoration-[color:var(--brand-emerald)]/40 underline-offset-4 transition-colors hover:decoration-[color:var(--brand-emerald)]"
    >
      {address}
    </a>
  );
}

export function PageLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="font-medium text-[color:var(--brand-emerald-strong)] underline decoration-[color:var(--brand-emerald)]/40 underline-offset-4 transition-colors hover:decoration-[color:var(--brand-emerald)]"
    >
      {children}
    </Link>
  );
}
