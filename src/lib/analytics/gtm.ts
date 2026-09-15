/**
 * Google Tag Manager — container snippet builders.
 *
 * Deliberately dependency-free and free of any `process.env` read, matching
 * `./clarity`: the container id is threaded in from the server so every env
 * read stays inside `@/lib/env`.
 *
 * SCOPE. GTM is installed from the root layout and therefore RENDERS on every
 * route — but it is only permitted to LOAD on public pages. The boundary is
 * enforced by Content-Security-Policy in `next.config.ts`, not by a runtime
 * check, for the reason set out in `GTM_BLOCKED_PATTERNS` below.
 *
 * ⚠️  GTM IS A TAG INJECTOR, NOT A TAG.
 *
 * Today this container is EMPTY — its published payload declares
 * `"tags":[], "predicates":[], "rules":[]`, so it fetches one script and
 * collects nothing. Everything it will ever do is decided later, in the Tag
 * Manager UI, by whoever has container access — with no code review and no
 * deploy. Container access is production JavaScript-execution access. Treat
 * it like a deploy credential.
 *
 * That is what makes the route boundary matter. A page-view tag added in the
 * UI tomorrow reports the FULL URL of every page it runs on, and this app has
 * routes whose URL is itself a live credential.
 *
 * ── Where GTM may NOT load, and why ──────────────────────────────────────
 *
 *   /reset-password/<token>, /join/<token>, /consent/<token>, /activate,
 *   /pay/**            the URL IS the credential; a page-view tag would send
 *                      it to Google and to any configured destination.
 *   /app/**            customer names, emails, payment links, order data.
 *   /admin/**          cross-tenant customer data.
 *   /login             a credential-entry page with no conversion to measure.
 *
 * ── Where it MAY, and why that is not a contradiction ────────────────────
 *
 * The public marketing pages, plus `/signup` and `/waitlist`. Those two are
 * where a Google Ads conversion actually happens, so excluding them would
 * remove the reason the container exists. `/signup` does carry a password
 * field, which is a real residual risk if the container is ever compromised —
 * it is accepted knowingly, and the mitigation is container hygiene plus the
 * dataLayer discipline in `@/lib/analytics/data-layer` (events are pushed
 * only after a successful server action, and never carry a token or PII).
 *
 * ── Why CSP rather than a runtime check ──────────────────────────────────
 *
 * A client-side gate would have to win a race against the loader on every
 * soft navigation, which is the failure mode `./clarity` documents at length.
 * A CSP has no race: on a blocked route the browser simply refuses to fetch
 * `gtm.js`, so no container code runs at all. The inline bootstrap still
 * executes and creates an empty `window.dataLayer`; nothing reads it and
 * nothing is transmitted.
 *
 * It also holds against a bug in this repository, which a runtime check
 * cannot: even if the component were changed to render unconditionally, the
 * browser would still block the load.
 */

/** The one host the container loader needs. Also in `script-src`. */
const GTM_HOST = "https://www.googletagmanager.com";

/**
 * Route patterns where the browser must refuse to load the container.
 *
 * Consumed by `next.config.ts` to emit a GTM-free CSP for these paths, and by
 * `gtm-route-safety.test.ts` to prove the emitted policies match. Written in
 * Next's `headers()` source syntax because that is the only consumer that
 * needs them; `GTM_BLOCKED_PREFIXES` below is the plain-path form for tests
 * and for anything that needs to reason about a pathname.
 *
 * `/admin` and `/admin/:path*` are both listed: the bare `/admin` login page
 * is not matched by `/admin/:path*`, and it is the one route in the console an
 * unauthenticated person can reach.
 */
export const GTM_BLOCKED_PATTERNS = [
  "/login",
  "/reset-password/:path*",
  "/join/:path*",
  "/activate",
  "/pay/:path*",
  "/consent/:path*",
  "/app/:path*",
  "/admin",
  "/admin/:path*",
] as const;

/** The same boundary as plain path prefixes. */
export const GTM_BLOCKED_PREFIXES = [
  "/login",
  "/reset-password",
  "/join",
  "/activate",
  "/pay",
  "/consent",
  "/app",
  "/admin",
] as const;

/** True when GTM is permitted to load on this pathname. */
export function isGtmAllowedPath(pathname: string): boolean {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return false;
  const path = pathname.toLowerCase().replace(/\/+$/, "") || "/";
  return !GTM_BLOCKED_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/**
 * A real GTM container id: `GTM-` followed by uppercase alphanumerics.
 *
 * Validated rather than trusted because the id is interpolated into an inline
 * `<script>`. `JSON.stringify` escapes it there too; this is the second,
 * independent guard so a malformed environment variable can never become
 * script content.
 *
 * The pattern also rejects `G-XXXXXXX`, a GA4 *measurement* id — the single
 * most common thing pasted into a container-id field by mistake. It would
 * silently 400 at Google and look like "GTM just doesn't work".
 */
export function isValidGtmContainerId(
  containerId: string | null | undefined,
): containerId is string {
  return typeof containerId === "string" && /^GTM-[A-Z0-9]{4,}$/.test(containerId);
}

/**
 * Google's official container snippet, verbatim apart from the id.
 *
 * Kept byte-identical to what Tag Manager hands you so it is diffable against
 * the console. It does three things: seeds `window.dataLayer`, pushes the
 * `gtm.start` timing event, and injects the async container script.
 *
 * The data-layer variable name stays `dataLayer`. The published container
 * declares `"19":"dataLayer"`; renaming it makes the container receive
 * nothing, silently.
 */
export function gtmBootstrapScript(containerId: string): string {
  if (!isValidGtmContainerId(containerId)) {
    throw new Error("Refusing to build a GTM snippet for a malformed container id");
  }
  return `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='${GTM_HOST}/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer',${JSON.stringify(containerId)});`;
}

/**
 * The `<noscript>` fallback iframe source.
 *
 * Only ever loaded by a visitor with JavaScript disabled. It is why
 * `frame-src` carries the GTM host: with JS enabled the iframe is never
 * instantiated and `frame-src` is irrelevant, but without the grant a no-JS
 * visitor gets a console CSP violation and a dead frame.
 */
export function gtmNoscriptSrc(containerId: string): string {
  if (!isValidGtmContainerId(containerId)) {
    throw new Error("Refusing to build a GTM iframe URL for a malformed container id");
  }
  return `${GTM_HOST}/ns.html?id=${encodeURIComponent(containerId)}`;
}
