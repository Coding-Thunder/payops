// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  ATTRIBUTION_FIELD_MAX,
  attributionForSubmit,
  captureAttribution,
  isAttributionSafePath,
  isEmptyAttribution,
  parseAttribution,
  readAttribution,
} from "@/lib/analytics/attribution";
import {
  attributionForStorage,
  attributionSchema,
} from "@/lib/validation/attribution";

/**
 * Lead attribution.
 *
 * The expensive failure here is not a missing UTM tag — it is a SECRET in the
 * leads table. This app has routes whose URL is itself a credential
 * (`/reset-password/<token>`, `/join/<token>`, `/activate?token=…`). A naive
 * "store location.pathname + location.search" would write those tokens into a
 * document an admin reads in plain text. Both defences against that — the
 * query string is never stored, and sensitive prefixes are skipped outright —
 * are pinned below, and a regression in either is a security bug, not a
 * reporting bug.
 *
 * The second thing worth protecting is FIRST-TOUCH semantics. A visitor who
 * arrives from an ad and converts three pages later must still be credited to
 * the ad; overwriting on each page view would credit the last internal hop.
 */

const AD_URL =
  "https://tracetxn.com/client-management?utm_source=google&utm_medium=cpc" +
  "&utm_campaign=client-mgmt-us&utm_term=client%20management%20software" +
  "&utm_content=headline-a";

beforeEach(() => {
  window.sessionStorage.clear();
});

/** jsdom's location is not writable; replace the whole object per test. */
function atUrl(href: string, referrer = "") {
  const url = new URL(href);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      href: url.href,
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
    },
  });
  Object.defineProperty(document, "referrer", {
    configurable: true,
    value: referrer,
  });
}

describe("parseAttribution — the happy path", () => {
  it("reads every UTM parameter off an ad landing URL", () => {
    const a = parseAttribution(AD_URL, "https://www.google.com/");
    expect(a).toMatchObject({
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "client-mgmt-us",
      utmTerm: "client management software",
      utmContent: "headline-a",
      referrer: "https://www.google.com/",
      landingPage: "/client-management",
    });
  });

  it("records the landing page even with no campaign attached", () => {
    const a = parseAttribution("https://tracetxn.com/pricing", "");
    expect(a?.landingPage).toBe("/pricing");
    expect(a?.utmSource).toBeNull();
  });

  it("returns null for an unparseable URL rather than throwing", () => {
    expect(parseAttribution("not a url", null)).toBeNull();
  });
});

describe("parseAttribution — no secret may reach storage", () => {
  it("NEVER stores the query string", () => {
    // The whole defence in one assertion: a token in the query is dropped
    // because only the five named UTM keys are read out of it.
    const a = parseAttribution(
      "https://tracetxn.com/pricing?token=SUPERSECRET&utm_source=google",
      "",
    );
    expect(JSON.stringify(a)).not.toContain("SUPERSECRET");
    expect(a?.landingPage).toBe("/pricing");
    expect(a?.utmSource).toBe("google");
  });

  it.each([
    "/reset-password/SUPERSECRET",
    "/join/SUPERSECRET",
    "/activate",
    "/pay/abc123",
    "/consent/abc123",
    "/app/clients",
    "/admin/beta-applications",
    "/api/beta/apply",
  ])("captures nothing at all on %s", (path) => {
    const a = parseAttribution(`https://tracetxn.com${path}?utm_source=x`, "");
    expect(a).toBeNull();
  });

  it("is not fooled by casing or a trailing slash on a sensitive path", () => {
    expect(isAttributionSafePath("/Reset-Password/abc")).toBe(false);
    expect(isAttributionSafePath("/app/")).toBe(false);
    expect(isAttributionSafePath("/APP/clients")).toBe(false);
  });

  it("does not treat a marketing path that merely starts with the same letters as sensitive", () => {
    // `/pay` is denied; `/payments-guide` is a legitimate public page and a
    // prefix check without the boundary would silently kill its attribution.
    for (const p of ["/payments-guide", "/joining-tips", "/application"]) {
      expect(isAttributionSafePath(p), p).toBe(true);
    }
  });

  it("rejects a path that is not a path", () => {
    for (const bad of ["", "https://evil.com/", "app", null, undefined]) {
      expect(isAttributionSafePath(bad as string), String(bad)).toBe(false);
    }
  });
});

