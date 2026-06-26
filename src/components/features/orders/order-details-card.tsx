import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ProviderCard } from "@/components/features/providers";
import { BookingTypeLabel } from "@/lib/constants/labels";
import { formatDateTime } from "@/lib/format";
import type { OrderDTO } from "@/types";

interface OrderDetailsCardProps {
  order: OrderDTO;
}

export function OrderDetailsCard({ order }: OrderDetailsCardProps) {
  const imageUrl = order.vehicle.imageUrl ?? null;
  return (
    <div className="space-y-4">
      <ProviderCard
        provider={order.provider}
        description={`${order.vehicle.company} ${order.vehicle.type}`}
        meta={
          <>
            <div className="font-mono text-[12px] text-foreground">
              {order.orderNumber}
            </div>
            <div className="mt-0.5">{BookingTypeLabel[order.bookingType]}</div>
          </>
        }
      />
      {imageUrl ? (
        <Card>
          <CardContent className="p-0">
            {/* Public car image captured at creation time. Rendered with
                a fixed 16:9 frame and object-cover so wildly varying
                source images still produce a clean card. The anchor lets
                operators open the original for reference (right-click →
                "Save image" too). */}
            <a
              href={imageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl}
                alt={`${order.vehicle.company} ${order.vehicle.type}`}
                className="aspect-[16/9] w-full rounded-t-lg object-cover bg-surface-1"
                loading="lazy"
              />
            </a>
            <div className="border-t border-border px-5 py-2.5 text-[11.5px] text-muted-foreground">
              Public image used in the confirmation email and Stripe checkout.
            </div>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Booking details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-y-4 gap-x-6 text-sm sm:grid-cols-2">
          <Detail
            label="Booking type"
            value={BookingTypeLabel[order.bookingType]}
          />
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
            value={
              <>
                <div>{formatDateTime(order.trip.pickupDate)}</div>
                {order.trip.pickupLocation ? (
                  <div className="text-xs text-muted-foreground">
                    {order.trip.pickupLocation}
                  </div>
                ) : null}
              </>
            }
          />
          <Detail
            label="Drop-off"
            value={
              <>
                <div>{formatDateTime(order.trip.dropoffDate)}</div>
                {order.trip.dropoffLocation ? (
                  <div className="text-xs text-muted-foreground">
                    {order.trip.dropoffLocation}
                  </div>
                ) : null}
              </>
            }
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
