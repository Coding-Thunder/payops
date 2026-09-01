import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ProviderCard } from "@/components/features/providers";
import { BookingTypeLabel, ServiceTypeLabel } from "@/lib/constants/labels";
import { ServiceType } from "@/lib/constants/enums";
import {
  describeServiceItem,
  serviceDetailRows,
  serviceTypeOf,
} from "@/lib/service-summary";
import { formatDateTime } from "@/lib/format";
import type { OrderDTO } from "@/types";

interface OrderDetailsCardProps {
  order: OrderDTO;
}

/**
 * The operator's view of what was booked.
 *
 * CAR_RENTAL keeps its bespoke layout — the two-line Vehicle cell, the
 * date-over-location Pick-up and Drop-off cells, and the car hero image —
 * because those are genuinely richer than a flat label/value list and are
 * what the rental workflow was built around. FLIGHT and CRUISE render the
 * shared `serviceDetailRows()` instead, which is the same data every other
 * surface (emails, evidence PDF, /pay/success) reads, so the operator and
 * the customer can never be looking at different facts.
 */
export function OrderDetailsCard({ order }: OrderDetailsCardProps) {
  const serviceType = serviceTypeOf(order);
  const isCarRental = serviceType === ServiceType.CAR_RENTAL;
  // Car photo only — there is no equivalent operator-supplied image on a
  // flight or a cruise, and the provider mark already carries the brand.
  const imageUrl = order.vehicle?.imageUrl ?? null;
  const serviceRows = isCarRental
    ? []
    : serviceDetailRows(order, formatDateTime);

  return (
    <div className="space-y-4">
      <ProviderCard
        provider={order.provider}
        description={describeServiceItem(order)}
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
                alt={describeServiceItem(order)}
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
          {/* Only shown once the deployment sells more than car rental —
              on a rental-only console it would be a constant. */}
          {isCarRental ? null : (
            <Detail label="Service" value={ServiceTypeLabel[serviceType]} />
          )}
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

          {order.vehicle ? (
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
          ) : null}
          {order.trip ? (
            <>
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
            </>
          ) : null}

          {serviceRows.map((row) => (
            <Detail key={row.label} label={row.label} value={row.value} />
          ))}

          {/* Free-text requirements the operator captured. Wide, because
              they are prose rather than a field. */}
          {order.flight?.passengerNotes ? (
            <Detail
              label="Special requirements"
              value={
                <p className="whitespace-pre-line">
                  {order.flight.passengerNotes}
                </p>
              }
              full
            />
          ) : null}
          {order.cruise?.guestNotes ? (
            <Detail
              label="Guest requirements"
              value={
                <p className="whitespace-pre-line">
                  {order.cruise.guestNotes}
                </p>
              }
              full
            />
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
