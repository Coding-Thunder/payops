import { Badge } from "@/components/ui/badge";
import {
  OrderStatusBadgeVariant,
  OrderStatusLabel,
  RecordStateBadgeVariant,
  RecordStateLabel,
  UserRoleBadgeVariant,
  UserRoleLabel,
} from "@/lib/constants/labels";
import type {
  OrderStatus,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return (
    <Badge variant={OrderStatusBadgeVariant[status]}>
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
