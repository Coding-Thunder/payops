import { MEMBER_FULL_PERMISSIONS, Permission } from "./permissions";

/**
 * Presentational grouping of the member-grantable permissions. Shared by the
 * OWNER's editor (ManagePermissionsDialog) and the MEMBER's read-only "My
 * Access" view so the two can never drift. The SOURCE OF TRUTH for what is
 * grantable is still MEMBER_FULL_PERMISSIONS — `memberPermissionGroups()`
 * guarantees the returned groups are exhaustive over it (any newly-added
 * grantable key that isn't placed in a named group lands in "More"), and a
 * restricted permission can never appear because it isn't in the source list.
 */
export interface PermissionGroup {
  label: string;
  permissions: Permission[];
}

const BASE_GROUPS: ReadonlyArray<PermissionGroup> = [
  {
    label: "Clients",
    permissions: [Permission.CUSTOMER_VIEW, Permission.CUSTOMER_MANAGE],
  },
  {
    label: "Orders & payments",
    permissions: [
      Permission.ORDER_VIEW_OWN,
      Permission.ORDER_VIEW_ALL,
      Permission.ORDER_CREATE,
      Permission.ORDER_UPDATE,
      Permission.ORDER_REGENERATE_LINK,
    ],
  },
  {
    label: "Consent & documents",
    permissions: [
      Permission.CONSENT_VIEW,
      Permission.DOCUMENT_VIEW,
      Permission.DOCUMENT_ISSUE,
    ],
  },
  {
    label: "Catalog",
    permissions: [Permission.ITEM_TYPE_VIEW, Permission.ITEM_VIEW],
  },
  { label: "Email", permissions: [Permission.EMAIL_TEMPLATE_VIEW] },
];

export function memberPermissionGroups(): PermissionGroup[] {
  const placed = new Set(BASE_GROUPS.flatMap((g) => g.permissions));
  const leftover = MEMBER_FULL_PERMISSIONS.filter((p) => !placed.has(p));
  return leftover.length > 0
    ? [...BASE_GROUPS.map((g) => ({ ...g })), { label: "More", permissions: [...leftover] }]
    : BASE_GROUPS.map((g) => ({ ...g }));
}
