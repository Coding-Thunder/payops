"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { MenuIcon, XIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Mobile navigation for the two marketing headers.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * Both headers put their nav in a container that is `hidden md:flex`, so
 * below 768px the links were not merely cramped — they were removed from the
 * page with nothing to reveal them. A journey audit found a visitor on a
 * phone could reach neither the nav nor, on the landing page, sign-in.
 *
 * ── Why a disclosure and not a Sheet ─────────────────────────────────────
 *
 * `components/ui/sheet` exists and the app shell uses it, but it portals a
 * focus-trapped dialog — right for an authenticated sidebar, heavy for four
 * marketing links. This is a plain disclosure: a button that owns
 * `aria-expanded` and `aria-controls`, and a panel that is simply absent from
 * the DOM when closed, so there are no hidden-but-focusable links.
 *
 * ── The three things that make it usable ─────────────────────────────────
 *
 *  1. It closes on route change. Next.js keeps the layout mounted across
 *     navigations, so otherwise the panel hangs over the new page. State
 *     holds the pathname the panel was opened at and is cleared the moment
 *     that no longer matches — a render-time adjustment, not an effect, so
 *     no frame ever commits with the panel over the new page.
 *  2. Escape closes it and returns focus to the trigger, which is where a
 *     keyboard user expects to be.
 *  3. `md:hidden` on the wrapper — desktop never renders it, so the existing
 *     desktop nav is untouched and no link is duplicated to assistive tech
 *     at desktop widths.
 *
 * `actions` is the slot at the foot of the panel, for a CTA the bar drops
 * below `md` — the landing header's "See the product" is `md:inline-flex`, so
 * the panel carries the copy that everything under 768px sees.
 *
 * A caller's `actions` CTA MUST use the same breakpoint as this wrapper's
 * `md:hidden`. When it was `sm:inline-flex` the thresholds disagreed, and
 * between 640 and 767px both copies rendered — visible twice, and twice in
 * the tab order — for anyone on a landscape phone or a narrowed window.
 *
 * Sign in is NOT routed through here: it stays in the bar at every width,
 * because the audit's finding was precisely that reaching it must not require
 * opening a menu.
 */

export interface MobileNavLink {
  href: string;
  label: string;
}

interface MobileNavProps {
  links: readonly MobileNavLink[];
  /** Rendered at the foot of the panel, e.g. Sign in. */
  actions?: React.ReactNode;
  /** Matches the host header's chrome. */
  panelClassName?: string;
  linkClassName?: string;
  triggerClassName?: string;
}

export function MobileNav({
  links,
  actions,
  panelClassName,
  linkClassName,
  triggerClassName,
}: MobileNavProps) {
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();

  // The route the panel was opened on, or null when it is closed.
  const [openedAt, setOpenedAt] = useState<string | null>(null);

  // Navigation closes the panel. This is the render-time adjustment React
  // prescribes for state that must react to a changed input — guarded, so it
  // settles in one extra render and never loops. Doing it in an effect would
  // mean a committed frame with the panel still over the new page, and would
  // cascade a second render pass.
  //
  // Clearing (rather than comparing `openedAt === pathname` on the fly) is
  // what makes a there-and-back navigation safe: a stale match would pop the
  // panel open again the moment the user returned to the route they opened
  // it on. An in-page anchor (/#faq) leaves `pathname` untouched, so those
  // are closed from the link's own onClick below.
  if (openedAt !== null && openedAt !== pathname) {
    setOpenedAt(null);
  }

  const open = openedAt !== null;
  const close = useCallback(() => setOpenedAt(null), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      // Put focus back where the user left it, not at the top of the page.
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  return (
    <div className={cn("md:hidden", triggerClassName)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpenedAt(open ? null : pathname)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "Close menu" : "Open menu"}
        className="inline-flex size-9 items-center justify-center rounded-md border border-border text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
      >
        {open ? (
          <XIcon aria-hidden className="size-4" />
        ) : (
          <MenuIcon aria-hidden className="size-4" />
        )}
      </button>

      {/* Absent, not hidden, when closed — a `hidden` panel still exposes its
          links to the tab order in some browsers. */}
      {open ? (
        <div
          id={panelId}
          className={cn(
            "absolute inset-x-0 top-full border-b border-border bg-white shadow-[0_8px_24px_-16px_rgba(15,23,42,0.25)]",
            panelClassName,
          )}
        >
          <nav aria-label="Mobile" className="mx-auto max-w-[1280px] px-6 py-3">
            <ul className="flex flex-col">
              {links.map((l) => (
                <li key={l.href}>
                  <Link
                    href={l.href}
                    // Same-page anchors don't change `pathname`, so close here.
                    onClick={close}
                    className={cn(
                      "block rounded px-1 py-2.5 text-[14px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground",
                      linkClassName,
                    )}
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
            {actions ? (
              <div className="mt-2 flex flex-col gap-2 border-t border-border pt-3">
                {actions}
              </div>
            ) : null}
          </nav>
        </div>
      ) : null}
    </div>
  );
}
