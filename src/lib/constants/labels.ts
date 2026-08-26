import {
  ConsentMethod,
  ConsentMode,
  ConsentStatus,
  OrderEvidenceActorType,
  OrderEvidenceEventType,
  OrderStatus,
  PaymentGatewayKey,
  RecordState,
  UserRole,
} from "./enums";
import { Permission, type WorkspaceRole } from "./permissions";

// Pass 5h: `BookingTypeLabel` removed alongside the BookingType enum.

export const OrderStatusLabel: Record<OrderStatus, string> = {
  NOT_INITIATED: "Draft",
  LINK_GENERATED: "Link ready",
  PAYMENT_PENDING: "Payment pending",
  PAID: "Paid",
  FAILED: "Failed",
  EXPIRED: "Expired",
};

export const RecordStateLabel: Record<RecordState, string> = {
  ACTIVE: "Active",
  ARCHIVED: "Archived",
  DISABLED: "Disabled",
};

export const UserRoleLabel: Record<UserRole, string> = {
  SUPER_ADMIN: "Super admin",
  ADMIN: "Admin",
  STAFF: "Staff",
};

/**
 * Two-role product view: OWNER controls the workspace, MEMBER operates it.
 * Used by the Team & Permissions and My Account surfaces (never surface the
 * underlying UserRole to workspace operators).
 */
export const WorkspaceRoleLabel: Record<WorkspaceRole, string> = {
  OWNER: "Owner",
  MEMBER: "Member",
};

/**
 * Human labels for the permissions an OWNER may grant a MEMBER (the
 * member-eligible set only — restricted/owner permissions are never shown
 * as grantable). Member-facing copy, not the raw enum key. Keep in sync
 * with MEMBER_FULL_PERMISSIONS.
 */
export const PermissionLabel: Partial<Record<Permission, string>> = {
  [Permission.CUSTOMER_VIEW]: "View client profiles",
  [Permission.CUSTOMER_MANAGE]: "Create & edit clients",
  [Permission.ORDER_VIEW_OWN]: "View own orders",
  [Permission.ORDER_VIEW_ALL]: "View all orders, invoices & payments",
  [Permission.ORDER_CREATE]: "Create orders",
  [Permission.ORDER_UPDATE]: "Edit draft orders & invoices",
  [Permission.ORDER_REGENERATE_LINK]: "Regenerate payment links",
  [Permission.CONSENT_VIEW]: "View consent records & send requests",
  [Permission.DOCUMENT_VIEW]: "View invoices & receipts",
  [Permission.DOCUMENT_ISSUE]: "Issue invoices & receipts",
  [Permission.ITEM_TYPE_VIEW]: "View item types",
  [Permission.ITEM_VIEW]: "View product catalog",
  [Permission.EMAIL_TEMPLATE_VIEW]: "View & pick email templates",
};

/** One-line clarifier under each grantable permission in the editor. */
export const PermissionDescription: Partial<Record<Permission, string>> = {
  [Permission.CUSTOMER_MANAGE]: "Company, notes and tags on a client record",
  [Permission.ORDER_VIEW_ALL]: "Not just the ones they created",
  [Permission.ORDER_UPDATE]: "Before a payment link is generated",
  [Permission.DOCUMENT_ISSUE]: "Carries the workspace's identity + a permanent number",
};

export const OrderStatusBadgeVariant: Record<
  OrderStatus,
  "warning" | "success" | "destructive" | "muted" | "info"
> = {
  NOT_INITIATED: "muted",
  LINK_GENERATED: "info",
  PAYMENT_PENDING: "warning",
  PAID: "success",
  FAILED: "destructive",
  EXPIRED: "muted",
};

export const PaymentGatewayLabel: Record<PaymentGatewayKey, string> = {
  STRIPE: "Stripe",
  RAZORPAY: "Razorpay",
  AUTHORIZE_NET: "Authorize.net",
  PAYPAL: "PayPal",
  MANUAL: "Manual invoice",
};

export const RecordStateBadgeVariant: Record<
  RecordState,
  "success" | "muted" | "destructive"
> = {
  ACTIVE: "success",
  ARCHIVED: "muted",
  DISABLED: "destructive",
};

export const UserRoleBadgeVariant: Record<
  UserRole,
  "default" | "info" | "secondary"
> = {
  SUPER_ADMIN: "default",
  ADMIN: "info",
  STAFF: "secondary",
};

export const ConsentStatusLabel: Record<ConsentStatus, string> = {
  NOT_REQUESTED: "Not requested",
  REQUESTED: "Awaiting consent",
  RECEIVED: "Consent received",
  VERIFIED: "Verified",
};

export const ConsentStatusBadgeVariant: Record<
  ConsentStatus,
  "muted" | "warning" | "info" | "success"
> = {
  NOT_REQUESTED: "muted",
  REQUESTED: "warning",
  RECEIVED: "info",
  VERIFIED: "success",
};

export const ConsentMethodLabel: Record<ConsentMethod, string> = {
  HOSTED_PAGE: "Hosted page",
  MAILTO_REPLY: "Email reply",
  MANUAL: "Manual entry",
};

export const ConsentModeLabel: Record<ConsentMode, string> = {
  ADVISORY: "Advisory",
  RECOMMENDED: "Recommended",
  REQUIRED: "Required",
};

export const OrderEvidenceEventLabel: Record<OrderEvidenceEventType, string> = {
  ORDER_CREATED: "Order created",
  DRAFT_SAVED: "Draft saved",
  GATEWAY_SELECTED: "Payment gateway selected",
  PAYMENT_LINK_GENERATED: "Payment link generated",
  PAYMENT_LINK_REGENERATED: "Payment link regenerated",
  PAYMENT_REQUEST_EMAIL_SENT: "Payment request email sent",
  CLIENT_MESSAGE_SENT: "Message sent to client",
  CONSENT_REQUESTED: "Consent requested",
  CONSENT_RECEIVED: "Consent received",
  CONSENT_VERIFIED: "Consent verified",
  PAYMENT_STARTED: "Payment started",
  PAYMENT_COMPLETED: "Payment completed",
  CONFIRMATION_EMAIL_SENT: "Confirmation email sent",
  PAYMENT_FAILED: "Payment failed",
  PAYMENT_EXPIRED: "Payment expired",
  REFUND_ISSUED: "Refund issued",
  ORDER_CANCELLED: "Order cancelled",
};

export const OrderEvidenceActorLabel: Record<OrderEvidenceActorType, string> = {
  AGENT: "Agent",
  CUSTOMER: "Customer",
  SYSTEM: "System",
  GATEWAY: "Payment gateway",
};
