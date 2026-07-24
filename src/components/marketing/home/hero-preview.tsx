"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { SearchIcon, CornerDownLeftIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { DEMO_CLIENT, DEMO_SEARCH_RESULTS, formatUsd } from "./demo";
import { KIND_VISUALS } from "./kind-visuals";

/**
 * The hero's self-driving proof: type "Vela" → results surface → the
 * client record opens with totals and a live timeline. Loops forever,
 * quietly. If the visitor never reads a word, the animation alone says
 * "search a client, get their entire history."
 *
 * Respects prefers-reduced-motion by snapping straight to the opened
 * record and never looping.
 */

type Phase = "idle" | "typing" | "results" | "record";

const QUERY = "Vela";
const recent = DEMO_CLIENT.timeline.slice(-4).reverse();

export function HeroPreview() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [typed, setTyped] = useState("");
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const at = (ms: number, fn: () => void) =>
      timers.current.push(window.setTimeout(fn, ms));

    if (reduced) {
      // Snap to the opened record on the next tick — deferring keeps the
      // state update out of the synchronous effect body.
      at(0, () => {
        setTyped(QUERY);
        setPhase("record");
      });
    } else {
      const run = () => {
        setPhase("typing");
        setTyped("");
        const start = 500;
        for (let i = 0; i < QUERY.length; i += 1) {
          at(start + i * 150, () => setTyped(QUERY.slice(0, i + 1)));
        }
        const doneTyping = start + QUERY.length * 150;
        at(doneTyping + 250, () => setPhase("results"));
        at(doneTyping + 1600, () => setPhase("record"));
        at(doneTyping + 8200, () => {
          setPhase("idle");
          setTyped("");
          at(900, run);
        });
      };
      // Defer the first run so no state is set synchronously on mount.
      at(0, run);
    }

    return () => {
      timers.current.forEach((t) => clearTimeout(t));
      timers.current = [];
    };
  }, []);

  return (
    <div className="relative">
      {/* Ambient emerald glow behind the window */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-x-10 -top-10 bottom-0 -z-10 opacity-70 blur-3xl"
        style={{
          background:
            "radial-gradient(60% 55% at 50% 0%, rgba(52,211,153,0.16), transparent 70%)",
        }}
      />

      <div className="overflow-hidden rounded-2xl border border-white/12 bg-[#0c0e11]/90 shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)] backdrop-blur-sm">
        {/* window chrome */}
        <div className="flex items-center gap-2 border-b border-white/8 px-4 py-3">
          <div className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
          </div>
          <span className="ml-2 font-mono text-[11px] text-white/35">
            traceTxn — workspace
          </span>
        </div>

        {/* command bar */}
        <div className="px-4 pt-4">
          <div
            className={cn(
              "flex items-center gap-3 rounded-xl border px-3.5 py-3 transition-colors duration-300",
              phase === "typing" || phase === "results"
                ? "border-emerald-400/30 bg-emerald-400/[0.04]"
                : "border-white/12 bg-white/[0.03]",
            )}
          >
            <SearchIcon className="size-4 shrink-0 text-white/40" />
            <div className="flex-1 text-[14px] text-white">
              {typed || (
                <span className="text-white/35">Search clients, invoices, approvals…</span>
              )}
              {(phase === "typing" || phase === "idle") && (
                <span className="ml-0.5 inline-block h-4 w-px translate-y-0.5 animate-pulse bg-emerald-400" />
              )}
            </div>
            <kbd className="hidden items-center gap-1 rounded-md border border-white/12 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-white/40 sm:inline-flex">
              ⌘K
            </kbd>
          </div>
        </div>

        {/* body: results OR the opened record */}
        <div className="relative min-h-[360px] px-4 pb-4 pt-3">
          <AnimatePresence mode="wait">
            {phase === "results" && (
              <motion.ul
                key="results"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.22 }}
                className="space-y-1"
              >
                {DEMO_SEARCH_RESULTS.map((r, i) => (
                  <motion.li
                    key={r.label}
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.05 + i * 0.06 }}
                    className={cn(
                      "flex items-center justify-between rounded-lg px-3 py-2.5",
                      r.primary
                        ? "bg-emerald-400/10 ring-1 ring-inset ring-emerald-400/20"
                        : "hover:bg-white/[0.03]",
                    )}
                  >
                    <span
                      className={cn(
                        "text-[13.5px] font-medium",
                        r.primary ? "text-white" : "text-white/75",
                      )}
                    >
                      {r.label}
                    </span>
                    <span className="font-mono text-[11px] text-white/40">
                      {r.meta}
                    </span>
                  </motion.li>
                ))}
                <li className="flex items-center justify-end gap-1.5 px-3 pt-1 text-[11px] text-white/35">
                  open record
                  <CornerDownLeftIcon className="size-3" />
                </li>
              </motion.ul>
            )}

            {phase === "record" && (
              <motion.div
                key="record"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              >
                {/* record header */}
                <div className="flex items-center gap-3">
                  <div className="grid size-11 place-items-center rounded-xl bg-gradient-to-br from-emerald-400/25 to-emerald-400/5 font-display text-[15px] font-semibold text-emerald-300 ring-1 ring-inset ring-emerald-400/25">
                    {DEMO_CLIENT.initials}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-display text-[16px] font-semibold text-white">
                        {DEMO_CLIENT.name}
                      </span>
                      <span className="rounded-full bg-white/8 px-2 py-0.5 font-mono text-[10px] text-white/50">
                        since {DEMO_CLIENT.since}
                      </span>
                    </div>
                    <span className="text-[12px] text-white/45">
                      {DEMO_CLIENT.company}
                    </span>
                  </div>
                </div>

                {/* stat row */}
                <div className="mt-4 grid grid-cols-4 gap-2">
                  {[
                    { k: "Billed", v: formatUsd(DEMO_CLIENT.totals.billed) },
                    { k: "Paid", v: formatUsd(DEMO_CLIENT.totals.paid), accent: true },
                    { k: "Invoices", v: String(DEMO_CLIENT.totals.invoices) },
                    { k: "Approvals", v: String(DEMO_CLIENT.totals.approvals) },
                  ].map((s, i) => (
                    <motion.div
                      key={s.k}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.15 + i * 0.05 }}
                      className="rounded-lg border border-white/8 bg-white/[0.02] px-2.5 py-2"
                    >
                      <div className="text-[10px] uppercase tracking-wide text-white/40">
                        {s.k}
                      </div>
                      <div
                        className={cn(
                          "mt-0.5 font-display text-[15px] font-semibold tabular-nums",
                          s.accent ? "text-emerald-300" : "text-white",
                        )}
                      >
                        {s.v}
                      </div>
                    </motion.div>
                  ))}
                </div>

                {/* mini timeline */}
                <div className="mt-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-white/40">
                      Timeline
                    </span>
                    <span className="font-mono text-[10px] text-white/30">
                      9 events
                    </span>
                  </div>
                  <ol className="relative space-y-2.5 before:absolute before:bottom-2 before:left-[13px] before:top-2 before:w-px before:bg-white/10">
                    {recent.map((e, i) => {
                      const v = KIND_VISUALS[e.kind];
                      return (
                        <motion.li
                          key={e.id}
                          initial={{ opacity: 0, x: -8 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: 0.28 + i * 0.09 }}
                          className="relative flex items-start gap-3 pl-0"
                        >
                          <span
                            className={cn(
                              "z-10 mt-0.5 grid size-[27px] shrink-0 place-items-center rounded-full ring-4 ring-[#0c0e11]",
                              v.tone === "emerald"
                                ? "bg-emerald-400/15 text-emerald-300"
                                : "bg-white/8 text-white/60",
                            )}
                          >
                            <v.Icon className="size-3.5" />
                          </span>
                          <div className="min-w-0 flex-1 pb-0.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-[13px] font-medium text-white/90">
                                {e.title}
                              </span>
                              {typeof e.amount === "number" && (
                                <span className="shrink-0 font-mono text-[12px] tabular-nums text-emerald-300">
                                  {formatUsd(e.amount)}
                                </span>
                              )}
                            </div>
                            <span className="text-[11.5px] text-white/40">
                              {e.date}
                            </span>
                          </div>
                        </motion.li>
                      );
                    })}
                  </ol>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
