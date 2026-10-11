import {
  BookingStatus,
  BookingType,
  CabinClass,
  CaptureMode,
  ConsentMethod,
  ConsentMode,
  ConsentStatus,
  FlightTripType,
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

/**
 * How a HOTEL's order form names each payment timing. A hotel has no
 * counter: what is not paid online is settled at the property. The stored
 * values are the same (`DUE_AT_COUNTER` is "due later"); only the words
 * differ, and `PaymentTimingLabel` stays the car's.
 */
export const HotelPaymentTimingLabel: Record<PaymentTiming, string> = {
  PREPAID: "Paid online now",
  DUE_AT_COUNTER: "Due at the property",
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

export const FlightTripTypeLabel: Record<FlightTripType, string> = {
  ONE_WAY: "One way",
  ROUND_TRIP: "Round trip",
  MULTI_CITY: "Multi-city",
};

export const CabinClassLabel: Record<CabinClass, string> = {
  ECONOMY: "Economy",
  PREMIUM_ECONOMY: "Premium economy",
  BUSINESS: "Business",
  FIRST: "First",
};

/** Human cabin label; passes an unknown stored value through unchanged. */
export function cabinClassLabel(value: string | null | undefined): string {
  if (!value) return "";
  return CabinClassLabel[value as CabinClass] ?? value;
}

/**
 * What a FLIGHT calls its provider: the airline, or the travel supplier the
 * booking was bought through. One copy for every flight surface — emails,
 * customer pages, the consent mailto, the order page and the evidence
 * packet. Never "Rental provider" on a flight.
 */
export const FLIGHT_PROVIDER_LABEL = "Airline / Supplier";

/**
 * What a HOTEL calls its provider: the hotel, or the supplier the stay was
 * booked through — the hotel counterpart of `FLIGHT_PROVIDER_LABEL`. Never
 * "Rental provider" on a hotel.
 */
export const HOTEL_PROVIDER_LABEL = "Hotel / Supplier";

/**
 * The provider label for an order's service: `FLIGHT_PROVIDER_LABEL` on a
 * flight, `HOTEL_PROVIDER_LABEL` on a hotel, otherwise the surface's own
 * label, passed in as `fallback` because surfaces have always worded a car's
 * differently ("Provider" on a receipt, "Rental provider" on the order page)
 * and each keeps its exact string.
 */
export function providerLabelFor(
  serviceType: ServiceType | null | undefined,
  fallback: string,
): string {
  switch (serviceType) {
    case ServiceType.FLIGHT:
      return FLIGHT_PROVIDER_LABEL;
    case ServiceType.HOTEL:
      return HOTEL_PROVIDER_LABEL;
    default:
      return fallback;
  }
}

/**
 * How each service names the supplier's booking reference
 * (`bookingReference` in `@/lib/service-summary`) — wherever an agent enters
 * it or a customer reads it. A car keeps exactly the words it always had;
 * a flight's is the airline's PNR; a hotel's, the hotel's own number.
 */
export interface BookingReferenceWording {
  /** Field label and the confirmation email's top block. */
  label: string;
  /** The short row label on the receipt page. */
  receiptLabel: string;
  /** The reference mid-sentence: "… added or changed the PNR since". */
  noun: string;
  /** What the agent is asked to paste, under the card title. */
  description: string;
  placeholder: string;
  notSet: string;
  saved: string;
  cleared: string;
}

export const BookingReferenceCopy: Record<ServiceType, BookingReferenceWording> = {
  CAR_RENTAL: {
    label: "Confirmation number",
    receiptLabel: "Confirmation #",
    noun: "confirmation number",
    description:
      "Paste the supplier confirmation number. It appears at the top of the customer's confirmation email.",
    placeholder: "e.g. ABC-12345678",
    notSet: "No confirmation number set yet.",
    saved: "Confirmation number saved",
    cleared: "Confirmation number cleared",
  },
  FLIGHT: {
    label: "PNR",
    receiptLabel: "PNR",
    noun: "PNR",
    description:
      "Paste the airline booking reference (PNR). It appears at the top of the customer's confirmation email.",
    placeholder: "e.g. X4T9KP",
    notSet: "No PNR set yet.",
    saved: "PNR saved",
    cleared: "PNR cleared",
  },
  HOTEL: {
    label: "Hotel confirmation number",
    receiptLabel: "Hotel confirmation #",
    noun: "hotel confirmation number",
    description:
      "Paste the hotel's confirmation number. It appears at the top of the customer's confirmation email.",
    placeholder: "e.g. 83920174",
    notSet: "No hotel confirmation number set yet.",
    saved: "Hotel confirmation number saved",
    cleared: "Hotel confirmation number cleared",
  },
};

/** The booking-reference wording for an order (a car's when the service is
 *  unknown — an order written before service types existed). */
export function bookingReferenceCopy(
  serviceType: ServiceType | null | undefined,
): BookingReferenceWording {
  return BookingReferenceCopy[serviceType ?? ServiceType.CAR_RENTAL] ??
    BookingReferenceCopy.CAR_RENTAL;
}

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
