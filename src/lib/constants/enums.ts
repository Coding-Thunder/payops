/**
 * Central enum registry. Every status / type field in the system must be
 * sourced from here so we never end up with stringly-typed drift.
 */

export const UserRole = {
  SUPER_ADMIN: "SUPER_ADMIN",
  ADMIN: "ADMIN",
  STAFF: "STAFF",
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];
export const USER_ROLES = Object.values(UserRole) as UserRole[];

/** Lifecycle states for any user/order record (no hard delete on financial data). */
export const RecordState = {
  ACTIVE: "ACTIVE",
  ARCHIVED: "ARCHIVED",
  DISABLED: "DISABLED",
} as const;
export type RecordState = (typeof RecordState)[keyof typeof RecordState];
export const RECORD_STATES = Object.values(RecordState) as RecordState[];

export const BookingType = {
  NEW_BOOKING: "NEW_BOOKING",
  MODIFICATION: "MODIFICATION",
  CANCELLATION_CHARGE: "CANCELLATION_CHARGE",
} as const;
export type BookingType = (typeof BookingType)[keyof typeof BookingType];
export const BOOKING_TYPES = Object.values(BookingType) as BookingType[];

/**
 * WHAT the customer is buying. Orthogonal to `BookingType`, which is WHY
 * they are being charged (new booking / modification / cancellation fee).
 *
 * Added for the GlobeVista tenant, which sells flights and hotels alongside
 * car rental. CAR_RENTAL is the default on both the schema and the read
 * path so every order written before this enum existed — i.e. every
 * RentalConfirmation and TripReservations order — reads back as exactly
 * what it has always been. Nothing about those two brands changes.
 */
export const ServiceType = {
  CAR_RENTAL: "CAR_RENTAL",
  FLIGHT: "FLIGHT",
  HOTEL: "HOTEL",
} as const;
export type ServiceType = (typeof ServiceType)[keyof typeof ServiceType];
export const SERVICE_TYPES = Object.values(ServiceType) as ServiceType[];

/**
 * The BOOKING lifecycle, which is NOT the payment lifecycle.
 *
 * Under manual capture an operator confirms the booking with the supplier
 * and only then is the customer's card actually charged, so "we have the
 * money" and "the trip is confirmed" are genuinely different facts and are
 * stored in different fields. `OrderStatus` remains the payment field.
 *
 * NULL for every automatic-capture order — which is every order both
 * incumbent brands have ever created — so their documents and their UI are
 * untouched.
 */
export const BookingStatus = {
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  CANCELLED: "CANCELLED",
} as const;
export type BookingStatus = (typeof BookingStatus)[keyof typeof BookingStatus];
export const BOOKING_STATUSES = Object.values(BookingStatus) as BookingStatus[];

/**
 * Whether the gateway takes the money at checkout or merely places a hold.
 *
 * AUTOMATIC is the default everywhere and is what both incumbent brands run
 * on; it is also what an organization document with no stored value reads
 * back as. MANUAL is opt-in per organization.
 */
export const CaptureMode = {
  AUTOMATIC: "AUTOMATIC",
  MANUAL: "MANUAL",
} as const;
export type CaptureMode = (typeof CaptureMode)[keyof typeof CaptureMode];
export const CAPTURE_MODES = Object.values(CaptureMode) as CaptureMode[];

/**
 * State of the AUTHORIZATION on a manual-capture order. Deliberately a
 * separate enum from `OrderStatus` rather than six more values on it:
 * widening OrderStatus would change the meaning of `status: PAID` filters
 * in analytics, the archive guard, and the exhaustive label maps that both
 * incumbent brands depend on.
 *
 *  PENDING_AUTHORIZATION  link generated on a manual-capture order; the
 *                         customer has not authorized yet
 *  AUTHORIZED             hold placed, money not taken (Stripe requires_capture)
 *  CAPTURE_PENDING        capture call in flight — guards against double-capture
 *  CAPTURED               money taken; the order also becomes PAID
 *  CANCELLED              hold deliberately released by an operator
 *  CAPTURE_FAILED         capture attempt rejected; the hold may still stand
 *  AUTHORIZATION_EXPIRED  gateway released the hold on its own (~7 days)
 */
