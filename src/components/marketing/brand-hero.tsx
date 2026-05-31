import Link from "next/link";
import { ArrowRightIcon, CheckCircle2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Brand-v1 hero — replaces the obsidian CoverBand. Light-mode-first
 * per the brand spec (no pure-black backgrounds, no random gradients).
 *
 * Anatomy:
 *   - eyebrow chip: status-pill style
 *   - headline:    DM Sans display, big, tight tracking, balanced
 *                  to two lines on desktop
 *   - sub:         Geist body, secondary slate
 *   - dual CTA:    primary "Get started" + secondary "See evidence flow"
 *   - trust strip: small list of operational guarantees, each with a
 *                  small emerald check — the brand's voice of "this
 *                  is operational infrastructure, not marketing"
 *
 * Right column is a quiet diagrammatic illustration that picks up
 * the four-node trace from the logo — same vocabulary scaled up.
 * Stripe / Linear / Ramp restraint: one accent color, generous
 * whitespace, no oversized shadows.
 */
export function BrandHero() {
  return (
    <section className="relative overflow-hidden border-b border-border bg-[color:var(--background)]">
      {/* Quiet Cloud → White wash so the hero has subtle depth without
          a marketing gradient. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "linear-gradient(180deg, #F8FAFC 0%, #FFFFFF 100%)",
        }}
      />

      <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-y-12 px-6 pt-20 pb-24 sm:px-10 sm:pt-24 sm:pb-28 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:items-center lg:gap-x-16">
        {/* Left — copy */}
        <div className="max-w-2xl">
          <p className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-3 py-1 font-display text-[10.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ background: "var(--brand-emerald)" }}
            />
            The operating system for payment ops
          </p>

          <h1 className="mt-7 font-display text-[clamp(2.4rem,6.5vw,4.6rem)] font-medium leading-[1.05] tracking-[-0.025em] text-foreground">
            Track every transaction.{" "}
            <span className="block text-[color:var(--brand-emerald)] font-semibold">
              Evidence built automatically.
            </span>
          </h1>

          <p className="mt-6 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
            TraceTxn is the operational console between you and your payment
            processor. Lifecycle visibility on every order, a hashed
            evidence chain on every transition, hosted consent before the
            charge — so chargebacks resolve in your favour and your team
            spends time on growth, not paperwork.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Button asChild size="lg" className="gap-1.5">
              <Link href="/signup">
                Start your workspace
                <ArrowRightIcon className="size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="#evidence">See evidence flow</Link>
            </Button>
          </div>

          <ul className="mt-10 grid grid-cols-1 gap-y-2 text-[12.5px] text-muted-foreground sm:grid-cols-2 sm:gap-x-6">
            {[
              "Hashed evidence chain per order",
              "Per-org Stripe routing — your keys, encrypted",
              "Tenant-configurable order workflows",
              "Hosted consent + dispute-ready receipts",
            ].map((line) => (
              <li key={line} className="flex items-start gap-2">
                <CheckCircle2Icon
                  className="mt-[2px] size-3.5 shrink-0"
                  style={{ color: "var(--brand-emerald)" }}
                />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Right — diagrammatic trace illustration. Same vocabulary as
            the logo, scaled up to a hero-sized graphic. Calm, no
            decoration. Reads as "this is what the platform records." */}
        <div className="relative">
          <HeroTraceDiagram />
        </div>
      </div>
    </section>
  );
}

function HeroTraceDiagram() {
  // viewBox 600×420 — 1.43:1 landscape. Mirrors the four-node trace
  // from the logo but adds labelled event tags off each node so the
  // diagram doubles as a product preview: order → request → consent
  // → payment → evidence.
  const NODES: Array<{
    x: number;
    y: number;
    label: string;
    eyebrow: string;
    accent?: boolean;
  }> = [
    { x: 70, y: 200, eyebrow: "01", label: "Order created" },
    { x: 220, y: 200, eyebrow: "02", label: "Payment requested" },
    { x: 370, y: 280, eyebrow: "03", label: "Consent verified", accent: true },
    { x: 520, y: 200, eyebrow: "04", label: "Charge settled" },
  ];

  return (
    <div className="relative mx-auto max-w-[640px]">
      {/* Card chrome — Cloud surface with hairline border. Single
          restrained shadow per brand spec. */}
      <div className="overflow-hidden rounded-2xl border border-border bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between border-b border-border pb-4">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ background: "var(--brand-emerald)" }}
            />
            <span className="font-display text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground">
              Trace · order ORD-260601-A3F8
            </span>
          </div>
          <span className="font-mono text-[10.5px] text-muted-foreground">
            evidence chain
          </span>
        </div>

        <svg
          viewBox="0 0 600 420"
          className="mt-5 w-full"
          aria-hidden
        >
          {/* Backing grid — extremely subtle ledger tone */}
          <defs>
            <pattern
              id="grid"
              width="40"
              height="40"
              patternUnits="userSpaceOnUse"
            >
              <path
                d="M 40 0 L 0 0 0 40"
                fill="none"
                stroke="#E2E8F0"
                strokeWidth="0.5"
              />
            </pattern>
          </defs>
          <rect width="600" height="420" fill="url(#grid)" />

          {/* Trace path */}
          <path
            d={`M ${NODES[0]!.x} ${NODES[0]!.y} L ${NODES[1]!.x} ${NODES[1]!.y} L ${NODES[2]!.x} ${NODES[2]!.y} L ${NODES[3]!.x} ${NODES[3]!.y}`}
            stroke="#0F172A"
            strokeWidth="2.5"
            strokeLinecap="square"
            strokeLinejoin="miter"
            fill="none"
          />
          {/* Drop line on the consent node — emerald, matches logo */}
          <path
            d={`M ${NODES[2]!.x} ${NODES[2]!.y} V ${NODES[2]!.y + 50}`}
            stroke="#10B981"
            strokeWidth="2.5"
            strokeLinecap="square"
          />

          {/* Nodes */}
          {NODES.map((n) => (
            <g key={`${n.x}-${n.y}`}>
              <circle
                cx={n.x}
                cy={n.y}
                r="9"
                fill={n.accent ? "#10B981" : "#0F172A"}
              />
              <circle
                cx={n.x}
                cy={n.y}
                r="14"
                fill="none"
                stroke={n.accent ? "#10B981" : "#0F172A"}
                strokeOpacity="0.18"
                strokeWidth="1"
              />
            </g>
          ))}

          {/* Node labels */}
          {NODES.map((n) => {
            const above = n.y < 240;
            const labelY = above ? n.y - 28 : n.y + 38;
            const subY = above ? n.y - 44 : n.y + 56;
            return (
              <g key={`label-${n.x}`} textAnchor="middle">
                <text
                  x={n.x}
                  y={subY}
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  fontSize="10"
                  fill="#94A3B8"
                  letterSpacing="0.12em"
                >
                  {n.eyebrow}
                </text>
                <text
                  x={n.x}
                  y={labelY}
                  fontFamily="ui-sans-serif, system-ui, sans-serif"
                  fontSize="13"
                  fontWeight={n.accent ? 600 : 500}
                  fill="#0F172A"
                >
                  {n.label}
                </text>
              </g>
            );
          })}
        </svg>

        <div className="mt-5 grid grid-cols-3 gap-3 border-t border-border pt-4 text-[11px] text-muted-foreground">
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
              Status
            </div>
            <div className="mt-1 font-semibold text-foreground">
              Settled
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
              Hash
            </div>
            <div className="mt-1 font-mono text-foreground truncate">
              0x4a2b…f81e
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
              Events
            </div>
            <div className="mt-1 font-semibold text-foreground">
              7
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
