/**
 * Microsoft Clarity — the route allow-list.
 *
 * Clarity is a session recorder: it captures the DOM, the click stream and
 * the full page URL. This application holds payment links, consent tokens,
 * password-reset tokens, customer PII and tenant credentials, so the tag is
 * allow-listed onto a small set of public marketing pages and nowhere else.
 *
 * Why an allow-list rather than a deny-list:
 *
 *   - DENY-BY-DEFAULT. A route added tomorrow is untracked until somebody
 *     deliberately adds it here. A deny-list would have the opposite failure
 *     mode: forget an entry and a new authenticated surface starts recording.
 *   - SECRETS IN URLS CANNOT BE MASKED. Clarity's URL masking is
 *     query-parameter-only, case-sensitive, project-wide, and has to be
 *     requested from Microsoft by email. It does not apply to path segments,
 *     referrer URLs or clicked URLs at all. `/reset-password/<token>`,
 *     `/join/<token>`, `/consent/<token>` and `/activate?token=` would
 *     therefore upload live credentials verbatim. No DOM attribute fixes
 *     that — the only remedy is to never load the tag on those routes.
 *   - MASKING IS NOT A SUBSTITUTE. Clarity's default "Balanced" mode leaves
 *     names, currency amounts and `<title>` unmasked, and the masking mode
 *     itself is a dashboard toggle no code review can see.
 *
 * Deliberately EXCLUDED, with the reason:
 *
 *   /login /signup /forgot-password
 *   /reset-password/[token] /join/[token] /activate ... credentials, tokens in URL
 *   /pay/** /consent/[token] .......................... payment + consent, tokens in URL
 *   /app/** ........................................... tenant customer data
 *   /app/admin/** ..................................... gateway secret keys, audit metadata
 *   /admin/** ......................................... platform console, cross-tenant data
 *
 * This module has NO imports on purpose: `next.config.ts` imports it to scope
 * the Content-Security-Policy to the same set of paths, so the allow-list and
 * the CSP can never drift apart.
 */

/**
 * Public marketing routes that may load the Clarity tag.
 *
 * Exact paths only — no prefixes and no patterns, so nothing can be admitted
 * by accident. `/waitlist` is the one entry that collects PII; its form is
 * masked at `src/components/marketing/waitlist-form.tsx`.
 */
export const CLARITY_TRACKED_PATHS = [
  "/",
  "/features",
  "/pricing",
  "/security",
  "/contact",
  "/terms",
  "/privacy",
  "/refunds",
  "/dpa",
  "/waitlist",
] as const;

export type ClarityTrackedPath = (typeof CLARITY_TRACKED_PATHS)[number];

const TRACKED = new Set<string>(CLARITY_TRACKED_PATHS);

/**
 * Normalise a pathname for comparison: drop the query/hash (defensive —
 * `usePathname()` never includes them) and the trailing slash, so `/pricing/`
 * and `/pricing` are the same route. The bare root stays `/`.
 */
function normalise(pathname: string): string {
  const path = pathname.split(/[?#]/, 1)[0];
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

/**
 * True when the Clarity tag is allowed on this pathname.
 *
 * Anything unrecognised — including `null`, which `usePathname()` can return
 * before the router initialises — is untracked. Matching is exact and
 * case-sensitive: a casing variant fails closed, which is the safe direction.
 */
export function isClarityTrackedPath(
  pathname: string | null | undefined,
): boolean {
  if (!pathname) return false;
  return TRACKED.has(normalise(pathname));
}

/**
 * The Clarity tag URL for a project.
 *
 * `https://www.clarity.ms/tag/<id>` is the loader Microsoft serves; it in turn
 * injects the real library from `scripts.clarity.ms`. Both hosts are in the
 * marketing CSP built in `next.config.ts`. An unknown project id answers 204
 * with an empty body, so a wrong value degrades to a no-op rather than an
 * error.
 */
export function clarityTagUrl(projectId: string): string {
  return `https://www.clarity.ms/tag/${encodeURIComponent(projectId)}`;
}

/**
 * Clarity project ids are short lowercase alphanumeric strings (ours is ten
 * characters). Anything else is a misconfiguration.
 *
 * This is validated rather than merely trusted because the id is interpolated
 * into an inline `<script>` — see `clarityBootstrapScript()`. `JSON.stringify`
 * already escapes the value there; this is the second, independent guard, so
 * a malformed environment variable can never become script content.
 */
export function isValidClarityProjectId(
  projectId: string | null | undefined,
): projectId is string {
  return typeof projectId === "string" && /^[a-z0-9]{1,32}$/i.test(projectId);
}

/**
 * The official Microsoft Clarity install snippet, with the project id baked in.
 *
 * WHY AN INLINE SNIPPET AND NOT A BARE `<script src>`: the bytes Microsoft
 * serves at `/tag/<id>` are only the SECOND HALF of the install snippet. The
 * very first thing that file does is call `window.clarity("metadata", …)` and
 * then read `window.clarity.q` — it never defines `window.clarity` itself.
 * Loaded on its own it throws `TypeError` on line one, never injects
 * `scripts.clarity.ms/…/clarity.js`, and records precisely nothing while still
 * firing Microsoft's `c.clarity.ms/c.gif` advertising pixel. The command-queue
 * stub below is therefore not optional boilerplate; it is the half that makes
 * the other half run.
 *
 * The `getElementById` guard is the same one Microsoft's own `@microsoft/clarity`
 * package uses, so a re-render, a React StrictMode double-effect, or a client
 * navigation between two tracked pages cannot inject a second tag.
 *
 * Kept as one script — not a stub script plus a `<Script src>` — because
 * ordering between two separate `afterInteractive` scripts is not guaranteed,
 * and the stub MUST exist before the tag executes.
 */
export function clarityBootstrapScript(projectId: string): string {
  if (!isValidClarityProjectId(projectId)) {
    throw new Error("Refusing to build a Clarity snippet for a malformed project id");
  }
  return `(function(c,l,a,r,i,t,y){if(l.getElementById("clarity-script"))return;c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.id="clarity-script";t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y)})(window,document,"clarity","script",${JSON.stringify(projectId)});`;
}