export const PaymentCaptureStatus = {
  PENDING_AUTHORIZATION: "PENDING_AUTHORIZATION",
  AUTHORIZED: "AUTHORIZED",
  CAPTURE_PENDING: "CAPTURE_PENDING",
  CAPTURED: "CAPTURED",
  CANCELLED: "CANCELLED",
  CAPTURE_FAILED: "CAPTURE_FAILED",
  AUTHORIZATION_EXPIRED: "AUTHORIZATION_EXPIRED",
} as const;
export type PaymentCaptureStatus =
  (typeof PaymentCaptureStatus)[keyof typeof PaymentCaptureStatus];
export const PAYMENT_CAPTURE_STATUSES = Object.values(
  PaymentCaptureStatus,
) as PaymentCaptureStatus[];

/**
 * When a single charge line is collected from the customer.
 *
 *  PREPAID        — collected now, online, via the initial payment link.
 *                   The sum of PREPAID charges is the ONLY amount the
 *                   gateway (Stripe) is ever asked to charge.
 *  DUE_AT_COUNTER — collected by the rental counter at pick-up. Shown to
 *                   the customer for transparency but never sent to the
 *                   gateway and never part of our recognised online revenue.
 *
 * Rental-specific today; isolated here so it can later move into per-tenant
 * configuration without touching the platform core.
 */
export const PaymentTiming = {
  PREPAID: "PREPAID",
  DUE_AT_COUNTER: "DUE_AT_COUNTER",
} as const;
export type PaymentTiming = (typeof PaymentTiming)[keyof typeof PaymentTiming];
export const PAYMENT_TIMINGS = Object.values(PaymentTiming) as PaymentTiming[];

export const OrderStatus = {
  /** Order has been created but no payment session exists yet. Default
   *  state for new orders — no gateway has been called, the order is
   *  editable, no payment side-effects. */
  NOT_INITIATED: "NOT_INITIATED",
  /** Gateway session created, payment URL persisted. The agent has
   *  generated the link but the payment-request email has NOT been
   *  sent yet. The customer can't reach this state on their own. */
  LINK_GENERATED: "LINK_GENERATED",
  /** Email sent — customer can now click through to checkout. Payment
   *  is in flight. */
  PAYMENT_PENDING: "PAYMENT_PENDING",
  PAID: "PAID",
  FAILED: "FAILED",
  EXPIRED: "EXPIRED",
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];
export const ORDER_STATUSES = Object.values(OrderStatus) as OrderStatus[];

export const PaymentProcessor = {
  STRIPE: "STRIPE",
} as const;
export type PaymentProcessor =
  (typeof PaymentProcessor)[keyof typeof PaymentProcessor];

/**
 * Provider-agnostic payment-gateway enum. Order records persist the
 * gateway they're paying through so the orchestration layer can route
 * webhook / reconcile / regenerate calls to the right implementation.
 *
 * Stripe is the only gateway that's actually live today; the rest are
 * future-ready placeholders so the admin UI + persistence schema can
 * be ready without speculative code in the hot path.
 */
export const PaymentGatewayKey = {
  STRIPE: "STRIPE",
  RAZORPAY: "RAZORPAY",
  AUTHORIZE_NET: "AUTHORIZE_NET",
  PAYPAL: "PAYPAL",
  MANUAL: "MANUAL",
} as const;
export type PaymentGatewayKey =
  (typeof PaymentGatewayKey)[keyof typeof PaymentGatewayKey];
export const PAYMENT_GATEWAY_KEYS = Object.values(
  PaymentGatewayKey,
) as PaymentGatewayKey[];

