import { Badge } from "@/components/ui/badge";
import {
  BookingStatusBadgeVariant,
  BookingStatusLabel,
  ConsentStatusBadgeVariant,
  ConsentStatusLabel,
  OrderStatusBadgeVariant,
  OrderStatusLabel,
  PaymentCaptureStatusBadgeVariant,
  PaymentCaptureStatusLabel,
  RecordStateBadgeVariant,
  RecordStateLabel,
  UserRoleBadgeVariant,
  UserRoleLabel,
} from "@/lib/constants/labels";
import {
  BookingStatus,
  ConsentStatus,
  OrderStatus,
  PaymentCaptureStatus,
  type RecordState,
  type UserRole,
} from "@/lib/constants/enums";
import { cn } from "@/lib/utils";

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const variant = OrderStatusBadgeVariant[status];
  const pending = status === OrderStatus.PAYMENT_PENDING;
  return (
    <Badge variant={variant} className={cn(pending && "gap-1.5")}>
      {pending ? (
        <span
          aria-hidden
          className="relative inline-grid size-1.5 place-items-center"
        >
          <span className="absolute inset-0 rounded-full bg-warning/60 animate-ping" />
          <span className="size-1.5 rounded-full bg-warning" />
        </span>
      ) : null}
      {OrderStatusLabel[status]}
    </Badge>
  );
}

export function RecordStateBadge({ state }: { state: RecordState }) {
  return (
    <Badge variant={RecordStateBadgeVariant[state]}>
      {RecordStateLabel[state]}
    </Badge>
  );
}

export function UserRoleBadge({ role }: { role: UserRole }) {
  return (
    <Badge variant={UserRoleBadgeVariant[role]}>{UserRoleLabel[role]}</Badge>
  );
}

export function ConsentStatusBadge({
  status,
}: {
  status: ConsentStatus;
}) {
  const variant = ConsentStatusBadgeVariant[status];
  const awaiting = status === ConsentStatus.REQUESTED;
  return (
    <Badge variant={variant} className={cn(awaiting && "gap-1.5")}>
      {awaiting ? (
        <span
          aria-hidden
          className="relative inline-grid size-1.5 place-items-center"
        >
          <span className="absolute inset-0 rounded-full bg-warning/60 animate-ping" />
          <span className="size-1.5 rounded-full bg-warning" />
        </span>
      ) : null}
      {ConsentStatusLabel[status]}
    </Badge>
  );
}

/**
 * Booking lifecycle badge — separate from `OrderStatusBadge`, which
 * reports the PAYMENT lifecycle. Only manual-capture orders carry a
 * booking status, so this renders nowhere for the two incumbent brands.
 */
export function BookingStatusBadge({ status }: { status: BookingStatus }) {
  const variant = BookingStatusBadgeVariant[status];
  const awaiting = status === BookingStatus.PENDING;
  return (
    <Badge variant={variant} className={cn(awaiting && "gap-1.5")}>
      {awaiting ? <PulseDot /> : null}
      {BookingStatusLabel[status]}
    </Badge>
  );
}

/**
 * State of the authorization on a manual-capture order. Callers must only
 * render this when `order.payment.capture` is non-null; it is null on every
 * automatic-capture order.
 */
export function PaymentCaptureStatusBadge({
  status,
}: {
  status: PaymentCaptureStatus;
}) {
  const variant = PaymentCaptureStatusBadgeVariant[status];
  const inFlight = status === PaymentCaptureStatus.CAPTURE_PENDING;
  return (
    <Badge variant={variant} className={cn(inFlight && "gap-1.5")}>
      {inFlight ? <PulseDot /> : null}
      {PaymentCaptureStatusLabel[status]}
    </Badge>
  );
}

/** The "something is still in flight" marker used by the badges above. */
function PulseDot() {
  return (
    <span
      aria-hidden
      className="relative inline-grid size-1.5 place-items-center"
    >
      <span className="absolute inset-0 rounded-full bg-warning/60 animate-ping" />
      <span className="size-1.5 rounded-full bg-warning" />
    </span>
  );
}
