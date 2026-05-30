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
  ORDER_DELETE: "order:delete",
  ORDER_REGENERATE_LINK: "order:regenerate_link",

  ANALYTICS_VIEW: "analytics:view",
  SETTINGS_VIEW: "settings:view",
  SETTINGS_UPDATE: "settings:update",

  BRANDING_VIEW: "branding:view",
  BRANDING_MANAGE: "branding:manage",

  EMAIL_TEMPLATE_VIEW: "email_template:view",
  EMAIL_TEMPLATE_MANAGE: "email_template:manage",

  AUDIT_VIEW: "audit:view",
  AUDIT_DELETE: "audit:delete",

  CONSENT_VIEW: "consent:view",
  CONSENT_VERIFY: "consent:verify",

  EVIDENCE_VIEW: "evidence:view",
  EVIDENCE_EXPORT: "evidence:export",

  /** Per-org payment-gateway credentials (Stripe/Razorpay/etc). SUPER_ADMIN
   *  only by default — the page surfaces secrets and the webhook URL the
   *  operator must paste into their gateway dashboard. Treat as a financial
   *  permission, not a workspace-config one. */
  GATEWAY_VIEW: "gateway:view",
  GATEWAY_MANAGE: "gateway:manage",

  /** Pass 5e — per-tenant ItemType catalog. Listing is open to anyone
   *  who can create orders (the dynamic form picks an ItemType to
   *  render). Editing is admin-only because the attribute schema +
   *  email-block layout drive every order written against the type. */
  ITEM_TYPE_VIEW: "item_type:view",
  ITEM_TYPE_MANAGE: "item_type:manage",

  /** Pass 6c — per-tenant reusable product catalog (one row per SKU /
   *  service / rental asset). Listing is open to anyone who can create
   *  orders so the dynamic create-order form can offer "Pick from
   *  catalog". Editing is admin-only — the catalog is the source of
   *  truth for SKUs + base prices. */
  ITEM_VIEW: "item:view",
  ITEM_MANAGE: "item:manage",
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
  // Dynamic create-order form must list this tenant's ItemTypes
  // to render the right attribute inputs. View-only for staff.
  Permission.ITEM_TYPE_VIEW,
  // Same flow needs the product catalog to render the "Pick from
  // catalog" affordance. View-only for staff; admin owns the catalog.
  Permission.ITEM_VIEW,
  // Agents need to see whether the customer they're chasing has already
  // acknowledged the request — gates the "ready to charge" call.
  Permission.CONSENT_VIEW,
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
  Permission.ORDER_DELETE,
  Permission.ANALYTICS_VIEW,
  Permission.SETTINGS_VIEW,
  Permission.SETTINGS_UPDATE,
  Permission.BRANDING_VIEW,
  Permission.BRANDING_MANAGE,
  Permission.ITEM_TYPE_MANAGE,
  Permission.ITEM_MANAGE,
  Permission.EMAIL_TEMPLATE_VIEW,
  Permission.EMAIL_TEMPLATE_MANAGE,
  Permission.AUDIT_VIEW,
  // AUDIT_DELETE intentionally NOT granted to ADMIN — the audit table
  // is the dispute-defense system of record. Only SUPER_ADMIN can issue
  // a destructive operation against it (and the route asks for a reason
  // for the audit trail before the wipe).
  // Verifying a consent record locks it for dispute evidence — admin-only
  // so staff can't backdate or rubber-stamp records they collected.
  Permission.CONSENT_VERIFY,
  // The evidence chain page surfaces full email HTML, IP/UA/signature of
  // the consenter, gateway refs, and per-event hashes. Restricted to the
  // dispute team so customer-facing staff never see other customers'
  // signed documents.
  Permission.EVIDENCE_VIEW,
  Permission.EVIDENCE_EXPORT,
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
