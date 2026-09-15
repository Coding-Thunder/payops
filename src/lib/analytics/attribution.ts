/**
 * Lead attribution capture.
 *
 * The problem this solves: a visitor lands on `/client-management` from a
 * Google Ads click carrying `?utm_source=google&utm_campaign=…`, reads two
 * more pages, and only then fills in the waitlist form. By that point the
 * URL has no UTM parameters and `document.referrer` is our own site — the
 * attribution is gone. So it is captured on FIRST landing and held for the
 * session, then submitted with the lead.
 *
 * Deliberately session-scoped, not persistent:
 *   - `sessionStorage`, not a cookie, so nothing is sent on every request and
 *     nothing needs a consent banner it does not have. It is first-party,
 *     per-tab, and dies with the tab.
 *   - FIRST touch wins. A visitor who arrives from an ad and later navigates
 *     through an internal link with its own tracking params should still be
 *     credited to the ad. Overwriting on every page view would credit the
 *     last internal hop, which is worse than useless.
 *
 * Analytics is NOT the source of truth. This value rides along with the form
 * POST and is persisted by the server with the lead itself, so a blocked
 * analytics script cannot cost a lead or its attribution.
 *
 * Nothing here is trusted. Every field is re-validated and length-capped
 * server-side (`attributionSchema`), and none of it is used for any security
 * or ownership decision.
 *
 * ── The token hazard, and why landingPage is a PATH ONLY ─────────────────
 *
 * The obvious implementation stores `location.pathname + location.search` as
 * the landing page. That is a credential leak waiting to happen: this app has
 * routes whose URL IS the secret — `/reset-password/<token>`,
 * `/join/<token>`, `/activate?token=…`, plus `/pay/<id>` and `/consent/<id>`.
 * A visitor who opens a password-reset link and later applies for the beta
 * would write that reset token into a database row an admin reads in plain
 * text, and into any log or export that row reaches.
 *
 * Two independent defences, because either alone would be one edit away from
 * failing:
 *
 *   1. The query string is NEVER stored. Only the five named UTM parameters
 *      are read out of it; everything else — including `?token=` — is dropped.
 *   2. Capture is SKIPPED ENTIRELY on token-bearing and authenticated path
 *      prefixes (`SENSITIVE_PATH_PREFIXES`), so a secret sitting in the path
 *      segment cannot become the landing page either.
 *
 * A visitor who arrives on one of those routes simply has no attribution.
 * That is the correct trade: attribution is reporting data, and a reset token
 * in the leads table is an incident.
 */

/** Session key. Namespaced so it cannot collide with product state. */
const STORAGE_KEY = "tracetxn.attribution.v1";

/** Hard cap per field. Long enough for real campaign names, short enough that
 *  a crafted payload cannot bloat a document. Mirrored server-side. */
export const ATTRIBUTION_FIELD_MAX = 300;

export interface LeadAttribution {
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  /** Where the visitor came from. Null for a direct visit or same-origin. */
  referrer: string | null;
  /** The FIRST page of this session — the actual landing page, not the form. */
  landingPage: string | null;
}

export const EMPTY_ATTRIBUTION: LeadAttribution = {
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmTerm: null,
  utmContent: null,
  referrer: null,
  landingPage: null,
};

/** Trim, cap, and collapse empty strings to null. */
function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, ATTRIBUTION_FIELD_MAX);
}

/**
 * Path prefixes where attribution is never captured.
 *
 * Two reasons, both disqualifying on their own: the URL may BE a secret
 * (reset/invite/activation tokens, payment and consent ids), and a visitor
 * already inside the product is not an inbound lead to attribute.
 *
 * Matched as a prefix on the pathname, so `/reset-password/<token>` and every
 * segment under it are covered. Kept in sync with the private-route reasoning
 * in `@/lib/analytics/clarity`.
 */
const SENSITIVE_PATH_PREFIXES = [
  "/reset-password",
  "/forgot-password",
  "/join",
  "/activate",
  "/pay",
  "/consent",
  "/app",
  "/admin",
  "/api",
] as const;

