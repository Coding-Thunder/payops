import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";

/**
 * Cover band — full-width dark moment at the head of the document.
 *
 * Reads as the cover sheet of an operational artifact. Same visual
 * language as the in-app case-file header (dark obsidian, mono
 * metadata, emerald integrity dot). The "marketing hero" lives
 * inside this cover, not as a separate marketing layer above it.
 *
 * No CTA chrome on the cover itself — the utility CTAs live in the
 * top band that sits above. The cover is the document opening, not
 * a marketing pitch.
 */
export function CoverBand() {
  return (
    <header className="bg-[oklch(0.13_0.012_286)] text-white">
      <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-y-10 gap-x-12 px-6 py-14 sm:px-10 sm:py-16 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] lg:gap-y-0 lg:py-20">
        {/* Left: document metadata + thesis */}
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/55">
            TraceTxn · operational payment infrastructure
          </p>

          <h1 className="mt-7 max-w-[20ch] text-balance text-[clamp(2.4rem,5.6vw,4.2rem)] font-semibold leading-[1.02] tracking-[-0.025em] text-white">
            When the chargeback lands six weeks later, the evidence is
            already filed.
          </h1>

          <p className="mt-7 max-w-[58ch] text-[15.5px] leading-relaxed text-white/72">
            One operational backbone for the full transaction lifecycle —
            lifecycle visibility, hashed evidence chain, hosted consent,
            multi-gateway orchestration. Built for retail, services,
            repair, dealership, B2B, and every commerce shape that takes
            money seriously.
          </p>

          <div className="mt-9 inline-flex items-center gap-4 text-[13px]">
            <Link
              href="/signup"
              className="group inline-flex items-center gap-2 rounded-md bg-white px-3.5 py-2 font-medium text-[oklch(0.13_0.012_286)] transition-all hover:-translate-y-px"
            >
              Start free
              <ArrowRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <a
              href="#evidence"
              className="inline-flex items-center px-1 text-white/70 transition-colors hover:text-white"
            >
              Read the evidence document ↓
            </a>
          </div>
        </div>

        {/* Right: document spec table — reads as "this is what the
            artifact below contains", reframes the hero as the cover
            of a real document. */}
        <aside className="flex flex-col justify-center">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-white/55">
            Document spec
          </p>
          <dl className="mt-3.5 grid grid-cols-[8rem_1fr] gap-y-2 font-mono text-[12px] tabular-nums text-white/70">
            <dt className="text-white/45">Artifact</dt>
            <dd className="text-white/90">case-file · v1</dd>
            <dt className="text-white/45">Lifecycle</dt>
            <dd className="text-white/90">10 canonical states</dd>
            <dt className="text-white/45">Gateways</dt>
            <dd className="text-white/90">stripe live · 4 next</dd>
            <dt className="text-white/45">Integrity</dt>
            <dd className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block size-1.5 rounded-full bg-emerald-300"
              />
              <span className="text-emerald-300">sha-256 chained</span>
            </dd>
            <dt className="text-white/45">Retention</dt>
            <dd className="text-white/90">paid · refunded · disputed · ∞</dd>
            <dt className="text-white/45">Tenancy</dt>
            <dd className="text-white/90">multi-tenant · isolated</dd>
          </dl>
        </aside>
      </div>
    </header>
  );
}