describe("parseAttribution — the referrer", () => {
  it("drops a same-origin referrer, which is an internal hop and not a source", () => {
    const a = parseAttribution(
      "https://tracetxn.com/waitlist",
      "https://tracetxn.com/pricing",
    );
    expect(a?.referrer).toBeNull();
  });

  it("keeps a genuine external referrer", () => {
    const a = parseAttribution(
      "https://tracetxn.com/waitlist",
      "https://news.ycombinator.com/item?id=1",
    );
    expect(a?.referrer).toBe("https://news.ycombinator.com/item?id=1");
  });

  it("drops a non-http referrer instead of storing it verbatim", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "garbage",
    ]) {
      const a = parseAttribution("https://tracetxn.com/waitlist", bad);
      expect(a?.referrer, bad).toBeNull();
    }
  });
});

describe("field caps", () => {
  it("truncates an oversized value rather than storing it", () => {
    const huge = "x".repeat(50_000);
    const a = parseAttribution(
      `https://tracetxn.com/pricing?utm_campaign=${huge}`,
      "",
    );
    expect(a?.utmCampaign).toHaveLength(ATTRIBUTION_FIELD_MAX);
  });

  it("collapses blank and whitespace-only values to null", () => {
    const a = parseAttribution(
      "https://tracetxn.com/pricing?utm_source=&utm_medium=%20%20",
      "",
    );
    expect(a?.utmSource).toBeNull();
    expect(a?.utmMedium).toBeNull();
  });
});

describe("captureAttribution — first touch wins", () => {
  it("captures on the first page of the session", () => {
    atUrl(AD_URL, "https://www.google.com/");
    captureAttribution();
    expect(readAttribution().utmCampaign).toBe("client-mgmt-us");
  });

  it("does NOT overwrite when the visitor navigates on before converting", () => {
    // The whole reason this module exists: by the time the form is submitted
    // the URL has no UTM parameters and the referrer is our own site.
    atUrl(AD_URL, "https://www.google.com/");
    captureAttribution();
    atUrl("https://tracetxn.com/pricing", "https://tracetxn.com/client-management");
    captureAttribution();
    atUrl("https://tracetxn.com/waitlist", "https://tracetxn.com/pricing");
    captureAttribution();

    const a = readAttribution();
    expect(a.utmSource).toBe("google");
    expect(a.utmCampaign).toBe("client-mgmt-us");
    expect(a.landingPage).toBe("/client-management");
    expect(a.referrer).toBe("https://www.google.com/");
  });

  it("leaves the first-touch slot open when the session starts on a sensitive route", () => {
    // Writing a placeholder for the reset-password page would burn the slot
    // and lose the real campaign that follows it.
    atUrl("https://tracetxn.com/reset-password/SECRET", "https://mail.google.com/");
    captureAttribution();
    expect(window.sessionStorage.length).toBe(0);

    atUrl(AD_URL, "https://www.google.com/");
    captureAttribution();
    expect(readAttribution().utmCampaign).toBe("client-mgmt-us");
  });

  it("survives storage being unavailable", () => {
    // A browser in "block all cookies and site data" mode THROWS on access,
    // it does not return null. Swap the whole object rather than spying on
    // `Storage.prototype`: jsdom's sessionStorage is proxied, so a prototype
    // spy is never reached and the test would pass against a broken module.
    const real = window.sessionStorage;
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError: storage is disabled");
      },
      setItem: () => {
        throw new Error("SecurityError: storage is disabled");
      },
      length: 0,
    };
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: throwing,
    });

    atUrl(AD_URL, "");
    expect(() => captureAttribution()).not.toThrow();
    expect(() => readAttribution()).not.toThrow();
    expect(readAttribution()).toEqual({
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      utmTerm: null,
      utmContent: null,
      referrer: null,
      landingPage: null,
    });
    // And a page that renders it must not break either.
    expect(attributionForSubmit()).toBeUndefined();

    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: real,
    });
  });

  it("survives corrupt stored JSON", () => {
    window.sessionStorage.setItem("tracetxn.attribution.v1", "{not json");
    expect(readAttribution().utmSource).toBeNull();
  });

  it("re-cleans values on read, because storage is client-writable", () => {
    window.sessionStorage.setItem(
      "tracetxn.attribution.v1",
      JSON.stringify({ utmSource: "y".repeat(9999), utmMedium: 42 }),
    );
    const a = readAttribution();
    expect(a.utmSource).toHaveLength(ATTRIBUTION_FIELD_MAX);
    expect(a.utmMedium).toBeNull(); // a number is not a value we store
  });
});

