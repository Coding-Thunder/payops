import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The unit project runs in jsdom, where `@/lib/env` refuses to expose server
 * values. The token helpers only need the signing secret, so stub the module
 * rather than move these into the integration project (which needs a live
 * Mongo and a .env.test).
 */
vi.mock("@/lib/env", () => ({
  env: {
    server: {
      JWT_SECRET: "unit-test-signing-secret-0123456789abcdefghijklmnop",
      APP_NAME: "TraceTxn",
      APP_URL: "http://localhost:3000",
    },
    public: {},
  },
}));

/**
 * Regression guards for the console fixes. Each test names the defect it
 * pins; if one of these fails, the corresponding bug is back.
 */

// ── P0-1: one token implementation ────────────────────────────────────────
describe("P0-1 reset tokens are minted by the canonical implementation", () => {
  it("the console re-exports the main app's generator, not a copy", async () => {
    const consoleMod = await import("@/console/server/auth/reset-token");
    const canonical = await import("@/server/services/password-reset.service");
    // Identity, not just equivalence: the console cannot drift from the main
    // app because it is literally the same function object.
    expect(consoleMod.generateResetToken).toBe(canonical.generateResetToken);
  });

  it("mints a head the main app's verifier accepts", async () => {
    const { generateResetToken, parseResetToken } = await import(
      "@/server/services/password-reset.service"
    );
    const crypto = await import("node:crypto");
    const passwordHash = "$2b$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const token = generateResetToken({ _id: "6a8534515dbc1a7a47ded4b3", passwordHash });
    const parsed = parseResetToken(token);

    // The head the verifier will recompute at redemption time.
    const expected = crypto
      .createHash("sha256")
      .update(passwordHash)
      .digest("base64url")
      .slice(0, 16);
    expect(parsed.passwordHashHead).toBe(expected);
    // The old bug: an 8-char raw slice that could never equal the 16-char hash.
    expect(parsed.passwordHashHead).not.toBe(passwordHash.slice(0, 8));
    expect(parsed.passwordHashHead).toHaveLength(16);
  });

  it("produces a base64url head, so a dotted bcrypt salt can't split the payload", async () => {
    const { generateResetToken, parseResetToken } = await import(
      "@/server/services/password-reset.service"
    );
    // A hash whose first 8 chars contain "." — the case the console used to
    // guard against by re-hashing in a loop.
    const token = generateResetToken({ _id: "abc", passwordHash: "$2b$10$.dotted.salt.value" });
    expect(() => parseResetToken(token)).not.toThrow();
    expect(parseResetToken(token).passwordHashHead).not.toContain(".");
  });
});

// ── P1-7: one error contract ─────────────────────────────────────────────
describe("P1-7 the console uses the canonical error contract", () => {
  it("re-exports the root jsonError, so the argument order cannot diverge", async () => {
    const consoleHttp = await import("@/console/server/http");
    const respond = await import("@/server/api/respond");
    expect(consoleHttp.jsonError).toBe(respond.jsonError);
    expect(consoleHttp.jsonOk).toBe(respond.jsonOk);
  });

  it("puts the code in `code` and the message in `message`", async () => {
    const { jsonError } = await import("@/console/server/http");
    const body = await jsonError(401, "UNAUTHORIZED", "Unauthorized").json();
    expect(body).toEqual({ ok: false, error: { code: "UNAUTHORIZED", message: "Unauthorized" } });
  });
});

// ── P1-2: the rate limiter evicts ────────────────────────────────────────
describe("P1-2 rate limiter cannot grow without bound", () => {
  beforeEach(async () => {
    const { _resetRateLimitForTests } = await import("@/console/server/rate-limit");
    _resetRateLimitForTests();
    vi.useRealTimers();
  });

  it("still enforces the limit", async () => {
    const { rateLimit } = await import("@/console/server/rate-limit");
    for (let i = 0; i < 3; i++) expect(rateLimit("k", 3, 60_000)).toBe(true);
    expect(rateLimit("k", 3, 60_000)).toBe(false);
  });

  it("sweeps expired buckets instead of retaining every key forever", async () => {
    const { rateLimit, _rateLimitStateForTests, _resetRateLimitForTests } =
      await import("@/console/server/rate-limit");
    _resetRateLimitForTests();

    const now = Date.now();
    const spy = vi.spyOn(Date, "now");
    // 500 attacker-chosen keys inside one short window.
    spy.mockReturnValue(now);
    for (let i = 0; i < 500; i++) rateLimit(`otp-req-email:a${i}@x.test`, 5, 1_000);
    expect(_rateLimitStateForTests().size).toBe(500);

    // Past the window AND past the sweep interval → the map is reclaimed.
    spy.mockReturnValue(now + 120_000);
    rateLimit("trigger-sweep", 5, 1_000);
    expect(_rateLimitStateForTests().size).toBeLessThan(10);
    spy.mockRestore();
  });
});

// ── P1-3: one IP resolver ────────────────────────────────────────────────
describe("P1-3 client IP resolution is not spoofable", () => {
  it("prefers CF-Connecting-IP over a client-supplied X-Forwarded-For", async () => {
    const { clientIp } = await import("@/console/server/http");
    const req = new Request("http://x.test", {
      headers: {
        "x-forwarded-for": "1.2.3.4, 10.0.0.1",
        "cf-connecting-ip": "203.0.113.9",
      },
    });
    // The old console version returned "1.2.3.4" — attacker-controlled, so a
    // fresh rate-limit bucket on every request.
    expect(clientIp(req)).toBe("203.0.113.9");
  });

  it("falls back through x-real-ip, then the first XFF hop", async () => {
    const { clientIp } = await import("@/console/server/http");
    expect(
      clientIp(new Request("http://x.test", { headers: { "x-real-ip": "198.51.100.7", "x-forwarded-for": "1.2.3.4" } })),
    ).toBe("198.51.100.7");
    expect(
      clientIp(new Request("http://x.test", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } })),
    ).toBe("1.2.3.4");
    expect(clientIp(new Request("http://x.test"))).toBeNull();
  });
});

// ── P1-5: deep-link return path is origin-safe ───────────────────────────
describe("P1-5 the console `next` parameter cannot be used as an open redirect", () => {
  it("accepts console paths and rejects everything else", async () => {
    const { isSafeConsolePath } = await import("@/console/server/auth/session");
    for (const ok of ["/admin", "/admin/dashboard", "/admin/orders/123?status=PAID&page=2"]) {
      expect(isSafeConsolePath(ok), ok).toBe(true);
    }
    for (const bad of [
      "//evil.example.com",
      "https://evil.example.com/admin",
      "/app/dashboard",
      "/login",
      "/administrators",
      "admin/dashboard",
      "",
      null,
      undefined,
    ]) {
      expect(isSafeConsolePath(bad as string), String(bad)).toBe(false);
    }
  });
});

// ── P2-7: constants are canonical ────────────────────────────────────────
describe("P2-7 the console does not keep its own copies of shared constants", () => {
  it("re-uses the canonical order statuses and gateway keys", async () => {
    const orders = await import("@/console/server/services/orders");
    const enums = await import("@/lib/constants/enums");
    expect(orders.ORDER_STATUSES).toBe(enums.ORDER_STATUSES);
    expect(orders.GATEWAYS).toBe(enums.PAYMENT_GATEWAY_KEYS);
  });
});
