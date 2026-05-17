import type {
  AuditAction,
  AuditEntity,
  BookingType,
  Currency,
  OrderStatus,
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

export interface OrderVehicle {
  company: string;
  type: string;
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

export interface OrderDTO {
  id: string;
  orderNumber: string;
  bookingType: BookingType;
  status: OrderStatus;
  state: RecordState;
  customer: OrderCustomer;
  vehicle: OrderVehicle;
  trip: OrderTrip;
  pricing: OrderPricing;
  payment: OrderPayment;
  createdBy: OrderCreator;
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
