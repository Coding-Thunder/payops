import { describe, expect, it } from "vitest";

import { UserRole } from "@/lib/constants/enums";
import {
  MEMBER_FULL_PERMISSIONS,
  MEMBER_RESTRICTED_PERMISSIONS,
  Permission,
  resolveEffectivePermissions,
  roleHasAnyPermission,
  roleHasPermission,
  toWorkspaceRole,
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

/**
 * OWNER/MEMBER effective-permission resolver — the private-beta authorization
 * source of truth. A bug here is privilege escalation or a lockout.
 */
describe("workspace roles (OWNER/MEMBER)", () => {
  it("maps SUPER_ADMIN → OWNER, everyone else → MEMBER", () => {
    expect(toWorkspaceRole(UserRole.SUPER_ADMIN)).toBe("OWNER");
    expect(toWorkspaceRole(UserRole.ADMIN)).toBe("MEMBER");
    expect(toWorkspaceRole(UserRole.STAFF)).toBe("MEMBER");
  });

  it("MEMBER_FULL and MEMBER_RESTRICTED are disjoint", () => {
    for (const p of MEMBER_FULL_PERMISSIONS) {
      expect(MEMBER_RESTRICTED_PERMISSIONS.has(p)).toBe(false);
    }
  });

  it("OWNER gets every permission", () => {
    const eff = resolveEffectivePermissions({ role: UserRole.SUPER_ADMIN });
    for (const p of Object.values(Permission)) expect(eff.has(p)).toBe(true);
  });

  it("MEMBER + full = operational set, none restricted", () => {
    const eff = resolveEffectivePermissions({
      role: UserRole.STAFF,
      permissionMode: "full",
    });
    expect(eff.has(Permission.CUSTOMER_MANAGE)).toBe(true);
    expect(eff.has(Permission.ORDER_CREATE)).toBe(true);
    expect(eff.has(Permission.ORDER_VIEW_ALL)).toBe(true);
    expect(eff.has(Permission.ORDER_DELETE)).toBe(false);
    expect(eff.has(Permission.SETTINGS_UPDATE)).toBe(false);
    expect(eff.has(Permission.GATEWAY_MANAGE)).toBe(false);
    expect(eff.has(Permission.USER_CREATE)).toBe(false);
    expect(eff.has(Permission.ANALYTICS_VIEW)).toBe(false);
  });

  it("MEMBER + custom grants only the selected allowed permissions", () => {
    const eff = resolveEffectivePermissions({
      role: UserRole.STAFF,
      permissionMode: "custom",
      customGrants: [Permission.CUSTOMER_VIEW, Permission.ORDER_VIEW_OWN],
    });
    expect(eff.has(Permission.CUSTOMER_VIEW)).toBe(true);
    expect(eff.has(Permission.ORDER_VIEW_OWN)).toBe(true);
    expect(eff.has(Permission.CUSTOMER_MANAGE)).toBe(false);
    expect(eff.has(Permission.ORDER_CREATE)).toBe(false);
  });

  it("a custom grant can NEVER include a restricted permission", () => {
    const eff = resolveEffectivePermissions({
      role: UserRole.STAFF,
      permissionMode: "custom",
      customGrants: [
        Permission.CUSTOMER_VIEW,
        Permission.SETTINGS_UPDATE,
        Permission.GATEWAY_MANAGE,
        Permission.ORDER_DELETE,
      ],
    });
    expect(eff.has(Permission.CUSTOMER_VIEW)).toBe(true);
    expect(eff.has(Permission.SETTINGS_UPDATE)).toBe(false);
    expect(eff.has(Permission.GATEWAY_MANAGE)).toBe(false);
    expect(eff.has(Permission.ORDER_DELETE)).toBe(false);
  });

  it("a custom grant outside the member-allowed set is ignored", () => {
    const eff = resolveEffectivePermissions({
      role: UserRole.STAFF,
      permissionMode: "custom",
      customGrants: [Permission.ANALYTICS_VIEW, Permission.AUDIT_VIEW],
    });
    expect(eff.size).toBe(0);
  });

  it("an ADMIN member is bounded by the member set, not the old ADMIN role", () => {
    const eff = resolveEffectivePermissions({
      role: UserRole.ADMIN,
      permissionMode: "full",
    });
    expect(eff.has(Permission.SETTINGS_UPDATE)).toBe(false);
    expect(eff.has(Permission.USER_CREATE)).toBe(false);
    expect(eff.has(Permission.CUSTOMER_MANAGE)).toBe(true);
  });
});
