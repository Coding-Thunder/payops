"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { FileIcon, SearchIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { DEMO_CLIENT, formatUsd, type TimelineEvent } from "./demo";
import { KIND_VISUALS } from "./kind-visuals";
import { Reveal, Eyebrow } from "./primitives";

const tl = DEMO_CLIENT.timeline;
const feed = [...tl].reverse();
const invoices = tl.filter((e) => e.kind === "invoice");
const payments = tl.filter((e) => e.kind === "payment");
const approvals = tl.filter(
  (e) => e.kind === "approval" || e.kind === "agreement",
);

const FILES = [
  { name: "proposal.pdf", meta: "Sent · Jan 9" },
  { name: "msa-v2-signed.pdf", meta: "Signed · Jan 12" },
  { name: "brand-directions.pdf", meta: "Shared · Jan 20" },
  { name: "homepage-v4.png", meta: "Approved · Feb 20" },
  { name: "brand-guidelines.pdf", meta: "Delivered · Mar 8" },
  { name: "handoff-pack.zip", meta: "Delivered · Mar 8" },
];

const TABS = [
  { key: "timeline", label: "Timeline", count: tl.length },
  { key: "invoices", label: "Invoices", count: invoices.length },
  { key: "payments", label: "Payments", count: payments.length },
  { key: "approvals", label: "Approvals", count: approvals.length },
  { key: "files", label: "Files", count: FILES.length },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function ProductDemo() {
  const [active, setActive] = useState<TabKey>("timeline");
  const touched = useRef(false);

  // Gently auto-advance through the tabs until the visitor takes over.
  useEffect(() => {
    if (touched.current) return;
    const id = window.setInterval(() => {
      if (touched.current) return;
      setActive((cur) => {
        const i = TABS.findIndex((t) => t.key === cur);
        return TABS[(i + 1) % TABS.length].key;
      });
    }, 2800);
    return () => clearInterval(id);
  }, []);

  const pick = (k: TabKey) => {
    touched.current = true;
    setActive(k);
  };

  return (
    <section id="demo" className="relative border-t border-white/8 bg-white/[0.015]">
      <div className="mx-auto max-w-[1140px] px-6 py-24 sm:py-28 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <Reveal>
            <Eyebrow className="justify-center">How it works</Eyebrow>
          </Reveal>
          <Reveal delay={0.05}>
            <h2 className="mt-5 font-display text-[32px] font-semibold leading-[1.1] tracking-[-0.025em] text-white sm:text-[40px]">
              Open a client. See everything.
            </h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="mt-6 text-[16px] leading-relaxed text-white/60">
              One record, every angle. Invoices, payments, approvals and files
              all live on the same history — no exports, no cross-referencing,
              no “which tool was that in.”
            </p>
          </Reveal>
        </div>

        <Reveal delay={0.1}>
          <div className="mx-auto mt-14 max-w-4xl overflow-hidden rounded-2xl border border-white/12 bg-[#0c0e11] shadow-[0_40px_120px_-40px_rgba(0,0,0,0.9)]">
            {/* record header */}
            <div className="flex flex-col gap-4 border-b border-white/8 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="grid size-11 place-items-center rounded-xl bg-gradient-to-br from-emerald-400/25 to-emerald-400/5 font-display text-[15px] font-semibold text-emerald-300 ring-1 ring-inset ring-emerald-400/25">
                  {DEMO_CLIENT.initials}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-display text-[16px] font-semibold text-white">
                      {DEMO_CLIENT.name}
                    </span>
                    <span className="rounded-full bg-white/8 px-2 py-0.5 font-mono text-[10px] text-white/50">
                      since {DEMO_CLIENT.since}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {DEMO_CLIENT.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded-md bg-white/5 px-1.5 py-0.5 text-[10.5px] text-white/45"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] text-white/35">
                <SearchIcon className="size-3.5" />
                <span className="font-mono">vela</span>
              </div>
            </div>

            {/* tabs + content */}
            <div className="grid sm:grid-cols-[200px_1fr]">
              {/* tab rail */}
              <div className="flex gap-1 overflow-x-auto border-b border-white/8 p-2 sm:flex-col sm:border-b-0 sm:border-r">
                {TABS.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => pick(t.key)}
                    className={cn(
                      "flex shrink-0 items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-colors sm:w-full",
                      active === t.key
                        ? "bg-emerald-400/10 text-white ring-1 ring-inset ring-emerald-400/20"
                        : "text-white/55 hover:bg-white/[0.04] hover:text-white",
                    )}
                  >
                    <span>{t.label}</span>
                    <span
                      className={cn(
                        "font-mono text-[11px]",
                        active === t.key ? "text-emerald-300" : "text-white/30",
                      )}
                    >
                      {t.count}
                    </span>
                  </button>
                ))}
              </div>

              {/* content */}
              <div className="min-h-[320px] p-4 sm:p-5">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={active}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                  >
                    {active === "timeline" && <TimelineView events={feed} />}
                    {active === "invoices" && (
                      <RowList
                        rows={invoices.map((e) => ({
                          key: e.id,
                          title: e.title.replace(" sent", ""),
                          sub: `${e.detail} · ${e.date}`,
                          amount: e.amount,
                          status: "Paid",
                        }))}
                      />
                    )}
                    {active === "payments" && (
                      <RowList
                        rows={payments.map((e) => ({
                          key: e.id,
                          title: "Payment received",
                          sub: `${e.detail} · ${e.date}`,
                          amount: e.amount,
                          status: "Cleared",
                        }))}
                      />
                    )}
                    {active === "approvals" && (
                      <RowList
                        rows={approvals.map((e) => ({
                          key: e.id,
                          title: e.title,
                          sub: `${e.detail} · ${e.date}`,
                          status: e.status ?? "Approved",
                        }))}
                      />
                    )}
                    {active === "files" && (
                      <div className="grid gap-2 sm:grid-cols-2">
                        {FILES.map((f) => (
                          <div
                            key={f.name}
                            className="flex items-center gap-3 rounded-lg border border-white/8 bg-white/[0.02] px-3 py-2.5"
                          >
                            <span className="grid size-8 place-items-center rounded-md bg-white/6 text-white/50">
                              <FileIcon className="size-4" />
                            </span>
                            <div className="min-w-0">
                              <div className="truncate font-mono text-[12.5px] text-white/80">
                                {f.name}
                              </div>
                              <div className="text-[11px] text-white/40">
                                {f.meta}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function TimelineView({ events }: { events: TimelineEvent[] }) {
  return (
    <ol className="relative space-y-3 before:absolute before:bottom-3 before:left-[15px] before:top-3 before:w-px before:bg-white/10">
      {events.map((e) => {
        const v = KIND_VISUALS[e.kind];
        return (
          <li key={e.id} className="relative flex items-start gap-3">
            <span
              className={cn(
                "z-10 mt-0.5 grid size-8 shrink-0 place-items-center rounded-full ring-4 ring-[#0c0e11]",
                v.tone === "emerald"
                  ? "bg-emerald-400/15 text-emerald-300"
                  : "bg-white/8 text-white/60",
              )}
            >
              <v.Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13.5px] font-medium text-white/90">
                  {e.title}
                </span>
                {typeof e.amount === "number" && (
                  <span className="shrink-0 font-mono text-[12.5px] tabular-nums text-emerald-300">
                    {formatUsd(e.amount)}
                  </span>
                )}
              </div>
              <div className="text-[12px] text-white/45">
                {e.detail} · {e.date}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

interface Row {
  key: string;
  title: string;
  sub: string;
  amount?: number;
  status?: string;
}

function RowList({ rows }: { rows: Row[] }) {
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div
          key={r.key}
          className="flex items-center justify-between gap-3 rounded-lg border border-white/8 bg-white/[0.02] px-4 py-3"
        >
          <div className="min-w-0">
            <div className="text-[13.5px] font-medium text-white/90">
              {r.title}
            </div>
            <div className="text-[12px] text-white/45">{r.sub}</div>
          </div>
          <div className="flex items-center gap-3">
            {typeof r.amount === "number" && (
              <span className="font-mono text-[13px] tabular-nums text-white">
                {formatUsd(r.amount)}
              </span>
            )}
            {r.status && (
              <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-400/20">
                {r.status}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
