"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { SiteWordmark } from "@/components/brand/site-wordmark";
import { cn } from "@/lib/utils";

/**
 * Marketing navigation.
 *
 * Deliberately under-designed. The product frame below it is the thing that
 * has to hold attention, and a nav with its own gradient, its own blur
 * personality and a mega-menu competes with that. One hairline, one wordmark,
 * four links, two buttons.
 *
 * Transparent at rest and solid once scrolled, so the hero reads as one
 * surface on load but the nav stays legible over the product screenshots
 * further down.
 *
 * ── On the CTAs ──────────────────────────────────────────────────────────
 *
 * The primary action is "Join the beta" → /waitlist, not "Start free trial"
 * → /signup. That is not a copy preference: `/signup` checks
 * `signupInviteAccepted()` and redirects anyone without an invite straight to
 * /waitlist, so a "free trial" button would promise an account the gate will
 * not grant and bounce the visitor somewhere they did not ask to go. The
 * secondary action points at the on-page walkthrough (`#demo`) because that
 * is where the product actually is — there is no hosted sandbox to link to,
 * and labelling an anchor "live demo" would be the same kind of small lie.
 */

// Root-relative anchors, not bare fragments. SiteHeader is shared chrome —
// /pricing renders it too — and a bare "#beta" there scrolls to nothing
// because the id only exists on the homepage. On the homepage these still
// scroll in-page, so the absolute form costs nothing and is the only form
// that works from both routes.
const LINKS = [
  { href: "/#product", label: "Product" },
  { href: "/#use-cases", label: "Use cases" },
  { href: "/#beta", label: "Pricing" },
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
          <Link
            href="/#demo"
            className="hidden h-9 items-center rounded-md border border-[#E2E8F0] bg-white px-3.5 text-[13px] font-semibold text-[#0F172A] transition-colors hover:border-[#C9D4E2] hover:bg-[#F8FAFC] sm:inline-flex"
          >
            See the product
          </Link>
          <Link
            href="/waitlist"
            className="inline-flex h-9 items-center rounded-md bg-[#0F172A] px-3.5 text-[13px] font-semibold text-white transition-colors hover:bg-[#1E293B]"
          >
            Join the beta
          </Link>
        </div>
      </nav>
    </header>
  );
}
