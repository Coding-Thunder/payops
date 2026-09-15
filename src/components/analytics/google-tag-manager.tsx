import {
  gtmBootstrapScript,
  gtmNoscriptSrc,
  isValidGtmContainerId,
} from "@/lib/analytics/gtm";

/**
 * Google Tag Manager, installed site-wide.
 *
 * A SERVER component on purpose. It renders unconditionally on every route, so
 * none of the client-side route gating `ClarityAnalytics` needs applies here —
 * and rendering on the server means both halves appear in the HTML that a
 * crawler, a curl, or a JavaScript-disabled visitor actually receives.
 *
 * WHY A RAW <script> AND NOT next/script. `next/script` with inline content
 * emits ZERO bytes server-side: its `afterInteractive` path only preloads when
 * a `src` is present, and otherwise injects from a client effect. That would
 * put GTM behind hydration and make the snippet invisible to curl. A plain
 * inline `<script>` is server-rendered and executes during HTML parse, which
 * is both earlier and closer to what Google's instructions ask for. React
 * hoists `<script src>` to the head but leaves inline scripts in place, so
 * rendering this first inside <body> is the earliest position available
 * without hand-managing <head>, which the App Router owns via `metadata`.
 *
 * The `<noscript>` iframe sits immediately after it, which is exactly where
 * Google's instructions place it relative to the opening <body> tag.
 *
 * Renders nothing when the container id is absent or malformed, so an
 * unconfigured environment — local dev, `.env.test`, `.env.smoke`, CI — loads
 * no third-party script and behaves as it did before GTM existed.
 *
 * ⚠️  This loads on EVERY route, including authenticated and credential-bearing
 * ones. Read the warning at the top of `@/lib/analytics/gtm` before adding any
 * tag to the container.
 */

export interface GoogleTagManagerProps {
  /**
   * Public container id (`NEXT_PUBLIC_GTM_CONTAINER_ID`), e.g. `GTM-XXXXXXX`.
   * When empty, absent or malformed the component renders null.
   */
  containerId: string | null | undefined;
}

export function GoogleTagManager({ containerId }: GoogleTagManagerProps) {
  const id = containerId?.trim() || null;
  if (!isValidGtmContainerId(id)) return null;

  return (
    <>
      {/* Google Tag Manager */}
      <script
        id="gtm-bootstrap"
        // Server-rendered from a validated id (/^GTM-[A-Z0-9]{4,}$/) that is
        // additionally JSON-escaped by gtmBootstrapScript. No user input can
        // reach this string.
        dangerouslySetInnerHTML={{ __html: gtmBootstrapScript(id) }}
      />
      {/* Google Tag Manager (noscript) */}
      <noscript>
        <iframe
          src={gtmNoscriptSrc(id)}
          height="0"
          width="0"
          style={{ display: "none", visibility: "hidden" }}
          // A frame that exists only to fire a pixel: keep it out of the
          // accessibility tree and off the tab order.
          title="Google Tag Manager"
          aria-hidden
          tabIndex={-1}
        />
      </noscript>
    </>
  );
}
