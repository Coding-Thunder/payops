import type {
  AuditAction,
  AuditEntity,
  BookingType,
  Currency,
  OrderStatus,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import type { ProviderSnapshot } from "@/lib/constants/providers";

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

export interface OrderVehicle {
  company: string;
  type: string;
  /** Public URL operator captured at creation time; surfaces on the order
   *  detail page, Stripe checkout, and the confirmation email. */
  imageUrl?: string | null;
}

export interface OrderTrip {
  pickupDate: string;
  dropoffDate: string;
}

export interface OrderPricing {
  amount: number;
  currency: Currency;
}

export interface OrderPayment {
  stripeSessionId?: string | null;
  paymentIntentId?: string | null;
  checkoutUrl?: string | null;
  status: OrderStatus;
  paidAt?: string | null;
  expiresAt?: string | null;
  amountReceived?: number | null;
  receiptUrl?: string | null;
  failureReason?: string | null;
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

export interface OrderDTO {
  id: string;
  orderNumber: string;
  bookingType: BookingType;
  status: OrderStatus;
  state: RecordState;
  customer: OrderCustomer;
  provider: ProviderSnapshot;
  vehicle: OrderVehicle;
  trip: OrderTrip;
  pricing: OrderPricing;
  payment: OrderPayment;
  createdBy: OrderCreator;
  policy: OrderPolicy;
  risk: OrderRisk;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
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
  logo: string;
  primaryColor: string;
  footerTagline: string;
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
