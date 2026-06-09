// @vitest-environment node

import { describe, expect, it } from "vitest";

import { DomainEventType } from "@/lib/constants/events";
import { isEventVisibleToUser } from "@/server/events/bus";

/**
 * `isEventVisibleToUser` is the gatekeeper for SSE delivery, incorrectly
 * fanning an admin-only event out to a STAFF viewer would leak
 * cross-tenant data. Pin the matrix.
 *
 * Pass 5a adds an orgId tenant-gate that runs BEFORE the existing
 * audience-kind filter. The legacy tests are preserved (all use
 * matching org "org-A") and a new cross-tenant block locks in the
 * scope check.
 */

const ORG_A = "00000000000000000000000a";
const ORG_B = "00000000000000000000000b";

const baseEvent = {
  id: "e1",
  type: DomainEventType.ORDER_CREATED,
  at: new Date().toISOString(),
  actor: { id: "u1", name: "x", role: "ADMIN" as const },
  orgId: ORG_A,
  payload: { foo: 1 },
};

describe("isEventVisibleToUser", () => {
  describe("audience.kind = 'all'", () => {
    it.each(["SUPER_ADMIN", "ADMIN", "STAFF"] as const)(
      "delivers to %s within the same org",
      (role) => {
        const ev = { ...baseEvent, audience: { kind: "all" as const } };
        expect(
          isEventVisibleToUser(ev, { userId: "u1", role, orgId: ORG_A }),
        ).toBe(true);
      },
    );
  });

  describe("audience.kind = 'admins'", () => {
    it("delivers to ADMIN and SUPER_ADMIN within the same org", () => {
      const ev = { ...baseEvent, audience: { kind: "admins" as const } };
      expect(
        isEventVisibleToUser(ev, { userId: "u1", role: "ADMIN", orgId: ORG_A }),
      ).toBe(true);
      expect(
        isEventVisibleToUser(ev, {
          userId: "u1",
          role: "SUPER_ADMIN",
          orgId: ORG_A,
        }),
      ).toBe(true);
    });

    it("does NOT deliver to STAFF (even same-org)", () => {
      const ev = { ...baseEvent, audience: { kind: "admins" as const } };
      expect(
        isEventVisibleToUser(ev, { userId: "u1", role: "STAFF", orgId: ORG_A }),
      ).toBe(false);
    });
  });

  describe("audience.kind = 'creator'", () => {
    it("delivers to the creator regardless of role (same org)", () => {
      const ev = {
        ...baseEvent,
        audience: { kind: "creator" as const, userId: "u-target" },
      };
      expect(
        isEventVisibleToUser(ev, {
          userId: "u-target",
          role: "STAFF",
          orgId: ORG_A,
        }),
      ).toBe(true);
    });

    it("delivers to other admins of the same org (they see all)", () => {
      const ev = {
        ...baseEvent,
        audience: { kind: "creator" as const, userId: "u-target" },
      };
      expect(
        isEventVisibleToUser(ev, {
          userId: "u-other",
          role: "ADMIN",
          orgId: ORG_A,
        }),
      ).toBe(true);
    });

    it("does NOT deliver to OTHER staff", () => {
      const ev = {
        ...baseEvent,
        audience: { kind: "creator" as const, userId: "u-target" },
      };
      expect(
        isEventVisibleToUser(ev, {
          userId: "u-other",
          role: "STAFF",
          orgId: ORG_A,
        }),
      ).toBe(false);
    });
  });

  describe("Pass 5a, orgId tenant gate", () => {
    it("does NOT deliver an event from Org A to a viewer in Org B", () => {
      const ev = {
        ...baseEvent,
        audience: { kind: "all" as const },
        orgId: ORG_A,
      };
      expect(
        isEventVisibleToUser(ev, {
          userId: "u1",
          role: "SUPER_ADMIN",
          orgId: ORG_B,
        }),
      ).toBe(false);
    });

    it("does NOT deliver an admin-audience event cross-tenant (even to a peer admin)", () => {
      const ev = {
        ...baseEvent,
        audience: { kind: "admins" as const },
        orgId: ORG_A,
      };
      expect(
        isEventVisibleToUser(ev, { userId: "u1", role: "ADMIN", orgId: ORG_B }),
      ).toBe(false);
    });

    it("does NOT deliver a creator-audience event cross-tenant", () => {
      const ev = {
        ...baseEvent,
        audience: { kind: "creator" as const, userId: "u-target" },
        orgId: ORG_A,
      };
      expect(
        isEventVisibleToUser(ev, {
          userId: "u-target",
          role: "STAFF",
          orgId: ORG_B,
        }),
      ).toBe(false);
    });

    it("does NOT deliver when the viewer has no resolved org (legacy null orgId)", () => {
      const ev = {
        ...baseEvent,
        audience: { kind: "all" as const },
        orgId: ORG_A,
      };
      expect(
        isEventVisibleToUser(ev, {
          userId: "u1",
          role: "ADMIN",
          orgId: null,
        }),
      ).toBe(false);
    });

    it("system event (event.orgId === null) bypasses the tenant gate and falls through to the audience filter", () => {
      const ev = {
        ...baseEvent,
        audience: { kind: "all" as const },
        orgId: null,
      };
      expect(
        isEventVisibleToUser(ev, {
          userId: "u1",
          role: "STAFF",
          orgId: ORG_B,
        }),
      ).toBe(true);
    });

    it("system event with 'admins' audience still respects the role filter", () => {
      const ev = {
        ...baseEvent,
        audience: { kind: "admins" as const },
        orgId: null,
      };
      expect(
        isEventVisibleToUser(ev, {
          userId: "u1",
          role: "STAFF",
          orgId: ORG_B,
        }),
      ).toBe(false);
    });
  });
});
