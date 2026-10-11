"use client";

import { motion, type HTMLMotionProps } from "motion/react";

import { cn } from "@/lib/utils";

/**
 * The homepage design system.
 *
 * ── Why these exist ──────────────────────────────────────────────────────
 *
 * Fourteen sections have to read as one product, and the fastest way to lose
 * that is for each section to invent its own card, its own badge and its own
 * idea of what a product screenshot looks like. Everything visual on the page
 * is assembled from the pieces below, so the page inherits the application's
 * density and chrome instead of approximating it section by section.
 *
 * ── The two accents, and why they are not interchangeable ────────────────
 *
 * Emerald (`--brand-emerald`) means STATE: live, paid, settled, connected.
 * Electric blue (`--brand-blue`) means INTENT: links, primary actions, chart
 * strokes, focus rings.
 *
 * Keeping them separate is a product decision, not a palette preference. In a
 * transactional interface a green button reads as a status badge — "this is
 * paid" — and a visitor should never have to work out whether a green pill is
 * telling them something or asking them to click. So `StatusBadge` is the
 * only thing on the page allowed to be emerald, and buttons are never green.
 *
 * ── The page is light ────────────────────────────────────────────────────
 *
 * This file used to describe a near-black homepage. The rest of the marketing
 * site — /features, /pricing, /security, the client-management cluster, /blog,
 * /reviews — is light and reads straight from the `--background: #F8FAFC` /
 * `--foreground: #0F172A` tokens. The homepage was the one surface that did
 * not, so a visitor who clicked any nav link crossed a theme boundary. These
 * primitives put it on the same ground as everything else.
 */

const EASE = [0.22, 1, 0.36, 1] as const;

/* ─── Motion ───────────────────────────────────────────────────────────── */

interface RevealProps extends HTMLMotionProps<"div"> {
  /** Seconds of delay before the reveal starts. */
  delay?: number;
  /** Vertical travel in px. Defaults to 18. */
  y?: number;
}

/**
 * Fade + rise the first time the element scrolls into view.
 *
 * `once` so it never re-animates on scroll-back — a page that flickers as you
 * move back up it feels broken rather than alive. The travel is deliberately
 * small: this is software, and the motion should read as the page settling,
 * not as a transition.
 *
 * Starts at `opacity: 0`, so anything that must be visible in the first
 * still frame — the hero, the nav — is NOT wrapped in this.
 */
export function Reveal({
  className,
  delay = 0,
  y = 18,
  children,
  ...props
}: RevealProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -12% 0px" }}
      transition={{ duration: 0.5, delay, ease: EASE }}
      className={cn(className)}
      {...props}
    >
      {children}
    </motion.div>
  );
}

/* ─── Layout ───────────────────────────────────────────────────────────── */

/** Section shell: anchor id + consistent vertical rhythm + centred column. */
export function Section({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn(
        "relative mx-auto w-full max-w-[1180px] px-6 py-20 sm:py-24 lg:px-8",
        className,
      )}
    >
      {children}
    </section>
  );
}

/** Small uppercase kicker. Anchors each section without a heading level. */
export function Eyebrow({
  children,
  className,
  tone = "blue",
}: {
  children: React.ReactNode;
  className?: string;
  /** `live` adds the emerald state dot; `blue` is the neutral default. */
  tone?: "blue" | "live";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-[11.5px] font-semibold uppercase tracking-[0.14em]",
        tone === "live" ? "text-[var(--brand-emerald)]" : "text-[#64748B]",
        className,
      )}
    >
      {tone === "live" ? <LiveDot /> : null}
      {children}
    </span>
  );
}

/**
 * Section heading block: eyebrow + h2 + one supporting line.
 *
 * Copy width is capped at 60ch rather than a pixel value so the measure holds
 * at every type scale — long-form marketing copy at full container width is
 * the single most common readability failure on a landing page.
 */
export function SectionHead({
  eyebrow,
  title,
  copy,
  align = "left",
  tone = "blue",
}: {
  eyebrow: string;
  title: React.ReactNode;
  copy?: React.ReactNode;
  align?: "left" | "center";
  tone?: "blue" | "live";
}) {
  return (
    <div className={cn(align === "center" && "mx-auto text-center")}>
      <Eyebrow tone={tone}>{eyebrow}</Eyebrow>
      <h2
        className={cn(
          "mt-4 font-display text-[28px] font-semibold leading-[1.15] tracking-[-0.02em] text-[#0A1128] sm:text-[34px]",
          "max-w-[22ch]",
          align === "center" && "mx-auto max-w-[26ch]",
        )}
        style={{ textWrap: "balance" }}
      >
        {title}
      </h2>
      {copy ? (
        <p
          className={cn(
            "mt-4 max-w-[60ch] text-[15.5px] leading-[1.65] text-[#4A5568]",
            align === "center" && "mx-auto",
          )}
        >
          {copy}
        </p>
      ) : null}
    </div>
  );
}

