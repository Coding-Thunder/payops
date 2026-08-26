import { describe, expect, it } from "vitest";

/**
 * Guards the /opengraph-image production outage.
 *
 * The route declared `export const runtime = "edge"`. This app is self-hosted
 * behind `next start` on DigitalOcean App Platform, which has no edge runtime,
 * so the route answered a hard 504 — verified live, 3/3 attempts, while
 * /icon.svg, /apple-icon and /manifest.webmanifest all returned 200 on the
 * same deployment.
 *
 * The failure was silent from inside the product: nothing in the app renders
 * its own OG card, so the only symptom was that LinkedIn, X and Slack showed a
 * stale cached image — which read as a branding problem rather than a broken
 * route.
 *
 * apple-icon.tsx builds the same kind of `ImageResponse` from `next/og`
 * WITHOUT that declaration and works, so parity between the two is the
 * invariant worth pinning.
 */

const IMAGE_ROUTES = [
  "@/app/opengraph-image",
  "@/app/apple-icon",
] as const;

describe("generated image routes", () => {
  it("declare no runtime override, so they run where the app actually runs", async () => {
    for (const path of IMAGE_ROUTES) {
      const mod = (await import(path)) as Record<string, unknown>;
      // `undefined` means "inherit the default Node runtime". Anything else —
      // "edge" in particular — is the regression.
      expect(mod.runtime, `${path} must not pin a runtime`).toBeUndefined();
    }
  });

  it("declares the metadata Next needs to serve the card", async () => {
    // The render itself is exercised against a running server, not here:
    // next/og instantiates WASM over fetch, which the unit project forbids.
    const mod = await import("@/app/opengraph-image");
    expect(mod.contentType).toBe("image/png");
    expect(mod.size).toEqual({ width: 1200, height: 630 });
    expect(typeof mod.default).toBe("function");
  });

  it("carries alt text that describes the card, not a slogan", async () => {
    const { alt } = await import("@/app/opengraph-image");
    expect(alt).toContain("TraceTxn");
    // The card was repositioned away from dispute framing; the alt must track
    // what is actually drawn on it.
    expect(alt.toLowerCase()).not.toContain("chargeback");
  });
});
