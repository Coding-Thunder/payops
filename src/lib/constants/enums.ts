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

export const OrderStatus = {
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
  ORDER_PAYMENT_LINK_REGENERATED: "ORDER_PAYMENT_LINK_REGENERATED",

  PAYMENT_SUCCEEDED: "PAYMENT_SUCCEEDED",
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
} as const;
export type AuditEntity = (typeof AuditEntity)[keyof typeof AuditEntity];

export const EmailKind = {
  PAYMENT_CONFIRMATION: "PAYMENT_CONFIRMATION",
  PAYMENT_LINK: "PAYMENT_LINK",
} as const;
export type EmailKind = (typeof EmailKind)[keyof typeof EmailKind];

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
