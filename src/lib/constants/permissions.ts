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
   *  only by default, the page surfaces secrets and the webhook URL the
   *  operator must paste into their gateway dashboard. Treat as a financial
   *  permission, not a workspace-config one. */
  GATEWAY_VIEW: "gateway:view",
  GATEWAY_MANAGE: "gateway:manage",

  /** Pass 5e, per-tenant ItemType catalog. Listing is open to anyone
   *  who can create orders (the dynamic form picks an ItemType to
   *  render). Editing is admin-only because the attribute schema +
   *  email-block layout drive every order written against the type. */
  ITEM_TYPE_VIEW: "item_type:view",
  ITEM_TYPE_MANAGE: "item_type:manage",

  /** Pass 6c, per-tenant reusable product catalog (one row per SKU /
   *  service / rental asset). Listing is open to anyone who can create
   *  orders so the dynamic create-order form can offer "Pick from
   *  catalog". Editing is admin-only, the catalog is the source of
   *  truth for SKUs + base prices. */
  ITEM_VIEW: "item:view",
  ITEM_MANAGE: "item:manage",

  /** Per-tenant order workflow, list of statuses + transitions an order
   *  can move through. Viewing is admin-only (the workflow page surfaces
   *  every status key + transition spec); editing is admin-only too.
   *  Staff doesn't see it because we don't want operators casually
   *  reshaping order lifecycles. */
  WORKFLOW_VIEW: "workflow:view",
  WORKFLOW_MANAGE: "workflow:manage",

  /** Per-order accounting documents, invoices, receipts. Viewing is
   *  open to anyone who can see the order (staff for their own
   *  orders, admin for all); issuing is admin-only because the
   *  document carries the tenant's identity + a permanent number
   *  that can't be retracted. */
  DOCUMENT_VIEW: "document:view",
  DOCUMENT_ISSUE: "document:issue",

  /** Client Profiles (the permanent per-customer record). Viewing is open
   *  to anyone who works orders (staff need the customer's history to do
   *  their job); managing (editing company/notes/tags) is admin-only since
   *  the profile is the tenant's system of record for that relationship. */
  CUSTOMER_VIEW: "customer:view",
  CUSTOMER_MANAGE: "customer:manage",

  /** Files & Links — the contextual resource record hanging off a client
   *  (and, optionally, one of their orders). Viewing rides with
   *  CUSTOMER_VIEW's audience: anyone working a client's orders needs the
   *  proposal and the Drive folder to do the job. Managing is a normal
   *  operational capability, NOT an owner-only one — a member who can
   *  create an order can attach the contract to it. */
  CLIENT_FILE_VIEW: "client_file:view",
  CLIENT_FILE_MANAGE: "client_file:manage",
  CLIENT_LINK_VIEW: "client_link:view",
  CLIENT_LINK_MANAGE: "client_link:manage",
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
  // Staff can see documents already issued against an order they
  // own (so they can forward a receipt to a customer). Issuance is
  // admin-only, see ADMIN_ONLY_PERMISSIONS.
  Permission.DOCUMENT_VIEW,
  // Agents need to see whether the customer they're chasing has already
  // acknowledged the request, gates the "ready to charge" call.
  Permission.CONSENT_VIEW,
  // Staff work orders against clients, so they can open a Client Profile
  // to see that customer's history. Editing the profile is admin-only.
  Permission.CUSTOMER_VIEW,
  // Files & Links are day-one workflow, not administration: staff attach
  // the signed contract and paste the Drive folder as part of doing the
  // work. Withholding these would push the exact behaviour this feature
  // exists to end — sharing through WhatsApp and losing the thread.
  Permission.CLIENT_FILE_VIEW,
  Permission.CLIENT_FILE_MANAGE,
  Permission.CLIENT_LINK_VIEW,
  Permission.CLIENT_LINK_MANAGE,
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
  Permission.WORKFLOW_VIEW,
  Permission.WORKFLOW_MANAGE,
  Permission.DOCUMENT_ISSUE,
  Permission.EMAIL_TEMPLATE_VIEW,
  Permission.EMAIL_TEMPLATE_MANAGE,
  // Editing a Client Profile (company / notes / tags). Admin-only because
  // the profile is the tenant's canonical record of the relationship.
  Permission.CUSTOMER_MANAGE,
  Permission.AUDIT_VIEW,
  // AUDIT_DELETE intentionally NOT granted to ADMIN, the audit table
  // is the dispute-defense system of record. Only SUPER_ADMIN can issue
  // a destructive operation against it (and the route asks for a reason
  // for the audit trail before the wipe).
  // Verifying a consent record locks it for dispute evidence, admin-only
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

/* ─── Workspace roles: OWNER / MEMBER (private-beta model) ──────────────────
 *
 * Product-level roles: the workspace OWNER has complete control; everyone
 * else is a MEMBER who operates client work. This maps onto the existing
 * per-org `OrgMember.role` (SUPER_ADMIN = OWNER; ADMIN/STAFF = MEMBER) so we
 * don't rewrite the whole RBAC layer during the beta.
 *
 *   "Members operate the workspace. Owners control the workspace."
 */

export type WorkspaceRole = "OWNER" | "MEMBER";

