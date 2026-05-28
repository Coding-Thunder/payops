"use client";

import Link from "next/link";
import * as React from "react";

import { cn } from "@/lib/utils";

const SECTIONS: Array<{ href: string; label: string }> = [
  { href: "#disputes", label: "Disputes" },
  { href: "#lifecycle", label: "Lifecycle" },
  { href: "#shapes", label: "Shapes" },
  { href: "#gateways", label: "Gateways" },
  { href: "#enterprise", label: "Trust" },
  { href: "#orgs", label: "Workflows" },
];

/**
 * Theme-aware sticky nav. Reads `body[data-active-theme]` (set by the
 * GSAP controller's IntersectionObserver) and adapts tone:
 *
 *   - On `obsidian` / `cobalt` / `closing` (dark themes) it inverts to
 *     translucent dark with white text.
 *   - On light themes it stays neutral / cream.
 *
 * Sign in sits left of the primary CTA so the signup button stays
 * visually dominant; operators still need a quick path back to the
 * authed app from the public surface.
 */
export function MarketingNav() {
  const [scrolled, setScrolled] = React.useState(false);
  const [dark, setDark] = React.useState(true);

  React.useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  React.useEffect(() => {
    const sync = () => {
      const t = document.body.dataset.activeTheme;
      // Dark sections: the hero (obsidian) and the mid-page Commerce
      // Shapes spec sheet (graphite). Both flip the nav into its
      // dark variant so the foreground stays legible.
      setDark(t === "obsidian" || t === "graphite" || !t);
    };
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-active-theme"],
    });
    return () => obs.disconnect();
  }, []);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-[background,border,color,box-shadow] duration-300",
        // Always show a glassy bar — the previous `bg-transparent`
        // at rest made it look like floating text, not a navbar.
        // Always-on subtle glass + bottom hairline gives the nav
        // visible "body" without painting the hero. Scrolled state
        // amps the opacity so nothing behind it bleeds through.
        dark
          ? scrolled
            ? "border-b border-white/10 bg-black/80 text-white shadow-[0_8px_30px_-12px_rgba(0,0,0,0.7)] backdrop-blur-xl backdrop-saturate-150"
            : "border-b border-white/8 bg-black/35 text-white backdrop-blur-lg backdrop-saturate-150"
          : scrolled
            ? "border-b border-border/60 bg-background/90 text-foreground shadow-[0_6px_20px_-12px_rgba(0,0,0,0.18)] backdrop-blur-xl backdrop-saturate-150"
            : "border-b border-border/40 bg-background/70 text-foreground backdrop-blur-lg backdrop-saturate-150",
      )}
    >
      <div className="mx-auto flex h-16 w-full max-w-[1280px] items-center justify-between px-6 lg:px-10">
        <Link
          href="/"
          className="group inline-flex items-center gap-2.5"
          aria-label="TraceTxn home"
        >
          <span
            className={cn(
              "grid size-7 place-items-center rounded-md transition-colors",
              dark
                ? "bg-white text-[color:var(--m-ink)]"
                : "bg-foreground text-background",
            )}
          >
            <svg
              viewBox="0 0 48 48"
              className="size-4"
              aria-hidden
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect x="10" y="13" width="28" height="5" rx="2.5" fill="currentColor" />
              <rect x="21.5" y="13" width="5" height="24" rx="2.5" fill="currentColor" />
            </svg>
          </span>
          <span className="text-[15px] font-semibold tracking-tight">
            TraceTxn
          </span>
        </Link>

        <nav
          aria-label="Sections"
          className={cn(
            "hidden items-center gap-7 text-[13px] md:flex",
            dark ? "text-white/65" : "text-muted-foreground",
          )}
        >
          {SECTIONS.map((s) => (
            <a
              key={s.href}
              href={s.href}
              className={cn(
                "transition-colors",
                dark ? "hover:text-white" : "hover:text-foreground",
              )}
            >
              {s.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-1 sm:gap-2">
          <Link
            href="/login"
            className={cn(
              "inline-flex h-9 items-center rounded-full px-3 text-[13px] font-medium transition-colors",
              dark
                ? "text-white/75 hover:text-white"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className={cn(
              "inline-flex h-9 items-center rounded-full px-4 text-[13px] font-semibold transition-all hover:-translate-y-px",
              dark
                ? "bg-white text-[color:var(--m-ink)] hover:shadow-[0_6px_24px_-6px_rgba(255,255,255,0.5)]"
                : "bg-foreground text-background hover:opacity-90",
            )}
          >
            Sign up free
          </Link>
        </div>
      </div>
    </header>
  );
}
