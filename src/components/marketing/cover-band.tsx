import Link from "next/link";
import { ArrowRightIcon, CheckIcon } from "lucide-react";

/**
 * Cover band, the chargeback-document header style.
 *
 * Bold block headline ("WHEN A CHARGEBACK LANDS / SIX WEEKS LATER, /
 * THE EVIDENCE IS ALREADY FILED") with the closing phrase set in
 * the reference's saturated emerald. Shield mark on the right side.
 * Navy-tinted dark background, not obsidian, matches the
 * reference's distinct blue cast.
 *
 * No marketing eyebrows, no centered hero composition. This reads
 * as the cover sheet of an operational artifact, not a SaaS hero.
 */
export function CoverBand() {
  return (
    <header
      className="relative isolate overflow-hidden"
      style={{ background: "var(--ink-navy)" }}
    >
      {/* Background: Unsplash analytics-dashboard photo, darkened so
          the cover-sheet headline + emerald accent still read like
          an operational artifact rather than a marketing hero.
          To swap: change the URL below. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-20 bg-cover bg-center"
        style={{
          backgroundImage:
            "url(https://images.unsplash.com/photo-1551288049-bebda4e38f71?auto=format&fit=crop&w=1920&q=80)",
          filter: "brightness(0.45) saturate(0.9)",
        }}
      />
      {/* Dark gradient: pin the headline area dark so the bold block
          type stays high-contrast. Lighter towards the right where
          the emerald shield accent sits. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "linear-gradient(110deg, color-mix(in oklch, var(--ink-navy) 92%, transparent) 0%, color-mix(in oklch, var(--ink-navy) 70%, transparent) 55%, color-mix(in oklch, var(--ink-navy) 55%, transparent) 100%)",
        }}
      />
      {/* Emerald radial wash: preserved from the original cover band
          so the brand color still pulls through. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-0"
        style={{
          background:
            "radial-gradient(ellipse 60% 60% at 90% 30%, color-mix(in oklch, var(--success) 18%, transparent) 0%, transparent 70%)",
        }}
      />

      <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-y-10 px-6 pt-16 pb-20 sm:px-10 sm:pt-20 sm:pb-24 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:items-center lg:gap-x-10">
        {/* Left: bold block headline */}
        <div className="text-white">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-white/55">
            TraceTxn · case file
          </p>

          <h1 className="mt-7 text-balance text-[clamp(2.6rem,7vw,5.4rem)] font-bold leading-[0.96] tracking-[-0.03em] text-white">
            When a chargeback{" "}
            <br className="hidden sm:inline" />
            lands six weeks later,{" "}
            <br className="hidden sm:inline" />
            <span
              className="inline-flex items-baseline gap-3"
              style={{ color: "oklch(0.74 0.18 148)" }}
            >
              evidence is filed.
              <span
                aria-hidden
                className="inline-flex shrink-0 translate-y-[-4px] items-center justify-center rounded-full"
                style={{
                  background: "oklch(0.62 0.17 148)",
                  width: "clamp(2rem,5vw,3.4rem)",
                  height: "clamp(2rem,5vw,3.4rem)",
                }}
              >
                <CheckIcon
                  className="text-white"
                  style={{ width: "55%", height: "55%" }}
                  strokeWidth={3}
                />
              </span>
            </span>
          </h1>

          <p className="mt-6 max-w-[58ch] text-[15.5px] leading-relaxed text-white/72">
            Complete evidence. Verified integrity. Case won. One
            operational backbone for the full transaction lifecycle -
            hashed evidence chain, hosted consent, multi-gateway
            orchestration. Built for retail, services, repair,
            dealership, B2B, and every commerce shape that takes money
            seriously.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-4 text-[13px]">
            <Link
              href="/signup"
              className="group inline-flex items-center gap-2 rounded-md bg-white px-4 py-2.5 font-semibold text-[oklch(0.17_0.045_240)] transition-all hover:-translate-y-px"
            >
              Start free
              <ArrowRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <a
              href="#evidence"
              className="inline-flex items-center px-1 text-white/70 transition-colors hover:text-white"
            >
              Read a case file ↓
            </a>
          </div>
        </div>

        {/* Right: shield mark, green, with radiating rays.
            Matches the reference's decorative anchor on the cover. */}
        <ShieldMark />
      </div>
    </header>
  );
}

function ShieldMark() {
  const green = "oklch(0.62 0.17 148)";
  const greenSoft = "oklch(0.78 0.18 148)";
  return (
    <div className="relative mx-auto hidden h-[14rem] w-[14rem] items-center justify-center lg:flex">
      {/* Radiating rays */}
      <svg
        aria-hidden
        viewBox="0 0 224 224"
        className="absolute inset-0"
        fill="none"
      >
        {[
          [112, 8, 112, 28],
          [196, 28, 184, 44],
          [216, 112, 196, 112],
          [196, 196, 184, 184],
          [28, 28, 40, 44],
        ].map(([x1, y1, x2, y2], i) => (
          <line
            key={i}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={greenSoft}
            strokeWidth="2"
            strokeLinecap="round"
            opacity="0.7"
          />
        ))}
      </svg>

      {/* Shield body */}
      <svg
        viewBox="0 0 160 180"
        className="relative h-[80%] w-[80%]"
        fill="none"
      >
        <path
          d="M 80 8 L 144 30 L 144 96 C 144 132 116 162 80 172 C 44 162 16 132 16 96 L 16 30 Z"
          fill="oklch(0.17 0.045 240)"
          stroke={green}
          strokeWidth="3"
        />
        <path
          d="M 56 92 L 74 110 L 110 70"
          stroke={green}
          strokeWidth="6"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    </div>
  );
}
