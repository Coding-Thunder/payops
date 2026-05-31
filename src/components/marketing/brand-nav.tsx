"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRightIcon } from "lucide-react";

import { LogoLockup } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Brand-v1 top nav. Sticky, switches to a hairline-divider chrome
 * once the user scrolls past the hero so the header doesn't compete
 * with the page background.
 *
 * Inspired by Stripe / Linear / Ramp: thin, calm, generous left
 * indent for the wordmark, a small nav, a primary CTA on the right.
 * No mega-menus, no animated underlines — restraint is the point.
 */

const NAV_LINKS = [
  { href: "#features", label: "Features" },
  { href: "#evidence", label: "Evidence" },
  { href: "#integrations", label: "Integrations" },
  { href: "#pricing", label: "Pricing" },
] as const;

export function BrandNav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "sticky top-0 z-40 w-full transition-[background,border-color,backdrop-filter] duration-200",
        scrolled
          ? "bg-white/85 backdrop-blur-md border-b border-border"
          : "bg-transparent border-b border-transparent",
      )}
    >
      <div className="mx-auto flex h-14 max-w-[1280px] items-center justify-between gap-6 px-6 lg:px-10">
        <Link href="/" aria-label="TraceTxn home">
          <LogoLockup size="sm" />
        </Link>

        <nav className="hidden items-center gap-6 md:flex">
          {NAV_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="hidden sm:inline-flex text-[12.5px]"
          >
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild size="sm" className="gap-1.5 text-[12.5px]">
            <Link href="/signup">
              Get started
              <ArrowRightIcon className="size-3.5" />
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
