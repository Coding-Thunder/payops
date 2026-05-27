import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import type { OrderDTO } from "@/types";

interface OrderDetailsCardProps {
  order: OrderDTO;
}

export function OrderDetailsCard({ order }: OrderDetailsCardProps) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Order details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-y-4 gap-x-6 text-sm sm:grid-cols-2">
          <Detail label="Order" value={order.orderNumber} />
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
          {order.lineItems.length > 0 ? (
            <Detail
              label={order.lineItems.length === 1 ? "Item" : "Items"}
              value={
                <div className="space-y-1">
                  {order.lineItems.map((li, idx) => (
                    <div key={idx}>
                      <div className="font-medium">{li.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {li.quantity} × {li.unitPrice} = {li.total}
                      </div>
                    </div>
                  ))}
                </div>
              }
            />
          ) : null}
          {order.scheduling ? (
            <>
              <Detail
                label="Starts"
                value={formatDateTime(order.scheduling.startsAt)}
              />
              {order.scheduling.endsAt ? (
                <Detail
                  label="Ends"
                  value={formatDateTime(order.scheduling.endsAt)}
                />
              ) : null}
            </>
          ) : null}
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
    </div>
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
