import { describe, expect, it } from "vitest";

import {
  CLARITY_TRACKED_PATHS,
  clarityBootstrapScript,
  clarityTagUrl,
  isClarityTrackedPath,
  isValidClarityProjectId,
} from "@/lib/analytics/clarity";

/**
 * Where Microsoft Clarity is allowed to record.
 *
 * This is a privacy boundary, not a config list. Clarity uploads the DOM,
 * the click stream and the full page URL, and its URL masking covers query
 * parameters only — never path segments — so a recording of
 * `/reset-password/<token>` would ship a live credential to a third party.
 *
 * These tests pin the boundary in both directions: the marketing pages that
 * SHOULD be tracked, and the credential / payment / customer-data surfaces
 * that must never be. Adding a route to `CLARITY_TRACKED_PATHS` should mean
 * deleting an assertion here on purpose, never watching one go green by
 * accident.
 */

/**
 * Every route class that must stay untracked, with the reason. Sampled from
 * the real route tree (`src/app/**`), including the token-bearing URLs that
 * no masking feature can protect.
 */
const MUST_NOT_TRACK: ReadonlyArray<readonly [string, string]> = [
  // Authentication — passwords, and credentials carried in the URL itself.
  ["/login", "password entry"],
  ["/signup", "password entry + invite code in the query"],
  ["/forgot-password", "account enumeration surface"],
  ["/reset-password/abc123-token", "live reset token in the path"],
  ["/join/abc123-token", "single-use team-invite token in the path"],
  ["/activate", "beta activation token in the query"],
  // Payment + consent — customer-facing, gateway- and HMAC-token-bound.
  ["/pay/success", "Stripe checkout session id in the query"],
  ["/pay/cancelled", "payment surface"],
  ["/consent/abc123-token", "consent token in the path + e-signature field"],
  // The authenticated product — tenant and customer data.
  ["/app/dashboard", "tenant data"],
  ["/app/orders", "customer PII + payment links"],
  ["/app/orders/65f/evidence", "evidence chain: emails, IPs, user agents"],
  ["/app/customers", "customer PII"],
  ["/app/customers/by-email/ada%40example.com", "customer email in the path"],
  ["/app/account", "account settings"],
  ["/app/onboarding", "business setup"],
  // Tenant admin — gateway credentials.
  ["/app/admin", "tenant admin"],
  ["/app/admin/gateways", "Stripe SECRET key entry"],
  ["/app/admin/settings", "tenant configuration"],
  ["/app/admin/audit", "raw audit metadata JSON"],
  // Platform super-admin console — cross-tenant, separate session.
  ["/admin", "console login: admin email + OTP"],
  ["/admin/dashboard", "cross-tenant platform data"],
  ["/admin/customers/65f", "cross-tenant customer PII"],
  ["/admin/audit/65f", "raw audit metadata JSON"],
];

describe("Clarity route allow-list", () => {
  it("tracks exactly the ten public marketing pages", () => {
    expect([...CLARITY_TRACKED_PATHS]).toEqual([
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
    ]);
  });

  it("admits every path it declares", () => {
    for (const path of CLARITY_TRACKED_PATHS) {
      expect(isClarityTrackedPath(path), `${path} should be tracked`).toBe(
        true,
      );
    }
  });

  it.each(MUST_NOT_TRACK)(
    "never tracks %s (%s)",
    (path: string, reason: string) => {
      expect(
        isClarityTrackedPath(path),
        `${path} must stay untracked: ${reason}`,
      ).toBe(false);
    },
  );

  it("denies by default, so a new route is untracked until opted in", () => {
    for (const path of [
      "/some-route-that-does-not-exist-yet",
      "/app",
      "/api/health",
      "/api/webhooks/stripe",
    ]) {
      expect(isClarityTrackedPath(path)).toBe(false);
    }
  });

  it("denies rather than throws when the pathname is absent", () => {
    // `usePathname()` can return null before the router initialises. The
    // safe direction is "not tracked".
    expect(isClarityTrackedPath(null)).toBe(false);
    expect(isClarityTrackedPath(undefined)).toBe(false);
    expect(isClarityTrackedPath("")).toBe(false);
  });

  it("treats a trailing slash as the same route", () => {
    expect(isClarityTrackedPath("/pricing/")).toBe(true);
    expect(isClarityTrackedPath("/")).toBe(true);
    // …but does not let it smuggle in a prefix match.
    expect(isClarityTrackedPath("/pricing/enterprise")).toBe(false);
  });

  it("matches on the path only, ignoring query and hash", () => {
    expect(isClarityTrackedPath("/pricing?plan=beta")).toBe(true);
    expect(isClarityTrackedPath("/pricing#faq")).toBe(true);
    // A denied route cannot be admitted by decorating it.
    expect(isClarityTrackedPath("/login?next=/pricing")).toBe(false);
  });

  it("does not admit a casing variant", () => {
    // Fails closed: worst case a marketing page goes untracked, never the
    // reverse.
    expect(isClarityTrackedPath("/Pricing")).toBe(false);
  });

  it("does not admit a path that merely contains a tracked one", () => {
    for (const path of [
      "/app/pricing",
      "/admin/privacy",
      "/pricing-internal",
      "//evil.example.com/pricing",
    ]) {
      expect(isClarityTrackedPath(path), `${path} must be denied`).toBe(false);
    }
  });
});

