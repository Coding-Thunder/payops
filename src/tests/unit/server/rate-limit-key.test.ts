// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { jsonOk, withApi } from "@/server/api/respond";
import { _resetRateLimitsForTests } from "@/server/api/security";

/**
 * The rate-limit key used the first 16 characters of the Cookie header —
 * the cookie NAME — so every signed-in user behind one IP shared a bucket,
 * and a caller could reset a pre-sign-in limit by sending another cookie.
 */

let mode: string | undefined;
beforeEach(() => {
  mode = process.env.PAYOPS_TEST_MODE;
  delete process.env.PAYOPS_TEST_MODE;
  _resetRateLimitsForTests();
});
afterEach(() => {
  process.env.PAYOPS_TEST_MODE = mode;
  _resetRateLimitsForTests();
});

const get = (cookie?: string, ip = "203.0.113.7") =>
  new Request("https://app.example.com/api/x", {
    headers: { "x-forwarded-for": ip, ...(cookie ? { cookie } : {}) },
  });

describe("keyBy: ip (routes used before signing in)", () => {
  const handler = withApi(async (req: Request) => jsonOk({ ok: Boolean(req) }), {
    rateLimit: { route: "t-ip", max: 2, windowMs: 60_000, keyBy: "ip" },
  });

  it("is not reset by sending a different cookie", async () => {
    expect((await handler(get("a=1"))).status).toBe(200);
    expect((await handler(get("a=2"))).status).toBe(200);
    expect((await handler(get("payops_session=zzz"))).status).toBe(429);
  });

  it("still separates different clients", async () => {
    expect((await handler(get(undefined, "198.51.100.1"))).status).toBe(200);
    expect((await handler(get(undefined, "198.51.100.1"))).status).toBe(200);
    expect((await handler(get(undefined, "198.51.100.2"))).status).toBe(200);
  });

  it("prefers the address Cloudflare reports over a client-sent one", async () => {
    const req = (fwd: string) =>
      new Request("https://app.example.com/api/x", {
        headers: { "cf-connecting-ip": "192.0.2.9", "x-forwarded-for": fwd },
      });
    expect((await handler(req("1.1.1.1"))).status).toBe(200);
    expect((await handler(req("2.2.2.2"))).status).toBe(200);
    expect((await handler(req("3.3.3.3"))).status).toBe(429);
  });
});

describe("keyBy: session (default)", () => {
  const handler = withApi(async (req: Request) => jsonOk({ ok: Boolean(req) }), {
    rateLimit: { route: "t-session", max: 1, windowMs: 60_000 },
  });

  it("gives two operators behind one IP their own limits", async () => {
    expect((await handler(get("payops_session=token-a"))).status).toBe(200);
    expect((await handler(get("payops_session=token-b"))).status).toBe(200);
    expect((await handler(get("payops_session=token-a"))).status).toBe(429);
  });

  it("is not changed by other cookies", async () => {
    expect((await handler(get("x=1; payops_session=token-c"))).status).toBe(200);
    expect((await handler(get("payops_session=token-c; y=2"))).status).toBe(429);
  });
});