export const AuditAction = {
  USER_LOGIN: "USER_LOGIN",
  USER_LOGOUT: "USER_LOGOUT",
  USER_LOGIN_FAILED: "USER_LOGIN_FAILED",
  USER_CREATED: "USER_CREATED",
  USER_UPDATED: "USER_UPDATED",
  USER_ROLE_CHANGED: "USER_ROLE_CHANGED",
  USER_PASSWORD_RESET: "USER_PASSWORD_RESET",
  USER_DISABLED: "USER_DISABLED",
  USER_ARCHIVED: "USER_ARCHIVED",
  USER_REACTIVATED: "USER_REACTIVATED",

  ORDER_CREATED: "ORDER_CREATED",
  ORDER_UPDATED: "ORDER_UPDATED",
  ORDER_ARCHIVED: "ORDER_ARCHIVED",
  ORDER_DELETED: "ORDER_DELETED",
  ORDER_PAYMENT_LINK_REGENERATED: "ORDER_PAYMENT_LINK_REGENERATED",

  PAYMENT_SUCCEEDED: "PAYMENT_SUCCEEDED",
  PAYMENT_AUTHORIZED: "PAYMENT_AUTHORIZED",
  PAYMENT_CAPTURED: "PAYMENT_CAPTURED",
  PAYMENT_CAPTURE_FAILED: "PAYMENT_CAPTURE_FAILED",
  AUTHORIZATION_RELEASED: "AUTHORIZATION_RELEASED",
  BOOKING_CONFIRMED: "BOOKING_CONFIRMED",
  BOOKING_CANCELLED: "BOOKING_CANCELLED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  PAYMENT_EXPIRED: "PAYMENT_EXPIRED",

  WEBHOOK_RECEIVED: "WEBHOOK_RECEIVED",
  WEBHOOK_DUPLICATE: "WEBHOOK_DUPLICATE",
  WEBHOOK_FAILED: "WEBHOOK_FAILED",

  EMAIL_SENT: "EMAIL_SENT",
  EMAIL_FAILED: "EMAIL_FAILED",

  SETTINGS_UPDATED: "SETTINGS_UPDATED",

  PROVIDER_CREATED: "PROVIDER_CREATED",
  PROVIDER_UPDATED: "PROVIDER_UPDATED",
  PROVIDER_STATUS_CHANGED: "PROVIDER_STATUS_CHANGED",
  PROVIDER_LOGO_REPLACED: "PROVIDER_LOGO_REPLACED",
  PROVIDER_ARCHIVED: "PROVIDER_ARCHIVED",

  BRANDING_UPDATED: "BRANDING_UPDATED",
  BRANDING_LOGO_REPLACED: "BRANDING_LOGO_REPLACED",

  CAR_LINK_CREATED: "CAR_LINK_CREATED",
  CAR_LINK_UPDATED: "CAR_LINK_UPDATED",
  CAR_LINK_DEACTIVATED: "CAR_LINK_DEACTIVATED",
  CAR_LINK_RESTORED: "CAR_LINK_RESTORED",

  EMAIL_TEMPLATE_VERSION_CREATED: "EMAIL_TEMPLATE_VERSION_CREATED",
  EMAIL_TEMPLATE_VERSION_ACTIVATED: "EMAIL_TEMPLATE_VERSION_ACTIVATED",

  CONSENT_REQUESTED: "CONSENT_REQUESTED",
  CONSENT_RECEIVED: "CONSENT_RECEIVED",
  CONSENT_VERIFIED: "CONSENT_VERIFIED",
  CONSENT_REVOKED: "CONSENT_REVOKED",

  DISPUTE_CREATED: "DISPUTE_CREATED",
  DISPUTE_UPDATED: "DISPUTE_UPDATED",
  DISPUTE_CLOSED: "DISPUTE_CLOSED",
  DISPUTE_FUNDS_WITHDRAWN: "DISPUTE_FUNDS_WITHDRAWN",
  REFUND_CREATED: "REFUND_CREATED",

  AUDIT_LOG_DELETED: "AUDIT_LOG_DELETED",

  EVIDENCE_RECORDED: "EVIDENCE_RECORDED",
  EVIDENCE_RECORD_FAILED: "EVIDENCE_RECORD_FAILED",
  EVIDENCE_EXPORTED: "EVIDENCE_EXPORTED",
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export const AuditEntity = {
  USER: "USER",
  ORDER: "ORDER",
  PAYMENT: "PAYMENT",
  SETTINGS: "SETTINGS",
  WEBHOOK: "WEBHOOK",
  SYSTEM: "SYSTEM",
  PROVIDER: "PROVIDER",
  BRANDING: "BRANDING",
  CAR_LINK: "CAR_LINK",
  EMAIL_TEMPLATE: "EMAIL_TEMPLATE",
  CONSENT: "CONSENT",
  ORDER_EVIDENCE: "ORDER_EVIDENCE",
  DISPUTE: "DISPUTE",
} as const;
export type AuditEntity = (typeof AuditEntity)[keyof typeof AuditEntity];

/**
 * Per-order, append-only evidence chain. Each event captures one
 * dispute-relevant state change on the order so future chargebacks can
 * reconstruct the full lifecycle from a single surface. The enum is
 * superset of AuditAction: it includes finer-grained payment moments
 * (GATEWAY_SELECTED, PAYMENT_STARTED) and reserves slots for refunds /
 * cancellations the operations team will wire up later.
 */
export const OrderEvidenceEventType = {
  ORDER_CREATED: "ORDER_CREATED",
  DRAFT_SAVED: "DRAFT_SAVED",
  GATEWAY_SELECTED: "GATEWAY_SELECTED",
  PAYMENT_LINK_GENERATED: "PAYMENT_LINK_GENERATED",
  PAYMENT_LINK_REGENERATED: "PAYMENT_LINK_REGENERATED",
  PAYMENT_REQUEST_EMAIL_SENT: "PAYMENT_REQUEST_EMAIL_SENT",
  CONSENT_REQUESTED: "CONSENT_REQUESTED",
  CONSENT_RECEIVED: "CONSENT_RECEIVED",
  CONSENT_VERIFIED: "CONSENT_VERIFIED",
  PAYMENT_STARTED: "PAYMENT_STARTED",
  PAYMENT_AUTHORIZED: "PAYMENT_AUTHORIZED",
  PAYMENT_COMPLETED: "PAYMENT_COMPLETED",
  PAYMENT_CAPTURED: "PAYMENT_CAPTURED",
  PAYMENT_CAPTURE_FAILED: "PAYMENT_CAPTURE_FAILED",
  AUTHORIZATION_RELEASED: "AUTHORIZATION_RELEASED",
  BOOKING_CONFIRMED: "BOOKING_CONFIRMED",
  BOOKING_CANCELLED: "BOOKING_CANCELLED",
  CONFIRMATION_EMAIL_SENT: "CONFIRMATION_EMAIL_SENT",
  TERMS_ACKNOWLEDGED: "TERMS_ACKNOWLEDGED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  PAYMENT_EXPIRED: "PAYMENT_EXPIRED",
  REFUND_ISSUED: "REFUND_ISSUED",
  ORDER_CANCELLED: "ORDER_CANCELLED",
} as const;
export type OrderEvidenceEventType =
  (typeof OrderEvidenceEventType)[keyof typeof OrderEvidenceEventType];
export const ORDER_EVIDENCE_EVENT_TYPES = Object.values(
  OrderEvidenceEventType,
) as OrderEvidenceEventType[];

export const OrderEvidenceActorType = {
  AGENT: "AGENT",
  CUSTOMER: "CUSTOMER",
  SYSTEM: "SYSTEM",
  GATEWAY: "GATEWAY",
} as const;
export type OrderEvidenceActorType =
  (typeof OrderEvidenceActorType)[keyof typeof OrderEvidenceActorType];
export const ORDER_EVIDENCE_ACTOR_TYPES = Object.values(
  OrderEvidenceActorType,
) as OrderEvidenceActorType[];

export const EmailKind = {
  PAYMENT_CONFIRMATION: "PAYMENT_CONFIRMATION",
  PAYMENT_LINK: "PAYMENT_LINK",
  /** Manual-capture only: the card was authorized, not charged. Never
   *  enqueued for an automatic-capture order. */
  PAYMENT_AUTHORIZED: "PAYMENT_AUTHORIZED",
} as const;
export type EmailKind = (typeof EmailKind)[keyof typeof EmailKind];

/**
 * Lifecycle of the pre-payment customer acknowledgement.
 *
 *  NOT_REQUESTED — order exists but no consent has been asked for yet
 *  REQUESTED     — consent record created and an email/link was sent
 *  RECEIVED      — customer clicked through and confirmed (hosted page)
 *                  or replied via mailto fallback
 *  VERIFIED      — agent has reviewed the received consent and marked it
 *                  as a clean, dispute-grade record
 */
export const ConsentStatus = {
  NOT_REQUESTED: "NOT_REQUESTED",
  REQUESTED: "REQUESTED",
  RECEIVED: "RECEIVED",
  VERIFIED: "VERIFIED",
} as const;
export type ConsentStatus = (typeof ConsentStatus)[keyof typeof ConsentStatus];
export const CONSENT_STATUSES = Object.values(ConsentStatus) as ConsentStatus[];

/**
 * How the customer expressed their consent. HOSTED_PAGE is the preferred
 * happy-path; MAILTO_REPLY is the fallback we accept manually when the
 * customer replied to the email instead of clicking through.
 */
export const ConsentMethod = {
  HOSTED_PAGE: "HOSTED_PAGE",
  MAILTO_REPLY: "MAILTO_REPLY",
  MANUAL: "MANUAL",
} as const;
export type ConsentMethod = (typeof ConsentMethod)[keyof typeof ConsentMethod];
export const CONSENT_METHODS = Object.values(ConsentMethod) as ConsentMethod[];

/**
 * Operational policy for how strictly we want consent before payment.
 * Defaults to ADVISORY — we record consent but never block the customer
 * from paying — until the org explicitly tightens it.
 */
export const ConsentMode = {
  ADVISORY: "ADVISORY",
  RECOMMENDED: "RECOMMENDED",
  REQUIRED: "REQUIRED",
} as const;
export type ConsentMode = (typeof ConsentMode)[keyof typeof ConsentMode];
export const CONSENT_MODES = Object.values(ConsentMode) as ConsentMode[];

/** ISO-4217 currency codes the platform accepts. Extend cautiously - Stripe + ops must support them. */
export const Currency = {
  USD: "USD",
  EUR: "EUR",
  GBP: "GBP",
  AED: "AED",
  CAD: "CAD",
} as const;
export type Currency = (typeof Currency)[keyof typeof Currency];
export const CURRENCIES = Object.values(Currency) as Currency[];

/**
 * Lifecycle of a chargeback / payment dispute. Mapped 1:1 from Stripe's
 * `Dispute.status` so the same enum drives the persisted record and the
 * webhook normalisation. Operators need clear distinctions between
 * "needs response" (action required) and "under review" (waiting on
 * Stripe).
 */
export const DisputeStatus = {
  NEEDS_RESPONSE: "NEEDS_RESPONSE",
  UNDER_REVIEW: "UNDER_REVIEW",
  WARNING_NEEDS_RESPONSE: "WARNING_NEEDS_RESPONSE",
  WARNING_UNDER_REVIEW: "WARNING_UNDER_REVIEW",
  WARNING_CLOSED: "WARNING_CLOSED",
  CHARGE_REFUNDED: "CHARGE_REFUNDED",
  WON: "WON",
  LOST: "LOST",
} as const;
export type DisputeStatus = (typeof DisputeStatus)[keyof typeof DisputeStatus];
export const DISPUTE_STATUSES = Object.values(DisputeStatus) as DisputeStatus[];

/**
 * Terminal outcome on a closed dispute. Null while the dispute is still
 * open; populated when Stripe fires `charge.dispute.closed`.
 */
export const DisputeOutcome = {
  WON: "WON",
  LOST: "LOST",
  WARNING_CLOSED: "WARNING_CLOSED",
  CHARGE_REFUNDED: "CHARGE_REFUNDED",
} as const;
export type DisputeOutcome =
  (typeof DisputeOutcome)[keyof typeof DisputeOutcome];
export const DISPUTE_OUTCOMES = Object.values(DisputeOutcome) as DisputeOutcome[];