/** True when attribution may be captured for this pathname. */
export function isAttributionSafePath(pathname: string): boolean {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return false;
  const path = pathname.toLowerCase().replace(/\/+$/, "") || "/";
  return !SENSITIVE_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/**
 * Read attribution out of a URL and referrer. Pure, so it is testable without
 * a DOM.
 *
 * Returns null for a sensitive path — see the token hazard in the header.
 *
 * `referrer` is dropped when it is same-origin: an internal hop is not a
 * traffic source, and recording it would bury the real one.
 */
export function parseAttribution(
  href: string,
  referrer: string | null | undefined,
): LeadAttribution | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!isAttributionSafePath(url.pathname)) return null;

  const q = url.searchParams;

  let ref: string | null = null;
  const rawRef = clean(referrer);
  if (rawRef) {
    try {
      const parsed = new URL(rawRef);
      // Same-origin is an internal hop, not a source. Anything that is not
      // http(s) is not a referrer we understand and is dropped rather than
      // stored verbatim.
      ref =
        parsed.origin === url.origin || !/^https?:$/.test(parsed.protocol)
          ? null
          : rawRef;
    } catch {
      ref = null;
    }
  }

  return {
    utmSource: clean(q.get("utm_source")),
    utmMedium: clean(q.get("utm_medium")),
    utmCampaign: clean(q.get("utm_campaign")),
    utmTerm: clean(q.get("utm_term")),
    utmContent: clean(q.get("utm_content")),
    referrer: ref,
    // PATHNAME ONLY. The query string is never stored — only the five named
    // UTM parameters above are read out of it. See the header.
    landingPage: clean(url.pathname) ?? "/",
  };
}

/** True when nothing useful was captured. */
export function isEmptyAttribution(a: LeadAttribution): boolean {
  return Object.values(a).every((v) => v === null);
}

/**
 * Capture on first landing, then leave it alone for the rest of the session.
 *
 * Safe to call on every page. No-ops outside the browser, on a sensitive
 * route, and on any storage error — a private window or a blocked-storage
 * setting must never break a page, and losing attribution is not worth an
 * exception.
 */
export function captureAttribution(): void {
  if (typeof window === "undefined") return;
  try {
    if (window.sessionStorage.getItem(STORAGE_KEY)) return; // first touch wins
    const captured = parseAttribution(
      window.location.href,
      document.referrer || null,
    );
    // Null means a sensitive route: record NOTHING, and leave the slot empty
    // so a later marketing page in the same session can still be the first
    // touch. Writing a placeholder here would burn the first-touch slot.
    if (!captured) return;
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(captured));
  } catch {
    /* storage unavailable — attribution is best-effort, never load-bearing */
  }
}

/** Read what was captured, for submission alongside a lead. */
export function readAttribution(): LeadAttribution {
  if (typeof window === "undefined") return { ...EMPTY_ATTRIBUTION };
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_ATTRIBUTION };
    const parsed = JSON.parse(raw) as Partial<LeadAttribution>;
    // Re-clean on read: what went into storage is as untrusted as anything
    // else a page can write, and this value is about to cross to the server.
    return {
      utmSource: clean(parsed.utmSource),
      utmMedium: clean(parsed.utmMedium),
      utmCampaign: clean(parsed.utmCampaign),
      utmTerm: clean(parsed.utmTerm),
      utmContent: clean(parsed.utmContent),
      referrer: clean(parsed.referrer),
      landingPage: clean(parsed.landingPage),
    };
  } catch {
    return { ...EMPTY_ATTRIBUTION };
  }
}

/**
 * The attribution to send with a form POST, or `undefined` when there is
 * nothing worth sending.
 *
 * `undefined` rather than an all-null object so the field is omitted from the
 * JSON body entirely and the server stores null instead of a row of nulls.
 */
export function attributionForSubmit(): LeadAttribution | undefined {
  const a = readAttribution();
  return isEmptyAttribution(a) ? undefined : a;
}
