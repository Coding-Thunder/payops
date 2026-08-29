import {
  BookingStatus,
  BookingType,
  CaptureMode,
  ConsentMethod,
  ConsentMode,
  ConsentStatus,
  OrderEvidenceActorType,
  OrderEvidenceEventType,
  OrderStatus,
  PaymentCaptureStatus,
  PaymentGatewayKey,
  PaymentTiming,
  RecordState,
  ServiceType,
  UserRole,
} from "./enums";

export const BookingTypeLabel: Record<BookingType, string> = {
  NEW_BOOKING: "New booking",
  MODIFICATION: "Modification",
  CANCELLATION_CHARGE: "Cancellation charge",
};

export const PaymentTimingLabel: Record<PaymentTiming, string> = {
  PREPAID: "Prepaid",
  DUE_AT_COUNTER: "Due at counter",
};

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
  CONSENT_REQUESTED: "Consent requested",
  CONSENT_RECEIVED: "Consent received",
  CONSENT_VERIFIED: "Consent verified",
  PAYMENT_STARTED: "Payment started",
  PAYMENT_AUTHORIZED: "Payment authorized",
  PAYMENT_COMPLETED: "Payment completed",
  PAYMENT_CAPTURED: "Payment captured",
  PAYMENT_CAPTURE_FAILED: "Payment capture failed",
  AUTHORIZATION_RELEASED: "Authorization released",
  BOOKING_CONFIRMED: "Booking confirmed",
  BOOKING_CANCELLED: "Booking cancelled",
  CONFIRMATION_EMAIL_SENT: "Confirmation email sent",
  TERMS_ACKNOWLEDGED: "Terms acknowledged",
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

/**
 * Customer-facing noun for each service type. Used in operator lists and
 * in the service-aware email/checkout copy helpers.
 */
export const ServiceTypeLabel: Record<ServiceType, string> = {
  CAR_RENTAL: "Car rental",
  FLIGHT: "Flight",
  HOTEL: "Hotel",
};

/** Column header for the "what was bought" cell, per service type. */
export const ServiceItemLabel: Record<ServiceType, string> = {
  CAR_RENTAL: "Vehicle",
  FLIGHT: "Route",
  HOTEL: "Property",
};

export const BookingStatusLabel: Record<BookingStatus, string> = {
  PENDING: "Awaiting confirmation",
  CONFIRMED: "Confirmed",
  CANCELLED: "Cancelled",
};

export const BookingStatusBadgeVariant: Record<
  BookingStatus,
  "warning" | "success" | "destructive" | "muted" | "info"
> = {
  PENDING: "warning",
  CONFIRMED: "success",
  CANCELLED: "destructive",
};

export const CaptureModeLabel: Record<CaptureMode, string> = {
  AUTOMATIC: "Charge at checkout",
  MANUAL: "Authorize, capture on confirmation",
};

export const PaymentCaptureStatusLabel: Record<PaymentCaptureStatus, string> = {
  PENDING_AUTHORIZATION: "Awaiting authorization",
  AUTHORIZED: "Authorized — not yet charged",
  CAPTURE_PENDING: "Capture in progress",
  CAPTURED: "Captured",
  CANCELLED: "Authorization released",
  CAPTURE_FAILED: "Capture failed",
  AUTHORIZATION_EXPIRED: "Authorization expired",
};

export const PaymentCaptureStatusBadgeVariant: Record<
  PaymentCaptureStatus,
  "warning" | "success" | "destructive" | "muted" | "info"
> = {
  PENDING_AUTHORIZATION: "muted",
  AUTHORIZED: "info",
  CAPTURE_PENDING: "warning",
  CAPTURED: "success",
  CANCELLED: "muted",
  CAPTURE_FAILED: "destructive",
  AUTHORIZATION_EXPIRED: "muted",
};
