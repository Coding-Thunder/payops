import type {
  AuditAction,
  AuditEntity,
  ConsentMethod,
  ConsentMode,
  ConsentStatus,
  Currency,
  DisputeOutcome,
  DisputeStatus,
  OrderEvidenceActorType,
  OrderEvidenceEventType,
  OrderStatus,
  PaymentGatewayKey,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";

/** Public user shape used by the UI and API responses (never includes passwordHash). */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: RecordState;
  createdBy?: string | null;
  lastLoginAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

export interface OrderCustomer {
  name: string;
  email: string;
  phone: string;
}

export interface OrderPricing {
  amount: number;
  currency: Currency;
}

export interface OrderPayment {
  /** Gateway routing this payment. Null while NOT_INITIATED — no
   *  gateway has been contacted. */
  gateway: PaymentGatewayKey | null;
  /** Provider-side session id. Generic name surfaced to callers — the
   *  underlying schema field is `stripeSessionId` for historical
   *  reasons but holds whatever the gateway returned. */
  paymentSessionId: string | null;
  /** Generic checkout URL. Renamed at the DTO boundary so UI / email
   *  code never has to think about which gateway it points at. */
  paymentUrl: string | null;
  /** Provider's payment-intent id (or equivalent). Some gateways
   *  don't expose this separately; null in that case. */
  paymentIntentId: string | null;
  /** Tenant-configurable workflow status key. Free string; valid
   *  values come from the org's Workflow document. Default tenants
   *  see the legacy enum values unchanged. */
  status: string;
  paidAt: string | null;
  expiresAt: string | null;
  amountReceived: number | null;
  receiptUrl: string | null;
  failureReason: string | null;
  /** When the post-payment confirmation email landed in SMTP (or got
   *  claimed by the single-send guard). Powers the "Confirmation sent"
   *  step in the order detail timeline. */
  confirmationEmailSentAt: string | null;
  /** When the gateway session was generated (NOT_INITIATED →
   *  LINK_GENERATED). Null while the order is still in draft. */
  initiatedAt: string | null;
}

export interface OrderCreator {
  userId: string;
  name: string;
  email: string;
}

export interface OrderPolicy {
  acceptedAt: string;
  version: string;
  text: string;
}

export interface OrderRisk {
  flagged: boolean;
  flaggedNote?: string | null;
  flaggedAt?: string | null;
  flaggedBy?: {
    userId: string | null;
    name: string | null;
  } | null;
}

export interface OrderConsentPointer {
  status: ConsentStatus;
  currentConsentId: string | null;
  requestedAt: string | null;
  receivedAt: string | null;
  verifiedAt: string | null;
  method: ConsentMethod | null;
}

export interface OrderDisputePointer {
  status: DisputeStatus | null;
  currentDisputeId: string | null;
  openedAt: string | null;
  closedAt: string | null;
  outcome: DisputeOutcome | null;
  reason: string | null;
  amount: number | null;
  currency: Currency | null;
}

/* ───────── Universal commerce DTO additions (Pass 5d) ─────────────── */

/** Snapshot of the time window an order is bound to. Optional —
 *  retail / one-shot orders have null. ISO-8601 strings on the wire. */
export interface OrderSchedulingDTO {
  type: "FIXED_WINDOW" | "OPEN_ENDED" | "RECURRING_INTERVAL";
  startsAt: string;
  endsAt: string | null;
}

/** Universal line-item snapshot. Carries everything a renderer needs
 *  without having to re-resolve the catalog row at read time. */
export interface OrderLineItemDTO {
  itemId: string | null;
  itemTypeKey: string;
  name: string;
  description: string | null;
  quantity: number;
  unitPrice: number;
  total: number;
  attributes: Record<string, unknown>;
  scheduling: OrderSchedulingDTO | null;
}

export interface OrderDTO {
  id: string;
  /** Tenant boundary. Nullable for back-compat with pre-multi-tenant
   *  rows that the migration script hadn't yet backfilled when the
   *  DTO was first read. Production rows always have it set. */
  orgId: string | null;
  orderNumber: string;
  /** Tenant-configurable workflow status key. Free string; valid
   *  values come from the org's Workflow document. Default tenants
   *  see the legacy enum values unchanged. */
  status: string;
  state: RecordState;
  customer: OrderCustomer;
  pricing: OrderPricing;
  payment: OrderPayment;
  createdBy: OrderCreator;
  policy: OrderPolicy;
  risk: OrderRisk;
  consent: OrderConsentPointer;
  /** Null when no chargeback has ever been opened against this order's
   *  payment. Once a dispute lands the pointer stays populated for the
   *  audit trail, even if the dispute later closes. */
  dispute: OrderDisputePointer | null;
  /** Cumulative refunded amount in major units. 0 until the first
   *  refund webhook lands. */
  refundedAmount: number;
  notes?: string | null;
  /** Pass 5b/5d — universal commerce line items. Required field;
   *  legacy rental orders pre-Pass-5c-backfill have `[]`. */
  lineItems: OrderLineItemDTO[];
  /** Pass 5b/5d — optional time window for the order. Null for
   *  retail / one-shot orders. */
  scheduling: OrderSchedulingDTO | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Persisted Dispute record exposed to the admin UI. One per chargeback
 * attempt — the order keeps a lightweight pointer (`OrderDisputePointer`)
 * for list views and joins to the full record for detail pages.
 */
export interface DisputeDTO {
  id: string;
  orderId: string;
  orderNumber: string;
  gateway: PaymentGatewayKey;
  gatewayDisputeId: string;
  chargeId: string | null;
  paymentIntentId: string | null;
  status: DisputeStatus;
  reason: string | null;
  outcome: DisputeOutcome | null;
  amount: number;
  amountMinor: number;
  currency: Currency;
  evidenceDueAt: string | null;
  openedAt: string;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentConsentSnapshot {
  /** Human-readable line item summary frozen at consent-request time. */
  summary?: string | null;
  /** Scheduling window taken from the order at consent-request time. */
  startsAt?: string | null;
  endsAt?: string | null;
  amount: number;
  currency: Currency;
  paymentLinkRef: string | null;
}

export interface PaymentConsentDTO {
  id: string;
  orderId: string;
  orderNumber: string;
  status: ConsentStatus;
  method: ConsentMethod | null;
  customerEmail: string;
  customerName: string;
  consentMessage: string;
  consentEmailSubject: string | null;
  signedName: string | null;
  snapshot: PaymentConsentSnapshot;
  requestedAt: string;
  receivedAt: string | null;
  verifiedAt: string | null;
  verifiedBy: {
    userId: string | null;
    name: string | null;
  } | null;
  receiptIp: string | null;
  receiptUserAgent: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** Trimmed shape used by the unauthenticated hosted consent page — never
 *  leaks IP / UA / verifier metadata to the customer. */
export interface PublicConsentView {
  status: ConsentStatus;
  customerName: string;
  customerEmail: string;
  brandName: string;
  consentMessage: string;
  snapshot: PaymentConsentSnapshot;
  paymentUrl: string | null;
  alreadyConfirmedAt: string | null;
}

export interface ConsentSettings {
  mode: ConsentMode;
  message: string;
}

export interface AuditLogDTO {
  id: string;
  action: AuditAction;
  entityType: AuditEntity;
  entityId?: string | null;
  actorId?: string | null;
  actorName?: string | null;
  actorRole?: UserRole | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface OrderEvidenceActorDTO {
  type: OrderEvidenceActorType;
  userId: string | null;
  name: string | null;
  email: string | null;
  role: UserRole | null;
}

export interface OrderEvidenceRequestDTO {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  geoCountry: string | null;
}

export interface OrderEvidenceRefsDTO {
  paymentSessionId: string | null;
  paymentIntentId: string | null;
  transactionId: string | null;
  gatewayEventId: string | null;
  consentId: string | null;
  consentTokenHash: string | null;
  customerEmail: string | null;
  signatureName: string | null;
  messageId: string | null;
}

export interface OrderEvidenceEventDTO {
  id: string;
  orderId: string;
  orderNumber: string;
  sequence: number;
  eventType: OrderEvidenceEventType;
  occurredAt: string;
  actor: OrderEvidenceActorDTO;
  request: OrderEvidenceRequestDTO | null;
  payload: Record<string, unknown>;
  refs: OrderEvidenceRefsDTO | null;
  snapshotHash: string;
  previousHash: string | null;
  hash: string;
  createdAt: string;
}

export interface OrderEvidenceVerificationDTO {
  valid: boolean;
  eventCount: number;
  /** 1-based sequence of the first broken event, when valid === false. */
  brokenAtSequence: number | null;
  /** Reason for the failure: helps surface the right message in the UI
   *  ("payload tampered" vs "previousHash mismatch"). */
  reason: string | null;
  /** Hash of the latest event in the chain (useful for short-circuit
   *  comparisons in the PDF summary). */
  headHash: string | null;
}

export interface OrderEvidenceChainDTO {
  events: OrderEvidenceEventDTO[];
  verification: OrderEvidenceVerificationDTO;
  order: {
    id: string;
    orderNumber: string;
    customer: OrderCustomer;
    pricing: OrderPricing;
    /** Tenant-configurable workflow status key. Free string; valid
   *  values come from the org's Workflow document. Default tenants
   *  see the legacy enum values unchanged. */
  status: string;
    state: RecordState;
    /** Universal commerce — line items snapshot for the evidence page. */
    lineItems: OrderLineItemDTO[];
    /** Optional time window for the order (scheduled / windowed items). */
    scheduling: OrderSchedulingDTO | null;
    createdAt: string;
    /** Pointer copies carried for the case-file outcome panel. The
     *  panel reads `dispute` first (WON / LOST / OPEN), then falls back
     *  to `payment` + `consent` to render the READY state for every
     *  paid order. */
    payment: {
      gateway: PaymentGatewayKey | null;
      paymentIntentId: string | null;
      paidAt: string | null;
      receiptUrl: string | null;
    };
    consent: OrderConsentPointer;
    dispute: OrderDisputePointer | null;
  };
}

export interface OrderEvidenceSearchResultDTO {
  orderId: string;
  orderNumber: string;
  customerEmail: string | null;
  eventType: OrderEvidenceEventType;
  matchedField: string;
  matchedValue: string;
  occurredAt: string;
  eventId: string;
}

export interface ProviderDTO {
  id: string;
  key: string;
  name: string;
  logo: string;
  primaryColor: string;
  onPrimaryColor: string;
  tagline: string;
  status: RecordState;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrderDraftDTO {
  id: string;
  ownerId: string;
  data: Record<string, unknown>;
  summary: {
    customerName: string | null;
    orderAmount: number | null;
    currency: string | null;
  };
  revision: number;
  lastEditedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrandingDTO {
  brandName: string;
  supportEmail: string;
  supportPhone: string;
  /** Tenant-chosen From address for outbound transactional emails.
   *  Empty string means "use the platform default" — appropriate for
   *  tenants who haven't completed SPF/DKIM for their own domain. */
  senderEmail: string;
  logo: string;
  primaryColor: string;
  footerTagline: string;
  updatedAt: string;
}

export interface EmailTemplateVersionDTO {
  id: string;
  templateKey: "payment-confirmation" | "payment-request";
  version: number;
  active: boolean;

  subject: string | null;
  greeting: string | null;
  intro: string | null;
  note: string | null;
  supportHeadline: string | null;
  supportDescription: string | null;
  footerNote: string | null;

  createdBy: { userId: string | null; name: string };
  createdAt: string;
  updatedAt: string;
}

export interface CarLinkDTO {
  id: string;
  carMake: string;
  carType: string;
  /** The full display label — `${carMake} ${carType}`. Server-computed
   *  so every consumer renders it identically. */
  label: string;
  imageUrl: string;
  notes: string | null;
  active: boolean;
  createdBy: { userId: string | null; name: string };
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;
