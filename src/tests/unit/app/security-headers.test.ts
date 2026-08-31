// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLARITY_TRACKED_PATHS } from "@/lib/analytics/clarity";

/**
 * Content-Security-Policy scoping.
 *
 * Adding Microsoft Clarity meant putting a third-party origin into
 * `script-src`. Anything running from there is same-origin code on
 * tracetxn.com with full DOM, cookie and localStorage access, so WHERE that
 * origin is permitted is the whole security question.
 *
 * The policy is built by an opt-IN helper rather than by subtracting hosts
 * from a permissive base, because the previous subtractive derivation of the
 * console policy meant every future addition silently widened `/admin/**`
 * unless someone remembered a matching `.replace()`. These tests pin the
 * resulting shape:
 *
 *   - the catch-all policy and the console policy carry NO Clarity hosts, so
 *     a direct load of /login, /pay/**, /app/** or /admin/** cannot execute
 *     the tag even if the runtime gate in ClarityAnalytics regressed;
 *   - the marketing paths carry exactly the two script hosts and the one
 *     connect wildcard Clarity actually needs, and nothing more;
 *   - the CSP paths and the runtime allow-list are the same list.
 *
 * Runs in the node environment: next.config.ts shells out to git at import
 * time to stamp the build SHA.
 */

type HeaderEntry = { key: string; value: string };
type HeaderRule = { source: string; headers: HeaderEntry[] };

/**
 * `@types/node` types NODE_ENV as read-only, so the repo's usual
 * stash/mutate/restore idiom (see `server/jwt.test.ts`) needs a cast to
 * reach it. Everything else about the pattern is unchanged.
 */
const mutableEnv = process.env as Record<string, string | undefined>;

async function loadHeaders(nodeEnv: string): Promise<HeaderRule[]> {
  const stash = process.env.NODE_ENV;
  try {
    // next.config.ts reads NODE_ENV at call time to decide 'unsafe-eval';
    // reset the module registry so nothing cached from a prior test leaks.
    mutableEnv.NODE_ENV = nodeEnv;
    vi.resetModules();
    const mod = await import("../../../../next.config");
    const config = mod.default as {
      headers: () => Promise<HeaderRule[]>;
    };
    return await config.headers();
  } finally {
    mutableEnv.NODE_ENV = stash;
  }
}

function cspFor(rules: HeaderRule[], source: string): string {
  // Duplicate header keys are last-wins in Next, so the effective policy for
  // a path is the LAST matching rule that sets one.
  const matches = rules
    .filter((r) => r.source === source)
    .flatMap((r) => r.headers)
    .filter((h) => h.key === "Content-Security-Policy");
  expect(matches.length, `no CSP rule for source ${source}`).toBeGreaterThan(0);
  return matches[matches.length - 1].value;
}

function directive(csp: string, name: string): string {
  const found = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
  expect(found, `${name} missing from policy`).toBeTruthy();
  return found as string;
}

describe("Content-Security-Policy", () => {
  let rules: HeaderRule[];

  beforeEach(async () => {
    rules = await loadHeaders("production");
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe("Clarity is scoped to the public marketing pages", () => {
    it("keeps Clarity out of the catch-all policy", () => {
      expect(cspFor(rules, "/(.*)")).not.toContain("clarity.ms");
    });

    it("keeps Clarity out of the platform console policy", () => {
      // The console has its own session and shows cross-tenant customer
      // data; it was carved out when it was a standalone app and must not
      // regain reach by inheritance.
      for (const source of ["/admin", "/admin/:path*"]) {
        expect(cspFor(rules, source), source).not.toContain("clarity.ms");
      }
    });

    it("allows Clarity on every tracked marketing path and only there", () => {
      const clarityPaths = rules
        .filter((r) =>
          r.headers.some(
            (h) =>
              h.key === "Content-Security-Policy" &&
              h.value.includes("clarity.ms"),
          ),
        )
        .map((r) => r.source);

      expect(clarityPaths.sort()).toEqual([...CLARITY_TRACKED_PATHS].sort());
    });

    it("grants Clarity the minimum it needs and nothing more", () => {
      const csp = cspFor(rules, "/");

      // Two script hosts: the tag loader, and the library the tag injects.
      // scripts.clarity.ms is absent from Microsoft's own CSP page and is
      // the usual cause of a silent "installed but no sessions".
      const scriptSrc = directive(csp, "script-src");
      expect(scriptSrc).toContain("https://www.clarity.ms");
      expect(scriptSrc).toContain("https://scripts.clarity.ms");
      // NOT a wildcard: only two hosts ever serve executable code.
      expect(scriptSrc).not.toContain("https://*.clarity.ms");

      // The /collect upload host is a random letter shard per tag fetch and
      // diagnostics go to report.clarity.ms, so the wildcard is required.
      expect(directive(csp, "connect-src")).toContain("https://*.clarity.ms");

      // Everything else is untouched: the shipped bundle contains no eval,
      // creates no workers or blob URLs, and frames nothing.
      expect(directive(csp, "img-src")).toBe("img-src 'self' data: https:");
      expect(directive(csp, "frame-src")).not.toContain("clarity");
      expect(csp).not.toContain("worker-src");
      expect(csp).not.toContain("blob:");
    });

    it("adds Clarity without disturbing the rest of the marketing policy", () => {
      const base = cspFor(rules, "/(.*)");
      const marketing = cspFor(rules, "/");
      const stripped = marketing
        .replace(" https://www.clarity.ms", "")
        .replace(" https://scripts.clarity.ms", "")
        .replace(" https://*.clarity.ms", "");
      expect(stripped).toBe(base);
    });
  });

  describe("existing guarantees still hold", () => {
    it("never allows 'unsafe-eval' in production", () => {
      // Clarity does not need it — the bundle has no eval / new Function /
      // document.write — so adding it would be a pure regression.
      for (const rule of rules) {
        for (const header of rule.headers) {
          if (header.key !== "Content-Security-Policy") continue;
          expect(header.value, rule.source).not.toContain("'unsafe-eval'");
        }
      }
    });

    it("still allows 'unsafe-eval' in development for React's debug helpers", async () => {
      const devRules = await loadHeaders("development");
      expect(cspFor(devRules, "/(.*)")).toContain("'unsafe-eval'");
    });

    it("keeps Stripe and Turnstile out of the console policy", () => {
      const consoleCsp = cspFor(rules, "/admin");
      expect(consoleCsp).not.toContain("stripe.com");
      expect(consoleCsp).not.toContain("challenges.cloudflare.com");
      // …while the app keeps them.
      expect(cspFor(rules, "/(.*)")).toContain("https://api.stripe.com");
    });

    it("keeps the marketing pages under the catch-all's other headers", () => {
      // The marketing rules override ONLY the CSP. Everything else —
      // nosniff, frame-ancestors, COOP/CORP — still comes from /(.*)
      const marketingRules = rules.filter((r) =>
        (CLARITY_TRACKED_PATHS as readonly string[]).includes(r.source),
      );
      expect(marketingRules.length).toBe(CLARITY_TRACKED_PATHS.length);
      for (const rule of marketingRules) {
        expect(rule.headers.map((h) => h.key)).toEqual([
          "Content-Security-Policy",
        ]);
      }
    });
  });
});
