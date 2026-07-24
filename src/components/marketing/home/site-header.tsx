"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRightIcon } from "lucide-react";

import { cn } from "@/lib/utils";

const NAV = [
  { href: "#problem", label: "The problem" },
  { href: "#demo", label: "How it works" },
  { href: "#use-cases", label: "Use cases" },
  { href: "#faq", label: "FAQ" },
] as const;

/** Compact brand mark — a three-node "trace" that reads as connected history. */
function Wordmark() {
  return (
    <span className="flex items-center gap-2.5">
      <span className="relative grid size-7 place-items-center rounded-[7px] bg-emerald-400/10 ring-1 ring-inset ring-emerald-400/25">
        <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
          <path
            d="M5 17.5 10 9l4 5 5-8.5"
            fill="none"
            stroke="#34d399"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="5" cy="17.5" r="1.6" fill="#34d399" />
          <circle cx="19" cy="5.5" r="1.6" fill="#34d399" />
        </svg>
      </span>
      <span className="font-display text-[15px] font-semibold tracking-[-0.01em] text-white">
        TraceTxn
      </span>
    </span>
  );
}

export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 w-full transition-[background-color,border-color,backdrop-filter] duration-300",
        scrolled
          ? "border-b border-white/10 bg-[#08090b]/80 backdrop-blur-xl"
          : "border-b border-transparent bg-transparent",
      )}
    >
      <div className="mx-auto flex h-16 max-w-[1140px] items-center justify-between gap-6 px-6 lg:px-8">
        <Link href="/" aria-label="TraceTxn home">
          <Wordmark />
        </Link>

        <nav className="hidden items-center gap-8 md:flex">
          {NAV.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-[13px] font-medium text-white/55 transition-colors hover:text-white"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2.5">
          <Link
            href="/login"
            className="hidden rounded-lg px-3 py-2 text-[13px] font-medium text-white/70 transition-colors hover:text-white sm:inline-flex"
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className="group inline-flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-2 text-[13px] font-semibold text-[#08090b] shadow-[0_1px_0_0_rgba(255,255,255,0.6)_inset] transition-transform duration-150 hover:bg-white/90 active:translate-y-px"
          >
            Join the beta
            <ArrowRightIcon className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
          </Link>
        </div>
      </div>
    </header>
  );
}
