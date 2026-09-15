// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  DATA_LAYER_EVENTS,
  isAllowedDataLayerKey,
  pushDataLayerEvent,
} from "@/lib/analytics/data-layer";
import {
  GTM_BLOCKED_PATTERNS,
  GTM_BLOCKED_PREFIXES,
  isGtmAllowedPath,
} from "@/lib/analytics/gtm";

/**
 * The dataLayer contract, and the GTM route boundary.
 *
 * Both are agreements with something outside this repository — a Tag Manager
 * container whose contents change without a deploy or a code review. That is
 * what makes them worth pinning:
 *
 *   - Anything pushed to the dataLayer is readable by EVERY tag in the
 *     container and is sent wherever those tags point. A name or an email
 *     reaching it is a disclosure this repository cannot then take back.
 *   - Anywhere GTM can execute, a future tag can execute. On a route whose
 *     URL is a live credential, a page-view tag would transmit that
 *     credential.
 */

interface DataLayerWindow extends Window {
  dataLayer?: Record<string, unknown>[];
}

function layer(): Record<string, unknown>[] {
  return (window as DataLayerWindow).dataLayer ?? [];
}

beforeEach(() => {
  (window as DataLayerWindow).dataLayer = [];
});

describe("pushDataLayerEvent", () => {
  it("pushes the event name and its parameters", () => {
    pushDataLayerEvent(DATA_LAYER_EVENTS.BETA_APPLICATION_SUBMITTED, {
      user_type: "AGENCY_OWNER",
    });
    expect(layer()).toEqual([
      {
        event: "beta_application_submitted",
        user_type: "AGENCY_OWNER",
      },
    ]);
  });

  it("creates the array when GTM has not loaded", () => {
    delete (window as DataLayerWindow).dataLayer;
    pushDataLayerEvent(DATA_LAYER_EVENTS.CONTACT_SUBMITTED);
    // The array IS the interface: the container replays whatever is already
    // in it when it loads, so an early push is not a lost push.
    expect(layer()).toHaveLength(1);
  });

  it("never throws, whatever the environment does", () => {
    Object.defineProperty(window, "dataLayer", {
      configurable: true,
      get() {
        throw new Error("blocked by extension");
      },
    });
    expect(() =>
      pushDataLayerEvent(DATA_LAYER_EVENTS.REVIEW_SUBMITTED, { rating: 5 }),
    ).not.toThrow();
    // Restore for the remaining tests.
    Object.defineProperty(window, "dataLayer", {
      configurable: true,
      writable: true,
      value: [],
    });
  });
});

describe("no personal data can reach the container", () => {
  it.each([
    "email",
    "Email",
    "authorEmail",
    "name",
    "fullName",
    "firstName",
    "phone",
    "company",
    "business",
    "token",
    "cfToken",
    "password",
    "user_id",
    "userId",
    "sessionId",
    "id",
    "url",
    "href",
    "path",
    "referrer",
    "ip",
  ])("drops the parameter %s", (key) => {
    pushDataLayerEvent(DATA_LAYER_EVENTS.BETA_APPLICATION_SUBMITTED, {
      [key]: "ada@example.com",
    });
    expect(JSON.stringify(layer())).not.toContain("ada@example.com");
    expect(Object.keys(layer()[0])).toEqual(["event"]);
  });

  it("drops a whole form payload spread into the call", () => {
    // The realistic accident: `pushDataLayerEvent(EVENT, { ...formState })`.
    pushDataLayerEvent(DATA_LAYER_EVENTS.BETA_APPLICATION_SUBMITTED, {
      fullName: "Ada Lovelace",
      email: "ada@example.com",
      businessName: "Ada Studio",
      user_type: "FREELANCER",
    } as never);
    const pushed = layer()[0];
    expect(pushed).toEqual({
      event: "beta_application_submitted",
      user_type: "FREELANCER",
    });
  });

  it("drops a nested object, which is where a payload would hide", () => {
    pushDataLayerEvent(DATA_LAYER_EVENTS.CONTACT_SUBMITTED, {
      applicant: { email: "ada@example.com" },
      list: ["ada@example.com"],
    } as never);
    expect(JSON.stringify(layer())).not.toContain("ada@example.com");
  });

  it("caps a string parameter so free text cannot ride along", () => {
    pushDataLayerEvent(DATA_LAYER_EVENTS.CONTACT_SUBMITTED, {
      plan: "x".repeat(500),
    });
    expect((layer()[0].plan as string).length).toBe(64);
  });

  it("keeps the safe primitives it is meant to carry", () => {
    pushDataLayerEvent(DATA_LAYER_EVENTS.REVIEW_SUBMITTED, {
      rating: 5,
      first_time: true,
      plan: null,
    });
    expect(layer()[0]).toEqual({
      event: "review_submitted",
      rating: 5,
      first_time: true,
      plan: null,
    });
  });

  it("isAllowedDataLayerKey is not fooled by punctuation or case", () => {
    for (const key of ["e-mail", "E_MAIL", "user-id", "USER_ID", "Token"]) {
      expect(isAllowedDataLayerKey(key), key).toBe(false);
    }
    for (const key of ["rating", "user_type", "plan", "step"]) {
      expect(isAllowedDataLayerKey(key), key).toBe(true);
    }
  });
});

