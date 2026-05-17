// @vitest-environment node

import { describe, expect, it } from "vitest";

import { DomainEventType } from "@/lib/constants/events";
import { isEventVisibleToUser } from "@/server/events/bus";

/**
 * `isEventVisibleToUser` is the gatekeeper for SSE delivery — incorrectly
 * fanning an admin-only event out to a STAFF viewer would leak
 * cross-tenant data. Pin the matrix.
 */

const baseEvent = {
  id: "e1",
  type: DomainEventType.ORDER_CREATED,
  at: new Date().toISOString(),
  actor: { id: "u1", name: "x", role: "ADMIN" as const },
  payload: { foo: 1 },
};

describe("isEventVisibleToUser", () => {
  describe("audience.kind = 'all'", () => {
    it.each(["SUPER_ADMIN", "ADMIN", "STAFF"] as const)(
      "delivers to %s",
      (role) => {
        const ev = { ...baseEvent, audience: { kind: "all" as const } };
        expect(
          isEventVisibleToUser(ev, { userId: "u1", role }),
        ).toBe(true);
      },
    );
  });

  describe("audience.kind = 'admins'", () => {
    it("delivers to ADMIN and SUPER_ADMIN", () => {
      const ev = { ...baseEvent, audience: { kind: "admins" as const } };
      expect(isEventVisibleToUser(ev, { userId: "u1", role: "ADMIN" })).toBe(
        true,
      );
      expect(
        isEventVisibleToUser(ev, { userId: "u1", role: "SUPER_ADMIN" }),
      ).toBe(true);
    });

    it("does NOT deliver to STAFF", () => {
      const ev = { ...baseEvent, audience: { kind: "admins" as const } };
      expect(isEventVisibleToUser(ev, { userId: "u1", role: "STAFF" })).toBe(
        false,
      );
    });
  });

  describe("audience.kind = 'creator'", () => {
    it("delivers to the creator regardless of role", () => {
      const ev = {
        ...baseEvent,
        audience: { kind: "creator" as const, userId: "u-target" },
      };
      expect(
        isEventVisibleToUser(ev, { userId: "u-target", role: "STAFF" }),
      ).toBe(true);
    });

    it("delivers to other admins (they see all)", () => {
      const ev = {
        ...baseEvent,
        audience: { kind: "creator" as const, userId: "u-target" },
      };
      expect(
        isEventVisibleToUser(ev, { userId: "u-other", role: "ADMIN" }),
      ).toBe(true);
    });

    it("does NOT deliver to OTHER staff", () => {
      const ev = {
        ...baseEvent,
        audience: { kind: "creator" as const, userId: "u-target" },
      };
      expect(
        isEventVisibleToUser(ev, { userId: "u-other", role: "STAFF" }),
      ).toBe(false);
    });
  });
});
