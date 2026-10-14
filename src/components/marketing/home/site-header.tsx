"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { SiteWordmark } from "@/components/brand/site-wordmark";
import { MobileNav } from "@/components/marketing/mobile-nav";
import { cn } from "@/lib/utils";

/**
 * Marketing navigation.
 *
 * Deliberately under-designed. The product frame below it is the thing that
 * has to hold attention, and a nav with its own gradient, its own blur
 * personality and a mega-menu competes with that. One hairline, one wordmark,
 * four links, two actions.
 *
 * ── Sign in is not optional ──────────────────────────────────────────────
 *
 * A returning customer's first move on this page is to log in. The redesign
 * in 947ea26 replaced the old Sign in / signup pair with "See the product" +
 * "Join the beta", and when the beta CTA was removed the header was left
 * with no way into the product at all — the only /login link on the page sat
 * in the footer, 16,268px down on a phone. Sign in now lives in the action
 * area beside the CTA, OUTSIDE the `md:flex` nav, so it survives at every
 * width and does not depend on opening the mobile menu. `/login` honours
 * `?next=`, so nothing here needs to construct one.
 *
 * Transparent at rest and solid once scrolled, so the hero reads as one
 * surface on load but the nav stays legible over the product screenshots
 * further down.
 *
 * ── On the CTA ───────────────────────────────────────────────────────────
 *
 * One action: the on-page walkthrough (`#demo`). There is no public sign-up
 * or beta application to point at — TraceTxn is invite-only — so the header
 * does not pretend otherwise. The anchor is not labelled "live demo" because
 * there is no hosted sandbox behind it; it scrolls to the product itself.
 */

// Root-relative anchors, not bare fragments. SiteHeader is shared chrome —
// /pricing renders it too — and a bare "#faq" there scrolls to the wrong
// section. On the homepage these still scroll in-page, so the absolute form
// costs nothing and is the only form that works from both routes. "Pricing"
// is a real route, not an anchor: the on-page beta-offer section it used to
// target no longer exists.
const LINKS = [
  { href: "/#product", label: "Product" },
  { href: "/#use-cases", label: "Use cases" },
  { href: "/pricing", label: "Pricing" },
  { href: "/#faq", label: "FAQ" },
];

export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    // 8px rather than 0 so a trackpad's rubber-band at the top of the page
    // doesn't flicker the border on and off.
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        // Do NOT add `relative` here to anchor the mobile panel. `cn` is
        // twMerge, which treats `relative` and `sticky` as the same position
        // group and keeps the last one — so adding it silently DELETES
        // `sticky`, and the header scrolls away on a 16,000px page, taking
        // Sign in with it. `sticky` is already a containing block for the
        // panel's `absolute`, so nothing extra is needed.
        "sticky top-0 z-50 w-full transition-colors duration-200",
        scrolled
          ? "border-b border-[#E2E8F0] bg-white/90 backdrop-blur-md"
          : "border-b border-transparent bg-transparent",
      )}
    >
      <nav
        aria-label="Main"
        className="mx-auto flex h-16 w-full max-w-[1180px] items-center gap-6 px-6 lg:px-8"
      >
        <Link href="/" aria-label="TraceTxn home" className="shrink-0">
          <SiteWordmark textClassName="text-[#0A1128]" />
        </Link>

        <ul className="ml-2 hidden items-center gap-1 md:flex">
          {LINKS.map((l) => (
            <li key={l.href}>
              <Link
                href={l.href}
                className="rounded px-3 py-2 text-[13.5px] font-medium text-[#4A5568] transition-colors hover:text-[#0A1128]"
              >
                {l.label}
              </Link>
            </li>
          ))}
        </ul>

        <div className="ml-auto flex items-center gap-2">
          {/* Always visible, every breakpoint. Not inside the nav above and
              not inside the mobile panel only — see the note at the top. */}
          <Link
            href="/login"
            className="inline-flex h-9 items-center rounded-md border border-[#E2E8F0] bg-white px-3.5 text-[13px] font-semibold text-[#0F172A] transition-colors hover:border-[#C9D4E2] hover:bg-[#F8FAFC] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0F172A]"
          >
            Sign in
          </Link>
          {/* `md:inline-flex`, not `sm:`, and that must stay in step with
              MobileNav's `md:hidden` wrapper. The two carry the same CTA, so
              if the bar's threshold is lower than the panel's, both are on
              screen — and both in the tab order — in the gap between them.
              At `sm` that gap was 640-767px: landscape phones and any
              narrowed window saw "See the product" twice. One breakpoint,
              one copy. */}
          <Link
            href="/#demo"
            className="hidden h-9 items-center rounded-md bg-[#0F172A] px-3.5 text-[13px] font-semibold text-white transition-colors hover:bg-[#1E293B] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0F172A] md:inline-flex"
          >
            See the product
          </Link>
          <MobileNav
            links={LINKS}
            actions={
              <Link
                href="/#demo"
                className="inline-flex h-10 items-center justify-center rounded-md bg-[#0F172A] px-4 text-[13.5px] font-semibold text-white transition-colors hover:bg-[#1E293B]"
              >
                See the product
              </Link>
            }
          />
        </div>
      </nav>
    </header>
  );
}
