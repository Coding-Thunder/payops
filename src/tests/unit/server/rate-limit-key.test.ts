// @vitest-environment node
//
// Node, not the project's default jsdom: `withApi` reaches `env.server`, which
// refuses to load when `window` exists ("Server env cannot be read from the
// browser bundle"). This file drives a route wrapper, so node is the honest
// environment for it. It also matters that the UNIT project is used rather
// than integration: integration sets TRACETXN_TEST_MODE, which short-circuits
// enforceRateLimit entirely (security.ts:104) — the limiter would never run.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

/**
 * The rate-limit bucket must not be chosen by the caller.
 *
 * The key used to be `${clientIp}|${cookie.slice(0, 16)}`. On an
 * unauthenticated endpoint — which is every route that needs a limiter most —
 * the Cookie header is whatever the caller sends, so one junk cookie per
 * request produced one fresh bucket per request. The ceilings on
 * /api/auth/login, /api/auth/firebase-session, /api/auth/signup,
 * /api/auth/forgot-password, /api/beta/activate and /api/beta/apply could all
 * be lifted completely by rotating a made-up value. The limiter counted honest
 * callers and waved through the attacker it existed to stop.
 *
 * These tests drive the REAL `withApi` wrapper and assert on the HTTP status
 * it returns. An earlier version of this file re-implemented `rateLimitKey`
 * locally and asserted against the copy — which proved the copy correct and
 * could not have caught a regression in the function that actually runs. The
 * limiter is reached through the public surface instead, so the thing under
 * test is the thing that ships.
 */

// `withApi` calls enforceSameOrigin(), which reads next/headers. The unit
// project installs no mock for it (that lives in integration.setup.ts), so one
// is provided here. The origin must match env.server.APP_URL or the guard
// rejects before the limiter is reached.
const originHeaders = new Map<string, string>();

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => originHeaders.get(name.toLowerCase()) ?? null,
  }),
  cookies: async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  }),
}));

let routeSeq = 0;
const nextRoute = () => `ratelimit-key-test-${(routeSeq += 1)}`;

async function makeHandler(max: number) {
  const { withApi, jsonOk } = await import("@/server/api/respond");
  // A distinct route per case, so one case's bucket can never leak into
  // another's and a green run cannot be an artefact of ordering.
  // The parameter is what makes withApi<TArgs> infer a one-arg wrapper; it is
  // referenced so no unused binding is left behind.
  return withApi(async (req: Request) => {
    void req;
    return jsonOk({ ok: true }) as never;
  }, {
    rateLimit: { route: nextRoute(), max, windowMs: 60_000 },
  });
}

/** A POST that passes the same-origin guard, varying only the Cookie. */
function req(cookie?: string, ip = "203.0.113.7"): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: "http://localhost:3000",
    host: "localhost:3000",
    "cf-connecting-ip": ip,
  };
  if (cookie !== undefined) headers.cookie = cookie;
  return new Request("http://localhost:3000/api/test", {
    method: "POST",
    headers,
    body: "{}",
  });
}

let savedTestMode: string | undefined;

beforeEach(async () => {
  // `enforceRateLimit` returns immediately when TRACETXN_TEST_MODE is set
  // (security.ts:104), an affordance so tight test loops do not trip
  // production-sized limits. `integration.global-setup.ts` sets it
  // process-wide, so in a full `npm test` run this file inherits it and the
  // limiter silently no-ops — the tests passed in isolation and asserted
  // nothing in the suite. Opt out deliberately, and restore it afterwards so
  // no other file in this worker is affected.
  savedTestMode = process.env.TRACETXN_TEST_MODE;
  delete process.env.TRACETXN_TEST_MODE;

  // The limiter is an in-process Map, so each case needs a fresh module graph.
  vi.resetModules();
  const { env } = await import("@/lib/env");
  originHeaders.clear();
  originHeaders.set("origin", env.server.APP_URL);
});

afterEach(() => {
  if (savedTestMode === undefined) delete process.env.TRACETXN_TEST_MODE;
  else process.env.TRACETXN_TEST_MODE = savedTestMode;
});

describe("rate limiting cannot be escaped by rotating a cookie", () => {
  it("counts a rotating Cookie as ONE caller", async () => {
    const handler = await makeHandler(1);

    const first = await handler(req("tracetxn_session=first-value"));
    const second = await handler(req("tracetxn_session=a-completely-different-value"));

    expect(first.status).toBe(200);
    // Before the fix this was 200: a different cookie meant a different
    // bucket, so the ceiling never bound.
    expect(second.status).toBe(429);
  });

  it("holds across many rotations, not just two", async () => {
    const handler = await makeHandler(2);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await handler(req(`tracetxn_session=rotating-${i}`));
      statuses.push(res.status);
    }
    // Exactly `max` get through, whatever the caller does to its cookie.
    expect(statuses.filter((s) => s === 200)).toHaveLength(2);
    expect(statuses.filter((s) => s === 429)).toHaveLength(4);
  });

  it("treats a cookie-less caller as the same bucket", async () => {
    const handler = await makeHandler(1);
    const a = await handler(req(undefined));
    const b = await handler(req("anything=at-all"));
    expect(a.status).toBe(200);
    expect(b.status).toBe(429);
  });

  it("still separates genuinely different callers", async () => {
    const handler = await makeHandler(1);
    const a = await handler(req(undefined, "203.0.113.7"));
    const b = await handler(req(undefined, "198.51.100.42"));
    // A real limiter must not punish unrelated callers.
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});