describe("clarityTagUrl", () => {
  it("points at Microsoft's tag loader for the given project", () => {
    expect(clarityTagUrl("abcd1234")).toBe(
      "https://www.clarity.ms/tag/abcd1234",
    );
  });

  it("encodes the project id so it cannot alter the URL", () => {
    expect(clarityTagUrl("../../evil?x=1")).toBe(
      "https://www.clarity.ms/tag/..%2F..%2Fevil%3Fx%3D1",
    );
  });
});

describe("isValidClarityProjectId", () => {
  it("accepts a real Clarity project id", () => {
    // Ten lowercase alphanumerics is the shape Clarity issues.
    expect(isValidClarityProjectId("abcd1234ef")).toBe(true);
    expect(isValidClarityProjectId("ABC123")).toBe(true);
  });

  it("rejects anything that is not plain alphanumeric", () => {
    // The id is interpolated into an inline <script>, so this is a security
    // boundary and not merely a typo check.
    for (const bad of [
      "",
      "   ",
      "abc-123",
      "abc 123",
      "../../etc",
      '"); alert(1);//',
      "</script><script>alert(1)</script>",
      "a".repeat(33),
      null,
      undefined,
    ]) {
      expect(isValidClarityProjectId(bad), `${String(bad)} must be rejected`).toBe(
        false,
      );
    }
  });
});

describe("clarityBootstrapScript", () => {
  /**
   * This is the half of the install snippet Microsoft does NOT serve at
   * /tag/<id>. Those bytes call `window.clarity("metadata", …)` and read
   * `window.clarity.q` as their first statements without ever defining either,
   * so a bare `<script src>` throws immediately, never fetches clarity.js, and
   * records nothing — while still firing Microsoft's advertising pixel. These
   * assertions exist so that failure mode cannot come back silently.
   */
  // A fixture, not the real project id — the repo commits no real
  // NEXT_PUBLIC_* value, not even one that authorises nothing.
  const snippet = clarityBootstrapScript("abcd1234ef");

  it("defines the command-queue stub the tag depends on", () => {
    expect(snippet).toContain("c[a]=c[a]||function()");
    expect(snippet).toContain("(c[a].q=c[a].q||[]).push(arguments)");
  });

  it("loads the tag for the given project", () => {
    expect(snippet).toContain('t.src="https://www.clarity.ms/tag/"+i');
    expect(snippet).toContain('"abcd1234ef"');
  });

  it("cannot inject a second tag into the same document", () => {
    expect(snippet).toContain('if(l.getElementById("clarity-script"))return');
    expect(snippet).toContain('t.id="clarity-script"');
  });

  it("calls no Clarity API beyond loading the tag", () => {
    // No identify / setTag / event / upgrade / consent — automatic analytics
    // only. Anything here would be sent to Microsoft verbatim.
    for (const api of ["identify", "setTag", '"set"', '"event"', "upgrade", "consent"]) {
      expect(snippet, `snippet must not call ${api}`).not.toContain(api);
    }
  });

  it("refuses to build a snippet for a malformed id", () => {
    // Defence in depth behind JSON.stringify: a malformed env var must fail
    // loudly rather than become script content.
    expect(() => clarityBootstrapScript('"); alert(1);//')).toThrow();
    expect(() => clarityBootstrapScript("")).toThrow();
  });

  it("escapes the id it embeds", () => {
    // Even for an id that passed validation, the value is JSON-encoded.
    expect(clarityBootstrapScript("abc123")).toContain('"abc123"');
  });
});
