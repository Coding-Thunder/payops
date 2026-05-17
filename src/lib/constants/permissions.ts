import { UserRole } from "./enums";

/**
 * Permission registry. All authorization checks go through this map.
 * Never sprinkle role string comparisons across the codebase.
 */
export const Permission = {
  USER_VIEW: "user:view",
  USER_CREATE: "user:create",
  USER_UPDATE: "user:update",
  USER_DISABLE: "user:disable",
  USER_RESET_PASSWORD: "user:reset_password",

  ORDER_VIEW_OWN: "order:view_own",
  ORDER_VIEW_ALL: "order:view_all",
  ORDER_CREATE: "order:create",
  ORDER_UPDATE: "order:update",
  ORDER_ARCHIVE: "order:archive",
  ORDER_REGENERATE_LINK: "order:regenerate_link",

  ANALYTICS_VIEW: "analytics:view",
  SETTINGS_VIEW: "settings:view",
  SETTINGS_UPDATE: "settings:update",

  AUDIT_VIEW: "audit:view",
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

/**
 * Permissions are layered: ADMIN inherits everything STAFF can do, and
 * SUPER_ADMIN inherits everything ADMIN can do. This guarantees that any
 * route guarded by a staff permission is automatically accessible to
 * higher roles - useful when an admin needs to step in and work an order
 * during high-load or emergencies.
 */
const STAFF_PERMISSIONS: readonly Permission[] = [
  Permission.ORDER_VIEW_OWN,
  Permission.ORDER_CREATE,
  Permission.ORDER_REGENERATE_LINK,
];

const ADMIN_ONLY_PERMISSIONS: readonly Permission[] = [
  Permission.USER_VIEW,
  Permission.USER_CREATE,
  Permission.USER_UPDATE,
  Permission.USER_DISABLE,
  Permission.USER_RESET_PASSWORD,
  Permission.ORDER_VIEW_ALL,
  Permission.ORDER_UPDATE,
  Permission.ORDER_ARCHIVE,
  Permission.ANALYTICS_VIEW,
  Permission.SETTINGS_VIEW,
  Permission.SETTINGS_UPDATE,
  Permission.AUDIT_VIEW,
];

/** Role → permissions matrix. Single source of truth. */
export const RolePermissions: Record<UserRole, ReadonlySet<Permission>> = {
  STAFF: new Set<Permission>(STAFF_PERMISSIONS),
  ADMIN: new Set<Permission>([...STAFF_PERMISSIONS, ...ADMIN_ONLY_PERMISSIONS]),
  SUPER_ADMIN: new Set<Permission>(Object.values(Permission)),
};

export function roleHasPermission(
  role: UserRole,
  permission: Permission,
): boolean {
  return RolePermissions[role]?.has(permission) ?? false;
}

export function roleHasAnyPermission(
  role: UserRole,
  permissions: readonly Permission[],
): boolean {
  return permissions.some((p) => roleHasPermission(role, p));
}
