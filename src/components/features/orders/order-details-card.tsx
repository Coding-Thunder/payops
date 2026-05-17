import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BookingTypeLabel } from "@/lib/constants/labels";
import { formatDateTime } from "@/lib/format";
import type { OrderDTO } from "@/types";

interface OrderDetailsCardProps {
  order: OrderDTO;
}

export function OrderDetailsCard({ order }: OrderDetailsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Booking details</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-y-4 gap-x-6 text-sm sm:grid-cols-2">
        <Detail label="Booking type" value={BookingTypeLabel[order.bookingType]} />
        <Detail label="Created" value={formatDateTime(order.createdAt)} />
        <Detail
          label="Customer"
          value={
            <>
              <div className="font-medium">{order.customer.name}</div>
              <div className="text-xs text-muted-foreground">
                {order.customer.email}
              </div>
              <div className="text-xs text-muted-foreground">
                {order.customer.phone}
              </div>
            </>
          }
        />
        <Detail
          label="Vehicle"
          value={
            <>
              <div className="font-medium">{order.vehicle.company}</div>
              <div className="text-xs text-muted-foreground">
                {order.vehicle.type}
              </div>
            </>
          }
        />
        <Detail
          label="Pick-up"
          value={formatDateTime(order.trip.pickupDate)}
        />
        <Detail
          label="Drop-off"
          value={formatDateTime(order.trip.dropoffDate)}
        />
        <Detail
          label="Created by"
          value={
            <>
              <div className="font-medium">{order.createdBy.name}</div>
              <div className="text-xs text-muted-foreground">
                {order.createdBy.email}
              </div>
            </>
          }
        />
        {order.notes ? (
          <Detail
            label="Internal notes"
            value={<p className="whitespace-pre-line">{order.notes}</p>}
            full
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function Detail({
  label,
  value,
  full,
}: {
  label: string;
  value: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div className={full ? "sm:col-span-2" : undefined}>
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <div className="mt-1 text-sm text-foreground">{value}</div>
    </div>
  );
}