/* ─── Status language ──────────────────────────────────────────────────── */

/** The emerald "this is live" dot. The only animated element on the page. */
export function LiveDot({ className }: { className?: string }) {
  return (
    <span className={cn("relative flex size-1.5 shrink-0", className)}>
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--brand-emerald)] opacity-60 motion-reduce:hidden" />
      <span className="relative inline-flex size-1.5 rounded-full bg-[var(--brand-emerald)]" />
    </span>
  );
}

type StatusTone = "paid" | "pending" | "expired" | "completed" | "live" | "info";

const STATUS_STYLES: Record<StatusTone, string> = {
  // Settled money and finished work: emerald, the state colour.
  paid: "border-[var(--brand-emerald-border)] bg-[var(--brand-emerald-soft)] text-[#047857]",
  completed:
    "border-[var(--brand-emerald-border)] bg-[var(--brand-emerald-soft)] text-[#047857]",
  live: "border-[var(--brand-emerald-border)] bg-[var(--brand-emerald-soft)] text-[#047857]",
  // Waiting on someone: amber.
  pending: "border-[#F6DFAE] bg-[#FDF6E7] text-[#92610A]",
  // Dead: red, used once or twice at most.
  expired: "border-[#F6C9C9] bg-[#FDEDED] text-[#B42318]",
  // Neutral metadata, not a state.
  info: "border-[var(--brand-blue-border)] bg-[var(--brand-blue-soft)] text-[#0052D6]",
};

/**
 * The application's status pill, reproduced exactly.
 *
 * Thin outline + tint + uppercase micro-type, because that is what the real
 * tables use. A visitor who later signs in should recognise these, which is
 * the whole argument for not inventing a prettier marketing version.
 */
export function StatusBadge({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-[2px] font-mono text-[10px] font-medium uppercase leading-none tracking-[0.06em]",
        STATUS_STYLES[tone],
        className,
      )}
    >
      {tone === "live" ? <LiveDot /> : null}
      {children}
    </span>
  );
}

/* ─── Product chrome ───────────────────────────────────────────────────── */

/**
 * The frame every piece of product UI on this page sits inside.
 *
 * A window bar with a path label, a hairline border and one soft shadow. The
 * shadow is the only elevation on the page: it is what separates "this is the
 * application" from "this is a marketing card", and spending it anywhere else
 * would flatten that distinction.
 *
 * `label` is a route, not a title — `/app/customers/acme-co` tells a visitor
 * this is a real screen at a real URL far more cheaply than a caption does.
 */
