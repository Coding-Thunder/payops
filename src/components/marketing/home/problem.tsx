"use client";

import { Reveal, Eyebrow } from "./primitives";

/**
 * The problem, told as a moment. An agency owner should read the client
 * message and physically wince — they've received that exact text. We
 * name the real enemy (lost context) only after the feeling lands.
 */
export function Problem() {
  return (
    <section id="problem" className="relative border-t border-white/8">
      <div className="mx-auto max-w-[1140px] px-6 py-24 sm:py-28 lg:px-8">
        <div className="grid items-center gap-14 lg:grid-cols-[1fr_1fr] lg:gap-16">
          {/* message mock */}
          <Reveal className="order-2 lg:order-1">
            <div className="relative mx-auto max-w-md">
              <div className="mb-3 flex items-center gap-2 text-[12px] text-white/40">
                <span className="size-2 rounded-full bg-emerald-400/70" />
                <span className="font-mono">
                  Message from a client · 6 months later
                </span>
              </div>
              <div className="rounded-2xl rounded-tl-sm border border-white/10 bg-white/[0.04] p-5 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.8)]">
                <div className="flex items-center gap-2.5">
                  <div className="grid size-8 place-items-center rounded-full bg-white/10 font-display text-[12px] font-semibold text-white/70">
                    P
                  </div>
                  <div className="leading-tight">
                    <div className="text-[13px] font-medium text-white">
                      Priya · Vela Skincare
                    </div>
                    <div className="font-mono text-[10.5px] text-white/35">
                      today, 9:14 AM
                    </div>
                  </div>
                </div>
                <p className="mt-4 text-[15px] leading-relaxed text-white/80">
                  “Hey! Quick one — can you resend the final invoice from our
                  project? And can you confirm the second landing page wasn&apos;t
                  in the original scope? I don&apos;t think we approved that as
                  included. 🙏”
                </p>
              </div>
              <div className="mt-4 rounded-xl border border-dashed border-white/12 bg-transparent px-4 py-3 text-[13px] text-white/45">
                You know you&apos;re right.
                <span className="text-white/70"> You just have to prove it.</span>
              </div>
            </div>
          </Reveal>

          {/* copy */}
          <div className="order-1 lg:order-2">
            <Reveal>
              <Eyebrow>The problem</Eyebrow>
            </Reveal>
            <Reveal delay={0.05}>
              <h2 className="mt-5 font-display text-[32px] font-semibold leading-[1.1] tracking-[-0.025em] text-white sm:text-[40px]">
                The hard part was never the work.
                <br />
                <span className="text-white/50">
                  It&apos;s remembering what happened.
                </span>
              </h2>
            </Reveal>
            <Reveal delay={0.1}>
              <p className="mt-6 text-[16px] leading-relaxed text-white/60">
                Payments, projects, tasks — you have tools for those. But months
                after a project ships, a client comes back asking for an old
                invoice, questioning the scope, or disputing what was approved.
              </p>
            </Reveal>
            <Reveal delay={0.15}>
              <p className="mt-4 text-[16px] leading-relaxed text-white/60">
                The information exists. It&apos;s just scattered across email,
                chat, drives, and a payment dashboard — and reconstructing it
                costs you an afternoon you&apos;ll never bill for.
              </p>
            </Reveal>
            <Reveal delay={0.2}>
              <p className="mt-6 text-[17px] font-medium leading-relaxed text-white">
                The real problem isn&apos;t payments or project management.
                It&apos;s{" "}
                <span className="text-emerald-300">lost context.</span>
              </p>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  );
}
