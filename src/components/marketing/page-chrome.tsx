"use client";

import Link from "next/link";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Document chrome, the persistent frame around the landing page.
 *
 * Not a marketing nav. This is the chrome a document has: a slim
 * utility band at the top, and a sticky vertical anchor rail on the
 * left that reads like a table of contents. As the visitor scrolls,
 * the rail highlights which document region they're in.
 *
 * The chrome stays visible across the entire page. Regions below
 * don't carry their own headers, the rail is the index of the
 * document, the regions are the document body.
 */

export interface DocumentAnchor {
  id: string;
  label: string;
  index: string;
}

const ANCHORS: DocumentAnchor[] = [
  { id: "how-it-works", label: "How it works", index: "01" },
  { id: "audience", label: "Who it's for", index: "02" },
  { id: "features", label: "Features", index: "03" },
  { id: "comparison", label: "Comparison", index: "04" },
  { id: "evidence", label: "Evidence", index: "05" },
  { id: "integrity", label: "Security", index: "06" },
  { id: "gateways", label: "Gateways", index: "07" },
  { id: "setup", label: "Setup", index: "08" },
];

/* ─────────────────────────── Top band ───────────────────────────────── */

export function TopBand() {
  return (
    <div className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-12 max-w-[1280px] items-center gap-4 px-6 lg:px-10">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-foreground transition-opacity hover:opacity-80"
          aria-label="TraceTxn"
        >
          <span className="grid size-6 place-items-center rounded-[5px] bg-foreground text-background">
            <svg
              viewBox="0 0 48 48"
              className="size-3.5"
              aria-hidden
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect x="10" y="13" width="28" height="5" rx="2.5" fill="currentColor" />
              <rect
                x="21.5"
                y="13"
                width="5"
                height="24"
                rx="2.5"
                fill="currentColor"
              />
            </svg>
          </span>
          <span className="text-[13.5px] font-semibold tracking-tight">
            TraceTxn
          </span>
        </Link>

        <span className="ml-1 hidden font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground sm:inline">
          · operational payment infrastructure
        </span>

        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <Link
            href="/login"
            className="inline-flex h-7 items-center px-2.5 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className="inline-flex h-7 items-center rounded-md bg-foreground px-3 text-[12.5px] font-medium text-background transition-opacity hover:opacity-90"
          >
            Start free
          </Link>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── Document rail ──────────────────────────── */

/**
 * Sticky left rail. Vertical anchor list with active-region tracking
 * via IntersectionObserver. Reads as a table of contents, not a nav.
 *
 * Active state is a flat 2px emerald rail on the left edge, same
 * accent the app shell uses, so chrome reads as one product.
 */
export function DocumentRail() {
  const [active, setActive] = React.useState<string>(ANCHORS[0].id);

  React.useEffect(() => {
    const elements = ANCHORS.map((a) => document.getElementById(a.id)).filter(
      (el): el is HTMLElement => Boolean(el),
    );
    if (elements.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Track the topmost element currently above the 1/3 mark, the
        // standard "you are here" heuristic for a long scrolling doc.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      {
        rootMargin: "-30% 0px -55% 0px",
        threshold: 0,
      },
    );
    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <nav
      aria-label="Document sections"
      className="hidden lg:block lg:sticky lg:top-20 lg:self-start"
    >
      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70">
        Document
      </p>
      <ol className="space-y-1">
        {ANCHORS.map((a) => (
          <li key={a.id}>
            <a
              href={`#${a.id}`}
              className={cn(
                "group relative grid grid-cols-[1.75rem_1fr] items-baseline gap-2 py-1 transition-colors",
                active === a.id
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {active === a.id ? (
                <span
                  aria-hidden
                  className="absolute -left-3 top-1/2 h-3.5 w-[2px] -translate-y-1/2 rounded-r-full bg-success"
                />
              ) : null}
              <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground/70">
                {a.index}
              </span>
              <span
                className={cn(
                  "text-[12.5px] leading-tight",
                  active === a.id ? "font-medium" : "",
                )}
              >
                {a.label}
              </span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