describe("attributionForSubmit", () => {
  it("is undefined when there is nothing to report, so the field is omitted", () => {
    expect(attributionForSubmit()).toBeUndefined();
  });

  it("returns the captured attribution once there is one", () => {
    atUrl(AD_URL, "https://www.google.com/");
    captureAttribution();
    expect(attributionForSubmit()?.utmSource).toBe("google");
  });

  it("isEmptyAttribution recognises an all-null object", () => {
    expect(isEmptyAttribution(readAttribution())).toBe(true);
  });
});

describe("the server boundary", () => {
  /**
   * The client is not the enforcement point. These assertions run the same
   * payloads through the zod schema the API route uses, because a caller can
   * POST directly and never touch the browser module at all.
   */
  it("accepts a well-formed payload", () => {
    const r = attributionSchema.safeParse({
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "c",
      utmTerm: null,
      utmContent: null,
      referrer: "https://www.google.com/",
      landingPage: "/client-management",
    });
    expect(r.success).toBe(true);
  });

  it("accepts an absent or partial object — a direct visit has no attribution", () => {
    expect(attributionSchema.safeParse({}).success).toBe(true);
    expect(attributionSchema.safeParse({ utmSource: "x" }).success).toBe(true);
  });

  it("REJECTS an oversized field rather than truncating it server-side", () => {
    // Truncating would accept an abusive payload silently; the route should
    // fail loudly so the request is rejected as malformed.
    const r = attributionSchema.safeParse({ utmCampaign: "x".repeat(5000) });
    expect(r.success).toBe(false);
  });

  it("rejects a non-string field", () => {
    for (const bad of [{ utmSource: 1 }, { utmSource: {} }, { utmSource: ["a"] }]) {
      expect(attributionSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });

  it("strips unknown keys, so a crafted body cannot add fields to the document", () => {
    const r = attributionSchema.parse({
      utmSource: "google",
      isAdmin: true,
      status: "ACTIVATED",
      _id: "000000000000000000000000",
    });
    expect(r).not.toHaveProperty("isAdmin");
    expect(r).not.toHaveProperty("status");
    expect(r).not.toHaveProperty("_id");
    expect(Object.keys(r).sort()).toEqual([
      "landingPage",
      "referrer",
      "utmCampaign",
      "utmContent",
      "utmMedium",
      "utmSource",
      "utmTerm",
    ]);
  });

  it("stores null instead of a row of nulls", () => {
    expect(attributionForStorage(attributionSchema.parse({}))).toBeNull();
    expect(attributionForStorage(null)).toBeNull();
    expect(
      attributionForStorage(attributionSchema.parse({ utmSource: "google" })),
    ).toMatchObject({ utmSource: "google" });
  });
});
