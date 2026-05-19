import { Badge } from "@/components/ui/badge";
import {
  ConsentStatusBadgeVariant,
  ConsentStatusLabel,
  OrderStatusBadgeVariant,
  OrderStatusLabel,
  RecordStateBadgeVariant,
  RecordStateLabel,
  UserRoleBadgeVariant,
  UserRoleLabel,
} from "@/lib/constants/labels";
import {
  ConsentStatus,
  OrderStatus,
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
