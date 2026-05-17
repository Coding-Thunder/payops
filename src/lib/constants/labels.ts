import {
  BookingType,
  OrderStatus,
  RecordState,
  UserRole,
} from "./enums";

export const BookingTypeLabel: Record<BookingType, string> = {
  NEW_BOOKING: "New booking",
  MODIFICATION: "Modification",
  CANCELLATION_CHARGE: "Cancellation charge",
};

export const OrderStatusLabel: Record<OrderStatus, string> = {
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
  "warning" | "success" | "destructive" | "muted"
> = {
  PAYMENT_PENDING: "warning",
  PAID: "success",
  FAILED: "destructive",
  EXPIRED: "muted",
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
