"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import {
  clarityBootstrapScript,
  isClarityTrackedPath,
  isValidClarityProjectId,
} from "@/lib/analytics/clarity";

/**
 * Microsoft Clarity, scoped to the public marketing pages.
 *
 * Mounted once from the root layout. `projectId` is threaded in as a prop from
 * the server rather than read from env here — the same shape as
 * `TurnstileWidget`, which keeps the component pure and keeps every
 * `process.env` read inside `@/lib/env`.
 *
 * Renders nothing when the project id is absent or malformed, so an
 * unconfigured environment (local dev, `.env.test`, `.env.smoke`, CI) loads no
 * third-party script and behaves exactly as it did before Clarity existed.
 *
 * NO USER IDENTIFICATION. `identify()`, `setTag()`, `event()` and `upgrade()`
 * are deliberately never called: their arguments are sent to Microsoft verbatim
 * and are the usual way PII leaks out of a Clarity install. Everything we want
 * — sessions, pageviews, recordings, heatmaps, scroll depth, rage/dead clicks,
 * journeys, device, geo, referrer — Clarity derives on its own. Adding one of
 * those calls is a privacy decision, not a refactor.
 *
 * ── How the route boundary is actually held ──────────────────────────────
 *
 * Clarity is a single-page-app recorder: it proxies `history.pushState` /
 * `replaceState`, and on a URL change it stops and then RESTARTS itself 250 ms
 * later, re-walking whatever DOM is on screen and re-logging the URL and title
 * (verified in the shipped `scripts.clarity.ms/0.8.69/clarity.js`: `go()` wraps
 * the history methods, `vo()` does `stop()` then `setTimeout(restart, 250)`).
 *
 * So unmounting `<Script>` does not stop a recording, and neither does reacting
 * after the fact — a React passive effect runs after commit AND after paint, by
 * which point the denied page is on screen and Clarity's 250 ms restart timer is
 * already armed. Reloading from that effect loses the race whenever the
 * replacement document takes longer than 250 ms to arrive, which a
 * `force-dynamic`, database-backed page behind a CDN reliably does.
 *
 * The fix is to never let the crossing be a client-side navigation at all. The
 * capture-phase click listener below intercepts any same-origin link whose
 * destination is not on the allow-list and lets the BROWSER navigate instead of
 * Next's router. A full document load means a new CSP (without the Clarity
 * hosts), a new document, and no recorder — enforced by the browser rather than
 * by winning a timing race.
 */

/** Also the `next/script` de-duplication key for the inline bootstrap. */
const CLARITY_SCRIPT_ID = "ms-clarity";

export interface ClarityAnalyticsProps {
  /**
   * Public Clarity project id (`NEXT_PUBLIC_CLARITY_PROJECT_ID`). When empty,
   * absent or malformed the component renders null and nothing is loaded.
   */
  projectId: string | null | undefined;
}

export function ClarityAnalytics({ projectId }: ClarityAnalyticsProps) {
  const pathname = usePathname();
  const id = projectId?.trim() || null;
  const enabled = isValidClarityProjectId(id);
  const tracked = enabled && isClarityTrackedPath(pathname);

  /**
   * PRIMARY CONTROL — force a full document load on the way out.
   *
   * Marketing chrome links to `/login` and `/signup` with Next `<Link>`s (16
   * such links across `src/components/marketing/**` and `src/app/error.tsx`).
   * Each would be a soft navigation, carrying the live recorder into a denied
   * route. Intercepting here rather than editing all 16 means a link added
   * tomorrow is covered too, and no product component has to know Clarity
   * exists.
   *
   * `stopPropagation` in the CAPTURE phase is the whole mechanism: React 19
   * delegates to the root container, so stopping the event at `document` means
   * `<Link>`'s onClick never runs. We deliberately do NOT call
   * `preventDefault()` — with Next's handler out of the way, the browser's own
   * default action for an `<a href>` is exactly the hard navigation we want.
   */
  useEffect(() => {
    if (!tracked) return;

    function interceptCrossingClick(event: MouseEvent) {
      // Leave anything the browser already handles specially alone: modified
      // clicks and middle-clicks open a new context, which is its own document.
      if (event.defaultPrevented) return;
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.hasAttribute("download")) return;
      if (anchor.target && anchor.target !== "_self") return;

      let destination: URL;
      try {
        destination = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      // Cross-origin already leaves this document; the recorder cannot follow.
      if (destination.origin !== window.location.origin) return;
      // Tracked → tracked stays a soft navigation. Clarity handles it natively
      // (its own restart logs the new page), and forcing a reload here would
      // make every marketing page transition flash for no privacy gain.
      if (isClarityTrackedPath(destination.pathname)) return;

      // Denied destination: keep it out of the router so the browser performs a
      // real navigation and this document — recorder included — is discarded.
      event.stopPropagation();
    }

    document.addEventListener("click", interceptCrossingClick, true);
    return () =>
      document.removeEventListener("click", interceptCrossingClick, true);
  }, [tracked]);

  /**
   * BACKSTOP — only for a crossing the click listener cannot see.
   *
   * A programmatic `router.push`/`replace` from a tracked page would bypass the
   * listener. No marketing route does that today, so in practice this never
   * fires; it exists so that if one ever does, the session is cut short rather
   * than followed into a denied route.
   *
   * Be honest about its strength: this is the post-hoc path described above and
   * it can lose the 250 ms race, so it is a mitigation, not the boundary. The
   * boundary is the click listener plus the per-route CSP.
   */
  const injected = useRef(false);
  useEffect(() => {
    if (tracked) {
      injected.current = true;
      return;
    }
    if (!injected.current) return;
    // Cleared first so a StrictMode second pass is a no-op, and so a reload can
    // never cascade: the fresh document starts with `false`.
    injected.current = false;
    window.location.reload();
  }, [tracked]);

  if (!tracked || !id) return null;

  return (
    <Script
      id={CLARITY_SCRIPT_ID}
      // Analytics is the case `afterInteractive` exists for: loaded early, but
      // never ahead of the app's own hydration. `beforeInteractive` is only
      // supported unconditionally from the root layout, which would defeat the
      // per-route scoping; `worker` does not work in the App Router.
      strategy="afterInteractive"
      // The official install snippet. See `clarityBootstrapScript` for why the
      // tag URL cannot simply be given to `<Script src>` — it is only half the
      // snippet and throws without the command-queue stub. The id is validated
      // against /^[a-z0-9]{1,32}$/ and JSON-escaped before it reaches here.
      dangerouslySetInnerHTML={{ __html: clarityBootstrapScript(id) }}
    />
  );
}
