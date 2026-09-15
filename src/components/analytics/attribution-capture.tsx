"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { captureAttribution } from "@/lib/analytics/attribution";

/**
 * Records where the visitor came from, once per session.
 *
 * Mounted from the root layout so every entry point is covered — an ad can
 * land on any page, and a landing page added tomorrow needs no wiring. The
 * capture itself decides whether the current route is safe to record
 * (`isAttributionSafePath`), so this component stays free of route knowledge.
 *
 * Renders nothing, touches no network, and stores only in first-party
 * `sessionStorage`. Re-runs on navigation because the FIRST page of a session
 * may be a route where capture is refused (a password-reset link, say); the
 * next marketing page the visitor opens should still count as the first
 * touch rather than being lost.
 *
 * Runs in an effect, not during render, because it reads `location` and
 * `document.referrer` and writes storage — none of which exist during SSR,
 * and all of which would make the render impure.
 */
export function AttributionCapture() {
  const pathname = usePathname();

  useEffect(() => {
    captureAttribution();
  }, [pathname]);

  return null;
}