describe("events fire only after a successful server response", () => {
  /**
   * A source-level assertion, because the property is about ORDER and no
   * unit test of the module can see it: the push must sit after the `await`
   * that stores the record, inside the try, and never in a click handler or
   * a catch. A push moved above the await would still pass every behavioural
   * test in this file while training Google Ads on attempts instead of
   * conversions.
   */
  const SRC = path.resolve(process.cwd(), "src");
  const CALLERS = [
    "components/marketing/waitlist-form.tsx",
    "components/marketing/reviews/review-form.tsx",
    "components/marketing/quotation-form-body.tsx",
    "components/auth/firebase-auth-form.tsx",
  ];

  it.each(CALLERS)("%s pushes only after an await", (file) => {
    const raw = fs.readFileSync(path.join(SRC, file), "utf8");
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const lines = code.split("\n");
    const pushLine = lines.findIndex((l) => l.includes("pushDataLayerEvent("));
    expect(pushLine, `${file} pushes no event`).toBeGreaterThan(-1);

    // Some `await api.` (or `await ` on the auth exchange) precedes it.
    const before = lines.slice(0, pushLine).join("\n");
    expect(before, `${file}: no await precedes the push`).toMatch(/await\s+/);
  });

  it.each(CALLERS)("%s pushes no event from a catch block", (file) => {
    const raw = fs.readFileSync(path.join(SRC, file), "utf8");
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // Everything from the first `catch (` onwards must contain no push. The
    // failure this catches is "fire the conversion anyway so the number looks
    // right", which is the exact thing that poisons Ads optimisation.
    const firstCatch = code.indexOf("catch (");
    if (firstCatch === -1) return;
    expect(code.slice(firstCatch)).not.toContain("pushDataLayerEvent(");
  });

  it("no caller sends an identifier, however tempting", () => {
    for (const file of CALLERS) {
      const code = fs.readFileSync(path.join(SRC, file), "utf8");
      const calls = [...code.matchAll(/pushDataLayerEvent\(([\s\S]*?)\);/g)];
      for (const [, args] of calls) {
        for (const bad of ["email", "fullName", "authorName", "cfToken", "idToken"]) {
          expect(args, `${file} passes ${bad}`).not.toContain(bad);
        }
      }
    }
  });
});

describe("the GTM route boundary", () => {
  it.each([
    "/",
    "/pricing",
    "/features",
    "/client-management",
    "/blog",
    "/blog/a-post",
    "/reviews",
    "/waitlist",
    "/signup",
    "/contact",
  ])("allows GTM on %s", (p) => {
    expect(isGtmAllowedPath(p)).toBe(true);
  });

  it.each([
    "/login",
    "/reset-password/SECRET",
    "/join/SECRET",
    "/activate",
    "/pay/success",
    "/consent/abc",
    "/app",
    "/app/customers/1",
    "/admin",
    "/admin/blog",
  ])("blocks GTM on %s", (p) => {
    expect(isGtmAllowedPath(p)).toBe(false);
  });

  it("is not fooled by casing or a trailing slash", () => {
    expect(isGtmAllowedPath("/APP/")).toBe(false);
    expect(isGtmAllowedPath("/Reset-Password/x")).toBe(false);
    expect(isGtmAllowedPath("/admin/")).toBe(false);
  });

  it("does not block a public route that merely shares a prefix", () => {
    // `/pay` is blocked; `/payments-guide` would be a legitimate public page,
    // and a prefix test without the boundary would silently kill GTM on it.
    for (const p of ["/payments-guide", "/joining-tips", "/application"]) {
      expect(isGtmAllowedPath(p), p).toBe(true);
    }
  });

  it("keeps the two boundary definitions in step", () => {
    // `GTM_BLOCKED_PATTERNS` (Next `headers()` syntax) drives the CSP;
    // `GTM_BLOCKED_PREFIXES` drives `isGtmAllowedPath`. They describe the
    // same boundary and drifting apart would mean the enforced policy and
    // the documented policy disagree.
    const fromPatterns = new Set(
      GTM_BLOCKED_PATTERNS.map((p) => p.replace(/\/:path\*$/, "")),
    );
    expect([...fromPatterns].sort()).toEqual([...GTM_BLOCKED_PREFIXES].sort());
  });
});

describe("the emitted CSP actually enforces the boundary", () => {
  /**
   * The assertions above test a predicate. This one tests the thing that is
   * actually deployed: the headers Next will send. A predicate that is right
   * while the config is wrong protects nothing.
   */
  it("withholds GTM from every blocked pattern and allows it elsewhere", async () => {
    const mod = await import("../../../../next.config");
    const config = mod.default as {
      headers: () => Promise<
        { source: string; headers: { key: string; value: string }[] }[]
      >;
    };
    const entries = await config.headers();

    const cspFor = (source: string) =>
      entries
        .filter((e) => e.source === source)
        .flatMap((e) => e.headers)
        .filter((h) => h.key === "Content-Security-Policy")
        // Duplicate header keys are last-wins in Next, so the LAST matching
        // entry is the policy actually applied.
        .at(-1)?.value;

    // The catch-all still carries GTM: the public site is where it belongs.
    expect(cspFor("/(.*)")).toContain("googletagmanager.com");

    for (const pattern of GTM_BLOCKED_PATTERNS) {
      const policy = cspFor(pattern);
      expect(policy, `no CSP entry for ${pattern}`).toBeTruthy();
      expect(policy, `${pattern} still allows GTM`).not.toContain(
        "googletagmanager.com",
      );
      // And these routes were never allowed to reach Clarity either.
      expect(policy, `${pattern} allows Clarity`).not.toContain("clarity.ms");
    }
  });
});
