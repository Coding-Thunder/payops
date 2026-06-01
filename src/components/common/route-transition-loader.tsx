"use client";

import { usePathname, useSearchParams } from "next/navigation";
import * as React from "react";

/**
 * RouteTransitionLoader, Stripe-style hairline progress bar fixed to the top
 * edge. Mounted once inside the authenticated layout.
 *
 * Detection model:
 *  - START: capture clicks on internal anchors (Next.js <Link> renders an
 *    anchor) that lead to a different URL. Cheap, observable, no Radix/React
 *    insertion-effect interaction.
 *  - END: pathname + searchParams change → real navigation completed.
 *  - SAFETY NET: a 10s watchdog clears the bar if something goes sideways
 *    (offline, navigation aborted) so it never gets stuck.
 *
 * Programmatic router.push() navigations don't trigger the bar; the route
 * segment's loading.tsx skeleton covers that case instead, which is the
 * primary navigation feedback mechanism in this app.
 */
export function RouteTransitionLoader() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [active, setActive] = React.useState(false);
  const finishTimer = React.useRef<number | null>(null);
  const watchdog = React.useRef<number | null>(null);
  const firstRender = React.useRef(true);

  // Stop the bar when the URL actually changes.
  React.useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (watchdog.current) {
      window.clearTimeout(watchdog.current);
      watchdog.current = null;
    }
    if (finishTimer.current) window.clearTimeout(finishTimer.current);
    // Brief tail so the bar visually completes rather than vanishing.
    finishTimer.current = window.setTimeout(() => setActive(false), 200);
    return () => {
      if (finishTimer.current) window.clearTimeout(finishTimer.current);
    };
  }, [pathname, searchParams]);

  React.useEffect(() => {
    function isInternalNav(target: EventTarget | null): boolean {
      if (!(target instanceof Element)) return false;
      const anchor = target.closest("a");
      if (!anchor) return false;
      const href = anchor.getAttribute("href");
      if (!href) return false;
      // Modifier keys = open-in-tab/window. Don't show progress.
      const target_attr = anchor.getAttribute("target");
      if (target_attr && target_attr !== "_self") return false;
      // Hash-only links don't navigate.
      if (href.startsWith("#")) return false;
      // Downloads aren't navigations.
      if (anchor.hasAttribute("download")) return false;
      try {
        const url = new URL(href, window.location.href);
        if (url.origin !== window.location.origin) return false;
        // Skip if it's pointing at the current URL.
        if (
          url.pathname === window.location.pathname &&
          url.search === window.location.search
        ) {
          return false;
        }
      } catch {
        return false;
      }
      return true;
    }

    function onClick(e: MouseEvent) {
      if (e.defaultPrevented) return;
      if (e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (!isInternalNav(e.target)) return;
      if (finishTimer.current) {
        window.clearTimeout(finishTimer.current);
        finishTimer.current = null;
      }
      if (watchdog.current) window.clearTimeout(watchdog.current);
      setActive(true);
      // Safety net, guarantees the bar never gets stuck if something
      // cancels the navigation silently.
      watchdog.current = window.setTimeout(() => {
        setActive(false);
        watchdog.current = null;
      }, 10_000);
    }

    document.addEventListener("click", onClick, { capture: true });
    return () => {
      document.removeEventListener("click", onClick, { capture: true });
      if (finishTimer.current) window.clearTimeout(finishTimer.current);
      if (watchdog.current) window.clearTimeout(watchdog.current);
    };
  }, []);

  if (!active) return null;
  return (
    <div className="route-progress" role="status" aria-label="Loading page">
      <div className="route-progress__bar" />
    </div>
  );
}