export function toWorkspaceRole(role: UserRole): WorkspaceRole {
  return role === UserRole.SUPER_ADMIN ? "OWNER" : "MEMBER";
}

/**
 * Permissions a MEMBER may NEVER hold — even with "Full Permissions". These
 * are destructive, financial-administration, integration, workspace-control,
 * and security capabilities reserved for the Owner. Enforced as a hard
 * subtraction at the end of `resolveEffectivePermissions`, so a bug in the
 * allow-list can never accidentally grant one to a member.
 */
export const MEMBER_RESTRICTED_PERMISSIONS: ReadonlySet<Permission> = new Set([
  // Destructive
  Permission.ORDER_DELETE,
  Permission.ORDER_ARCHIVE,
  Permission.AUDIT_DELETE,
  // Stripe / gateway integration + credentials
  Permission.GATEWAY_VIEW,
  Permission.GATEWAY_MANAGE,
  // Workspace / global configuration
  Permission.SETTINGS_VIEW,
  Permission.SETTINGS_UPDATE,
  Permission.BRANDING_VIEW,
  Permission.BRANDING_MANAGE,
  Permission.WORKFLOW_VIEW,
  Permission.WORKFLOW_MANAGE,
  Permission.ITEM_TYPE_MANAGE,
  Permission.ITEM_MANAGE,
  Permission.EMAIL_TEMPLATE_MANAGE,
  // Team management
  Permission.USER_VIEW,
  Permission.USER_CREATE,
  Permission.USER_UPDATE,
  Permission.USER_DISABLE,
  Permission.USER_RESET_PASSWORD,
  // Workspace-wide financials + sensitive evidence
  Permission.ANALYTICS_VIEW,
  Permission.AUDIT_VIEW,
  Permission.EVIDENCE_VIEW,
  Permission.EVIDENCE_EXPORT,
  // Locking a consent record for dispute evidence (owner-level)
  Permission.CONSENT_VERIFY,
]);

/**
 * The full operational permission set a MEMBER may hold ("Full Permissions"):
 * everything needed to run day-to-day client work, disjoint from the
 * restricted set above. Members with mode="custom" get a subset of THIS.
 */
export const MEMBER_FULL_PERMISSIONS: readonly Permission[] = [
  Permission.CUSTOMER_VIEW,
  Permission.CUSTOMER_MANAGE, // create/edit clients + notes
  Permission.ORDER_VIEW_OWN,
  Permission.ORDER_VIEW_ALL, // see all clients' invoices/payments
  Permission.ORDER_CREATE,
  Permission.ORDER_UPDATE, // edit draft invoices
  Permission.ORDER_REGENERATE_LINK,
  Permission.CONSENT_VIEW, // view consent records + send requests
  Permission.DOCUMENT_VIEW,
  Permission.DOCUMENT_ISSUE, // issue invoices/receipts
  Permission.ITEM_TYPE_VIEW,
  Permission.ITEM_VIEW,
  Permission.EMAIL_TEMPLATE_VIEW, // pick a template to send
  Permission.CLIENT_FILE_VIEW,
  Permission.CLIENT_FILE_MANAGE, // attach + share client documents
  Permission.CLIENT_LINK_VIEW,
  Permission.CLIENT_LINK_MANAGE, // record external resources
];

/** The member-eligible allow-list as a Set. Exported so backend writers
 *  (e.g. the Team & Permissions editor) can intersect incoming custom
 *  grants against it before persisting — the same allow-list
 *  `resolveEffectivePermissions` applies on read. */
export const MEMBER_FULL_SET: ReadonlySet<Permission> = new Set(
  MEMBER_FULL_PERMISSIONS,
);

/** True when `p` is a permission an OWNER may grant a MEMBER via custom
 *  mode. Restricted permissions are disjoint from this set by design, so
 *  this doubles as the "never grantable to a member" guard. */
export function isMemberEligiblePermission(p: string): p is Permission {
  return MEMBER_FULL_SET.has(p as Permission);
}

export type MemberPermissionMode = "full" | "custom";

/**
 * Resolve a member's EFFECTIVE permission set for a workspace.
 *
 *   OWNER              → every permission (full workspace control).
 *   MEMBER + "full"    → MEMBER_FULL_PERMISSIONS.
 *   MEMBER + "custom"  → the member's granted permissions ∩ MEMBER_FULL.
 *
 * In every member case the restricted set is subtracted last, so a member
 * can never end up with a destructive/admin/integration/security capability
 * no matter what was stored. This is the single source of truth the session
 * guard consults for authorization.
 */
export function resolveEffectivePermissions(args: {
  role: UserRole;
  permissionMode?: MemberPermissionMode | null;
  customGrants?: readonly string[] | null;
}): ReadonlySet<Permission> {
  if (toWorkspaceRole(args.role) === "OWNER") {
    return RolePermissions.SUPER_ADMIN; // owner = complete control
  }
  const base: Iterable<Permission> =
    args.permissionMode === "custom"
      ? (args.customGrants ?? []).filter((p): p is Permission =>
          MEMBER_FULL_SET.has(p as Permission),
        )
      : MEMBER_FULL_PERMISSIONS;
  const effective = new Set<Permission>();
  for (const p of base) {
    if (!MEMBER_RESTRICTED_PERMISSIONS.has(p)) effective.add(p);
  }
  return effective;
}
