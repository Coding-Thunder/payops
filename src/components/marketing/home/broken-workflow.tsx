"use client";

import {
  CreditCardIcon,
  FileTextIcon,
  FolderIcon,
  MailIcon,
  MessageCircleIcon,
  MessageSquareIcon,
  SquareCheckIcon,
  TableIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Reveal, Eyebrow } from "./primitives";

interface Tool {
  name: string;
  holds: string;
  Icon: LucideIcon;
  /** tiny rotation for the scattered look */
  tilt: string;
}

const TOOLS: Tool[] = [
  { name: "Gmail", holds: "The invoice thread", Icon: MailIcon, tilt: "-rotate-2" },
  { name: "Google Drive", holds: "The signed contract — v2? v3?", Icon: FolderIcon, tilt: "rotate-1" },
  { name: "ClickUp", holds: "The task where scope changed", Icon: SquareCheckIcon, tilt: "rotate-2" },
  { name: "Slack", holds: "The client's “sounds good”", Icon: MessageSquareIcon, tilt: "-rotate-1" },
  { name: "WhatsApp", holds: "A voice note approving the design", Icon: MessageCircleIcon, tilt: "rotate-2" },
  { name: "Stripe", holds: "Which invoices actually cleared", Icon: CreditCardIcon, tilt: "-rotate-2" },
  { name: "Notion", holds: "The original proposal", Icon: FileTextIcon, tilt: "rotate-1" },
  { name: "A spreadsheet", holds: "Your own notes. Maybe.", Icon: TableIcon, tilt: "-rotate-1" },
];

/**
 * Why the usual setup fails. Eight tools, each holding one fragment of
 * the answer — laid out slightly askew so it *feels* like the mess it
 * describes. The takeaway line does the closing.
 */
export function BrokenWorkflow() {
  return (
    <section className="relative border-t border-white/8 bg-white/[0.015]">
      <div className="mx-auto max-w-[1140px] px-6 py-24 sm:py-28 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <Reveal>
            <Eyebrow className="justify-center">Why the usual setup fails</Eyebrow>
          </Reveal>
          <Reveal delay={0.05}>
            <h2 className="mt-5 font-display text-[32px] font-semibold leading-[1.1] tracking-[-0.025em] text-white sm:text-[40px]">
              It&apos;s in there somewhere.
              <br />
              <span className="text-white/50">That&apos;s exactly the problem.</span>
            </h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="mt-6 text-[16px] leading-relaxed text-white/60">
              None of these tools are wrong. But not one of them holds the whole
              story — so answering one client question turns into eight open
              tabs and a lost afternoon.
            </p>
          </Reveal>
        </div>

        <div className="mt-14 grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
          {TOOLS.map((t, i) => (
            <Reveal key={t.name} delay={0.04 * i}>
              <div
                className={cn(
                  "group h-full rounded-xl border border-white/10 bg-[#0d0f12] p-4 transition-all duration-300",
                  "hover:-translate-y-1 hover:border-white/20 hover:bg-[#111318]",
                  t.tilt,
                  "hover:rotate-0",
                )}
              >
                <div className="flex items-center gap-2.5">
                  <span className="grid size-8 place-items-center rounded-lg bg-white/6 text-white/55 ring-1 ring-inset ring-white/8">
                    <t.Icon className="size-4" />
                  </span>
                  <span className="text-[13.5px] font-semibold text-white/85">
                    {t.name}
                  </span>
                </div>
                <p className="mt-3 text-[12.5px] leading-snug text-white/45">
                  {t.holds}
                </p>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal delay={0.1}>
          <p className="mx-auto mt-12 max-w-xl text-center text-[17px] font-medium text-white">
            Eight tools. One question.{" "}
            <span className="text-emerald-300">No single answer.</span>
          </p>
        </Reveal>
      </div>
    </section>
  );
}
