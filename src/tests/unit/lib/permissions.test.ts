import { describe, expect, it } from "vitest";

import { UserRole } from "@/lib/constants/enums";
import {
  Permission,
  roleHasAnyPermission,
  roleHasPermission,
} from "@/lib/constants/permissions";

/**
 * Role/permission matrix is the single source of truth for authorization.
 * Pin every transition here so a regression in this file fails CI loudly.
 */

describe("permissions matrix", () => {
  describe("STAFF", () => {
    it.each([
      Permission.ORDER_VIEW_OWN,
      Permission.ORDER_CREATE,
      Permission.ORDER_REGENERATE_LINK,
    ])("has %s", (p) => {
      expect(roleHasPermission(UserRole.STAFF, p)).toBe(true);
    });

    it.each([
      Permission.USER_VIEW,
      Permission.USER_CREATE,
      Permission.USER_DISABLE,
      Permission.ORDER_VIEW_ALL,
      Permission.ORDER_UPDATE,
      Permission.ORDER_ARCHIVE,
      Permission.ANALYTICS_VIEW,
      Permission.SETTINGS_VIEW,
      Permission.SETTINGS_UPDATE,
      Permission.AUDIT_VIEW,
    ])("does NOT have %s", (p) => {
      expect(roleHasPermission(UserRole.STAFF, p)).toBe(false);
    });
  });

  describe("ADMIN", () => {
    it("inherits every STAFF permission", () => {
      const staffPerms = [
        Permission.ORDER_VIEW_OWN,
        Permission.ORDER_CREATE,
        Permission.ORDER_REGENERATE_LINK,
      ];
      for (const p of staffPerms) {
        expect(roleHasPermission(UserRole.ADMIN, p)).toBe(true);
      }
    });

    it("gains admin-only permissions", () => {
      const adminOnly = [
        Permission.USER_VIEW,
        Permission.ORDER_VIEW_ALL,
        Permission.ANALYTICS_VIEW,
        Permission.AUDIT_VIEW,
        Permission.SETTINGS_UPDATE,
      ];
      for (const p of adminOnly) {
        expect(roleHasPermission(UserRole.ADMIN, p)).toBe(true);
      }
    });
  });

  describe("SUPER_ADMIN", () => {
    it("has every permission in the registry", () => {
      for (const p of Object.values(Permission)) {
        expect(roleHasPermission(UserRole.SUPER_ADMIN, p)).toBe(true);
      }
    });
  });

  describe("roleHasAnyPermission", () => {
    it("returns true if at least one permission matches", () => {
      expect(
        roleHasAnyPermission(UserRole.STAFF, [
          Permission.USER_DISABLE,
          Permission.ORDER_CREATE,
        ]),
      ).toBe(true);
    });

    it("returns false when no permission matches", () => {
      expect(
        roleHasAnyPermission(UserRole.STAFF, [
          Permission.USER_DISABLE,
          Permission.AUDIT_VIEW,
        ]),
      ).toBe(false);
    });

    it("returns false on an empty list (vacuous)", () => {
      expect(roleHasAnyPermission(UserRole.SUPER_ADMIN, [])).toBe(false);
    });
  });

  it("rejects bogus roles without throwing", () => {
    expect(
      roleHasPermission("BOGUS" as UserRole, Permission.ORDER_CREATE),
    ).toBe(false);
  });
});
