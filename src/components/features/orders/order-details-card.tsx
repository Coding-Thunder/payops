import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ProviderCard } from "@/components/features/providers";
import { BookingTypeLabel } from "@/lib/constants/labels";
import { ServiceType } from "@/lib/constants/enums";
import { formatDateTime } from "@/lib/format";
import {
  describeServiceItem,
  serviceDetailRows,
  serviceTypeOf,
} from "@/lib/service-summary";
import type { OrderDTO } from "@/types";

interface OrderDetailsCardProps {
  order: OrderDTO;
}

export function OrderDetailsCard({ order }: OrderDetailsCardProps) {
  // `vehicle` is null on FLIGHT / HOTEL orders, so every read of it is
  // guarded. The car image block below is therefore structurally
  // unreachable for those services — which is correct: there is no car.
  const vehicle = order.vehicle;
  const imageUrl = vehicle?.imageUrl ?? null;
  // Identical to the old `${company} ${type}` for a CAR_RENTAL order.
  const itemDescription = describeServiceItem(order);
  return (
    <div className="space-y-4">
      <ProviderCard
        provider={order.provider}
        description={itemDescription}
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
                alt={itemDescription}
                className="aspect-[16/9] w-full rounded-t-lg object-cover bg-surface-1"
                loading="lazy"
              />
            </a>
            <div className="border-t border-border px-5 py-2.5 text-[11.5px] text-muted-foreground">
              Public image used in the confirmation email and the hosted checkout page.
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
          <ServiceDetails order={order} />
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

/**
 * The service-specific slice of the booking-details grid.
 *
 * CAR_RENTAL renders the original Vehicle / Pick-up / Drop-off triple
 * verbatim — same labels, same two-line markup, same order — because every
 * order both incumbent brands have ever created is a car rental and this
 * panel must not shift by a pixel for them. FLIGHT and HOTEL fall through
 * to the shared `serviceDetailRows` helper so the detail page, the emails
 * and the success page all agree on what a flight or a hotel looks like.
 */
function ServiceDetails({ order }: { order: OrderDTO }) {
  if (serviceTypeOf(order) === ServiceType.CAR_RENTAL) {
    const vehicle = order.vehicle;
    const trip = order.trip;
    return (
      <>
        {vehicle ? (
          <Detail
            label="Vehicle"
            value={
              <>
                <div className="font-medium">{vehicle.company}</div>
                <div className="text-xs text-muted-foreground">
                  {vehicle.type}
                </div>
              </>
            }
          />
        ) : null}
        {trip ? (
          <>
            <Detail
              label="Pick-up"
              value={
                <>
                  <div>{formatDateTime(trip.pickupDate)}</div>
                  {trip.pickupLocation ? (
                    <div className="text-xs text-muted-foreground">
                      {trip.pickupLocation}
                    </div>
                  ) : null}
                </>
              }
            />
            <Detail
              label="Drop-off"
              value={
                <>
                  <div>{formatDateTime(trip.dropoffDate)}</div>
                  {trip.dropoffLocation ? (
                    <div className="text-xs text-muted-foreground">
                      {trip.dropoffLocation}
                    </div>
                  ) : null}
                </>
              }
            />
          </>
        ) : null}
      </>
    );
  }

  return (
    <>
      {serviceDetailRows(order, formatDateTime).map((row) => (
        <Detail key={row.label} label={row.label} value={row.value} />
      ))}
    </>
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
