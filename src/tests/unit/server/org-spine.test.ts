// @vitest-environment node

import { describe, expect, it } from "vitest";

import { UserRole } from "@/lib/constants/enums";
import {
  buildOrgContext,
  orgIdFilter,
  requireOrgId,
} from "@/server/db/org/org-context";
import { signSession, verifySession } from "@/server/auth/jwt";

const VALID_OBJECT_ID = "507f1f77bcf86cd799439011";
const ANOTHER_OBJECT_ID = "507f191e810c19729de860ea";

describe("OrgContext helpers", () => {
  describe("requireOrgId", () => {
    it("returns the id when valid", () => {
      expect(requireOrgId(VALID_OBJECT_ID)).toBe(VALID_OBJECT_ID);
    });

    it("throws on null / undefined", () => {
      expect(() => requireOrgId(null)).toThrowError(/organization scope/i);
      expect(() => requireOrgId(undefined)).toThrowError(/organization scope/i);
    });

    it("throws on empty string", () => {
      expect(() => requireOrgId("")).toThrowError(/organization scope/i);
    });

    it("throws on a non-ObjectId string", () => {
      expect(() => requireOrgId("not-an-object-id")).toThrowError(
        /invalid organization id/i,
      );
    });
  });

  describe("buildOrgContext", () => {
    const actor = {
      id: VALID_OBJECT_ID,
      name: "Ada",
      email: "ada@tracetxn.test",
      role: UserRole.ADMIN,
    };

    it("constructs an OrgContext when orgId is valid", () => {
      const ctx = buildOrgContext({
        orgId: ANOTHER_OBJECT_ID,
        actor,
        request: null,
      });
      expect(ctx.orgId).toBe(ANOTHER_OBJECT_ID);
      expect(ctx.actor.email).toBe("ada@tracetxn.test");
    });

    it("throws Unauthorized when orgId is missing — never silently falls back", () => {
      expect(() =>
        buildOrgContext({ orgId: null, actor, request: null }),
      ).toThrowError(/sign in again/i);
    });

    it("throws Unauthorized on a malformed orgId", () => {
      expect(() =>
        buildOrgContext({ orgId: "garbage", actor, request: null }),
      ).toThrowError(/invalid organization context/i);
    });
  });

  describe("orgIdFilter", () => {
    it("converts the hex string to a Mongo ObjectId", () => {
      const oid = orgIdFilter(VALID_OBJECT_ID);
      expect(String(oid)).toBe(VALID_OBJECT_ID);
    });
  });
});

describe("JWT carries org claims when present", () => {
  const base = {
    sub: VALID_OBJECT_ID,
    email: "ada@tracetxn.test",
    name: "Ada Lovelace",
    role: UserRole.ADMIN,
  };

  it("round-trips orgId and orgIds", async () => {
    const token = await signSession({
      ...base,
      orgId: ANOTHER_OBJECT_ID,
      orgIds: [ANOTHER_OBJECT_ID, VALID_OBJECT_ID],
    });
    const decoded = await verifySession(token);
    expect(decoded?.orgId).toBe(ANOTHER_OBJECT_ID);
    expect(decoded?.orgIds).toEqual([ANOTHER_OBJECT_ID, VALID_OBJECT_ID]);
  });

  it("omits org claims when caller doesn't pass them (legacy compat)", async () => {
    const token = await signSession(base);
    const decoded = await verifySession(token);
    // Pre-migration tokens carry no org claim; the session resolver
    // falls back to User.primaryOrgId.
    expect(decoded?.orgId).toBeUndefined();
    expect(decoded?.orgIds).toBeUndefined();
  });

  it("does NOT leak orgId into the token if explicitly undefined", async () => {
    const token = await signSession({ ...base, orgId: undefined });
    const decoded = await verifySession(token);
    expect(decoded?.orgId).toBeUndefined();
  });
});
