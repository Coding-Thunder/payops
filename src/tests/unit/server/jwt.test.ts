// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import { UserRole } from "@/lib/constants/enums";
import {
  getSessionTtlSeconds,
  signSession,
  verifySession,
} from "@/server/auth/jwt";

describe("JWT session", () => {
  const payload = {
    sub: "507f1f77bcf86cd799439011",
    email: "ada@tracetxn.test",
    name: "Ada Lovelace",
    role: UserRole.ADMIN,
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips a session payload via sign + verify", async () => {
    const token = await signSession(payload);
    const decoded = await verifySession(token);
    expect(decoded).toEqual(payload);
  });

  it("verifySession returns null for an empty token", async () => {
    expect(await verifySession("")).toBeNull();
  });

  it("verifySession returns null for a garbage token", async () => {
    expect(await verifySession("not.a.jwt")).toBeNull();
  });

  it("verifySession rejects a token signed with a different secret", async () => {
    const stash = process.env.JWT_SECRET;
    try {
      process.env.JWT_SECRET = "an-entirely-different-secret-of-sufficient-length-32";
      // The internal key cache is set on first use — bust by re-importing.
      vi.resetModules();
      const { signSession: badSign } = await import("@/server/auth/jwt");
      const otherToken = await badSign(payload);
      vi.resetModules();
      process.env.JWT_SECRET = stash;
      const { verifySession: realVerify } = await import("@/server/auth/jwt");
      expect(await realVerify(otherToken)).toBeNull();
    } finally {
      if (stash !== undefined) process.env.JWT_SECRET = stash;
    }
  });

  it("verifySession returns null after the token expires", async () => {
    const token = await signSession(payload);
    vi.useFakeTimers();
    // 12h + buffer to ensure expiry.
    vi.setSystemTime(new Date(Date.now() + 13 * 60 * 60 * 1000));
    const decoded = await verifySession(token);
    expect(decoded).toBeNull();
  });

  describe("getSessionTtlSeconds", () => {
    // Inputs are clamped to [60s, 7d] so a misconfigured env can't ship
    // ultra-short or ultra-long sessions.
    it.each([
      ["12h", 12 * 60 * 60],
      ["30m", 30 * 60],
      ["7d", 7 * 24 * 60 * 60],
      ["45s", 60], // below the 60s floor → clamped up
      ["30d", 7 * 24 * 60 * 60], // above the 7d ceiling → clamped down
    ])("parses %s as %i seconds", async (value, expected) => {
      const stash = process.env.JWT_EXPIRES_IN;
      try {
        process.env.JWT_EXPIRES_IN = value;
        vi.resetModules();
        const { getSessionTtlSeconds: t } = await import("@/server/auth/jwt");
        expect(t()).toBe(expected);
      } finally {
        if (stash !== undefined) process.env.JWT_EXPIRES_IN = stash;
      }
    });

    it("falls back to 12h on a malformed TTL", () => {
      // The current process picked up the .env.test default of 12h.
      expect(getSessionTtlSeconds()).toBe(12 * 60 * 60);
    });
  });
});