export function ProductFrame({
  label,
  children,
  className,
  live = false,
  /** Hide the window bar for an inline fragment rather than a full screen. */
  bare = false,
}: {
  label?: string;
  children: React.ReactNode;
  className?: string;
  live?: boolean;
  bare?: boolean;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-[#E2E8F0] bg-white",
        "shadow-[0_1px_2px_rgba(10,17,40,0.04),0_12px_32px_-16px_rgba(10,17,40,0.18)]",
        className,
      )}
    >
      {!bare ? (
        <div className="flex items-center gap-2 border-b border-[#E9EFF6] bg-[#F8FAFC] px-3 py-2">
          <span className="flex gap-1.5" aria-hidden>
            <span className="size-2 rounded-full bg-[#E2E8F0]" />
            <span className="size-2 rounded-full bg-[#E2E8F0]" />
            <span className="size-2 rounded-full bg-[#E2E8F0]" />
          </span>
          {label ? (
            <span className="truncate font-mono text-[10.5px] text-[#64748B]">
              {label}
            </span>
          ) : null}
          {live ? (
            <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-[#047857]">
              <LiveDot />
              live
            </span>
          ) : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** A labelled panel inside a product frame. Mirrors the app's Card. */
export function Panel({
  title,
  caption,
  action,
  children,
  className,
}: {
  title?: string;
  caption?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border-[#E9EFF6]", className)}>
      {title ? (
        <div className="flex items-baseline justify-between gap-3 border-b border-[#E9EFF6] px-4 py-2.5">
          <div>
            <div className="text-[12.5px] font-semibold text-[#0F172A]">
              {title}
            </div>
            {caption ? (
              <div className="mt-0.5 text-[11px] text-[#64748B]">{caption}</div>
            ) : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/**
 * The application's StatCard.
 *
 * Tabular numerals so a row of these keeps its decimal alignment — the detail
 * that separates a financial interface from a dashboard template.
 */
export function StatCard({
  label,
  value,
  caption,
  delta,
  tone = "default",
}: {
  label: string;
  value: string;
  caption?: string;
  /** e.g. "+24%". Rendered emerald when it starts with +, red with −. */
  delta?: string;
  tone?: "default" | "warning";
}) {
  const up = delta?.startsWith("+");
  return (
    <div className="border-[#E9EFF6] px-4 py-3.5">
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-[#64748B]">
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span
          className={cn(
            "font-display text-[22px] font-semibold leading-none tracking-[-0.02em] tabular-nums",
            tone === "warning" ? "text-[#92610A]" : "text-[#0A1128]",
          )}
        >
          {value}
        </span>
        {delta ? (
          <span
            className={cn(
              "font-mono text-[10.5px] font-medium tabular-nums",
              up ? "text-[#047857]" : "text-[#B42318]",
            )}
          >
            {up ? "↑" : "↓"} {delta.replace(/^[+-]/, "")}
          </span>
        ) : null}
      </div>
      {caption ? (
        <div className="mt-1 text-[11px] text-[#64748B]">{caption}</div>
      ) : null}
    </div>
  );
}

/** Compact table header cell, at the app's data density. */
export function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        "whitespace-nowrap border-b border-[#E9EFF6] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#64748B]",
        right ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

/** Compact table cell. `mono` for ids, amounts and dates. */
export function Td({
  children,
  right,
  mono,
  strong,
}: {
  children: React.ReactNode;
  right?: boolean;
  mono?: boolean;
  strong?: boolean;
}) {
  return (
    <td
      className={cn(
        "border-b border-[#F1F5F9] px-3 py-2 text-[12px]",
        right && "text-right",
        mono && "font-mono tabular-nums",
        strong ? "font-medium text-[#0F172A]" : "text-[#4A5568]",
      )}
    >
      {children}
    </td>
  );
}

/* ─── Media placeholder ────────────────────────────────────────────────── */

/**
 * Stand-in for a product screenshot or recording that does not exist yet.
 *
 * Deliberately NOT an illustration. The rule for this page is that a feature
 * is shown in the product or not shown at all, so when an asset is missing the
 * honest thing is a correctly-proportioned, labelled slot that reads as
 * "capture pending" — not a stock graphic standing in for a screen nobody has
 * taken. It keeps the layout truthful about what is real.
 *
 * Every current section renders live markup instead, so this is here for the
 * recordings (`.mp4`/`.gif`) that are still to be captured.
 */
export function MediaPlaceholder({
  label,
  ratio = "16 / 9",
  className,
}: {
  label: string;
  /** CSS aspect-ratio string. Reserves the box so nothing shifts on load. */
  ratio?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-lg border border-dashed border-[#E2E8F0] bg-[#F8FAFC]",
        className,
      )}
      style={{ aspectRatio: ratio }}
    >
      <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-[#64748B]">
        {label}
      </span>
    </div>
  );
}

/* ─── Actions ──────────────────────────────────────────────────────────── */

/**
 * The page's two buttons.
 *
 * Primary is deep navy, not blue: on a page where blue already means "link",
 * a blue filled button competes with every inline link for the same meaning.
 * Navy reads as the single committed action, and the hover is a shade shift
 * rather than a transform — software, not a marketing animation.
 */
export function CtaButton({
  href,
  variant = "primary",
  children,
  className,
}: {
  href: string;
  variant?: "primary" | "secondary";
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      className={cn(
        "inline-flex h-11 items-center justify-center gap-1.5 rounded-md px-5 text-[14px] font-semibold transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-blue)]",
        variant === "primary"
          ? "bg-[#0F172A] text-white hover:bg-[#1E293B]"
          : "border border-[#E2E8F0] bg-white text-[#0F172A] hover:border-[#C9D4E2] hover:bg-[#F8FAFC]",
        className,
      )}
    >
      {children}
    </a>
  );
}
