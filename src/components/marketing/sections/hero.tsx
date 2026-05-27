import { ScreenshotFrame } from "../mocks/screenshot-frame";

/**
 * Hero — Apple-iPhone-17-style obsidian canvas.
 *
 *  - Single oversized editorial headline with one accent word in
 *    cosmic-orange. No competing display elements.
 *  - Single primary CTA → quotation. Secondary is a scroll cue.
 *  - Three aurora orbs drift behind the type — orange / ultraviolet /
 *    cobalt — to introduce the color palette the rest of the page
 *    inherits via per-section themes.
 *  - The product canvas (evidence chain, not the dashboard) bleeds
 *    out the bottom of the section into the next chapter.
 *  - A monospace marquee strip at the very bottom previews the
 *    gateway lineup — Stripe today, Razorpay/Adyen/Authorize.net next.
 *
 * No fake browser chrome on the hero screenshot — chrome reads
 * "marketing artifact", we read "real product".
 */
export function Hero() {
  return (
    <section
      id="hero"
      data-theme="obsidian"
      className="relative isolate overflow-hidden pt-36 sm:pt-44 lg:pt-52 pb-0"
    >
      {/* ── Aurora orbs ─────────────────────────────────────────── */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div
          data-aurora
          className="absolute -left-[12%] top-[8%] size-[42rem] rounded-full opacity-60 blur-3xl"
          style={{
            background:
              "radial-gradient(circle, var(--m-orange) 0%, transparent 60%)",
            animation: "aurora-drift 18s ease-in-out infinite",
          }}
        />
        <div
          data-aurora
          className="absolute right-[-8%] top-[20%] size-[36rem] rounded-full opacity-50 blur-3xl"
          style={{
            background:
              "radial-gradient(circle, var(--m-ultraviolet) 0%, transparent 60%)",
            animation: "aurora-drift 22s ease-in-out infinite 4s",
          }}
        />
        <div
          data-aurora
          className="absolute left-[20%] top-[55%] size-[30rem] rounded-full opacity-45 blur-3xl"
          style={{
            background:
              "radial-gradient(circle, var(--m-cobalt) 0%, transparent 60%)",
            animation: "aurora-drift 26s ease-in-out infinite 8s",
          }}
        />
        {/* Fine grid — Apple-like spatial cue */}
        <div
          className="absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              "linear-gradient(to right, rgba(255,255,255,0.4) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.4) 1px, transparent 1px)",
            backgroundSize: "48px 48px",
            maskImage:
              "radial-gradient(ellipse 70% 50% at 50% 30%, black 30%, transparent 80%)",
          }}
        />
      </div>

      <div className="mx-auto w-full max-w-[1280px] px-6 lg:px-10">
        <div className="mx-auto max-w-4xl text-center">
          <p
            data-reveal
            data-reveal-order={0}
            className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-3.5 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.22em] text-white/70 backdrop-blur"
          >
            <span
              data-pulse
              className="size-1.5 rounded-full bg-[color:var(--m-orange)]"
              style={{ animation: "pulse-soft 2.2s ease-in-out infinite" }}
            />
            Payment operations · Privately deployed
          </p>

          <h1
            data-reveal
            data-reveal-order={1}
            className="text-balance text-[clamp(2.75rem,7.5vw,6.25rem)] font-semibold leading-[0.98] tracking-[-0.038em] text-white"
          >
            When the chargeback{" "}
            <span
              className="bg-clip-text text-transparent"
              style={{
                backgroundImage:
                  "linear-gradient(95deg, var(--m-orange) 0%, oklch(0.78 0.18 30) 50%, var(--m-ultraviolet) 100%)",
                backgroundSize: "200% 100%",
                animation: "gradient-shift 8s ease-in-out infinite",
              }}
            >
              lands six weeks later,
            </span>{" "}
            the evidence is already filed.
          </h1>

          <p
            data-reveal
            data-reveal-order={2}
            className="mx-auto mt-7 max-w-2xl text-[16.5px] leading-relaxed text-white/70"
          >
            Lifecycle visibility, hashed evidence chain, and
            multi-gateway orchestration — deployed to a domain you own.
            Reserved for one merchant per instance.
          </p>

          <div
            data-reveal
            data-reveal-order={3}
            className="mt-10 flex flex-wrap items-center justify-center gap-3"
          >
            <a
              href="/signup"
              className="group inline-flex h-12 items-center gap-2 rounded-full bg-white px-6 text-[14px] font-semibold text-[color:var(--m-ink)] transition-all hover:-translate-y-px hover:shadow-[0_8px_32px_-8px_rgba(255,255,255,0.6)]"
            >
              Sign up free
              <span
                aria-hidden
                className="transition-transform group-hover:translate-x-0.5"
              >
                →
              </span>
            </a>
            <a
              href="#quote"
              className="inline-flex h-12 items-center px-4 text-[13.5px] text-white/65 transition-colors hover:text-white"
            >
              Or talk to sales ↓
            </a>
          </div>
        </div>

        {/* Hero product canvas — bleeds into the next chapter. */}
        <div
          data-reveal
          data-reveal-order={4}
          data-parallax="0.06"
          className="relative mx-auto mt-20 max-w-[1100px] sm:mt-24"
        >
          {/* Glow halo behind the screenshot */}
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-16 -z-10 rounded-[2rem] opacity-70 blur-3xl"
            style={{
              background:
                "radial-gradient(ellipse 60% 60% at 50% 60%, color-mix(in oklch, var(--m-orange) 35%, transparent) 0%, transparent 70%)",
            }}
          />
          <ScreenshotFrame
            src="/marketing/evidence-chain.webp"
            alt="PayOps evidence chain — hash-linked record of an order's lifecycle"
            bare
            priority
            className="ring-1 ring-white/10 shadow-[0_50px_120px_-30px_rgba(0,0,0,0.7)]"
          />
        </div>
      </div>

      {/* ── Marquee strip: gateway lineup ───────────────────────── */}
      <div
        aria-label="Supported gateways"
        className="relative mt-24 overflow-hidden border-y border-white/10 bg-white/[0.02] py-6"
      >
        <div
          data-marquee
          className="flex w-max items-center gap-14 whitespace-nowrap font-mono text-[12.5px] uppercase tracking-[0.18em] text-white/55"
          style={{ animation: "marquee-x 38s linear infinite" }}
        >
          {Array.from({ length: 2 }).flatMap((_, i) =>
            MARQUEE_ITEMS.map((item) => (
              <span
                key={`${item.label}-${i}`}
                className="inline-flex items-center gap-2.5"
              >
                <span
                  className="size-1.5 rounded-full"
                  style={{ background: item.dot }}
                />
                {item.label}
              </span>
            )),
          )}
        </div>
      </div>
    </section>
  );
}

const MARQUEE_ITEMS = [
  { label: "Stripe · live", dot: "var(--m-sage)" },
  { label: "Razorpay · next", dot: "var(--m-cobalt)" },
  { label: "Authorize.net · next", dot: "var(--m-cobalt)" },
  { label: "Adyen · roadmap", dot: "var(--m-ultraviolet)" },
  { label: "PayPal · roadmap", dot: "var(--m-ultraviolet)" },
  { label: "Manual · wire / ACH", dot: "var(--m-orange)" },
  { label: "SOC-style audit chain", dot: "var(--m-sage)" },
  { label: "Hashed evidence", dot: "var(--m-orange)" },
  { label: "Hosted consent", dot: "var(--m-ultraviolet)" },
  { label: "Realtime SSE", dot: "var(--m-cobalt)" },
];
