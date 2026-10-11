import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FlightItinerary } from "@/components/common/flight-itinerary";
import { ProviderCard } from "@/components/features/providers";
import {
  BookingTypeLabel,
  providerLabelFor,
} from "@/lib/constants/labels";
import { ServiceType } from "@/lib/constants/enums";
import { buildFlightItinerary } from "@/lib/flight-itinerary";
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
  // FLIGHT only, so for a car rental every read below resolves to
  // null/undefined and its markup is untouched. Legacy flat-field flights
  // come back from `buildFlightItinerary` in the same shape, times in UTC.
  const serviceType = serviceTypeOf(order);
  const isFlight = serviceType === ServiceType.FLIGHT;
  const itinerary = isFlight ? buildFlightItinerary(order.flight) : null;
  return (
    <div className="space-y-4">
      <ProviderCard
        provider={order.provider}
        description={itemDescription}
        // "Rental provider" is the card's own default — a car reads as it
        // always has; a flight or a hotel names its own kind of supplier.
        label={providerLabelFor(serviceType, "Rental provider")}
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
      {itinerary ? (
        <Card>
          <CardHeader>
            <CardTitle>Itinerary</CardTitle>
            <CardDescription>
              {itinerary.legacy
                ? "Booked before itineraries existed — times are shown in UTC."
                : "Times are local to each airport."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FlightItinerary itinerary={itinerary} showOverrideHint />
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
          {serviceRequests(order).map((request) => (
            <Detail
              key={request.label}
              label={request.label}
              value={<p className="whitespace-pre-line">{request.value}</p>}
              full
            />
          ))}
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
 * What the customer asked for and what the team noted about the traveller,
 * per service, each in a full-width block of its own: a flight's passenger
 * notes; a hotel's room preference and guest notes. This page is the
 * operator's, so it shows them all — the passenger and guest notes are
 * OPERATOR-ONLY and appear nowhere else, while the room preference also
 * reaches the customer through the shared service rows (left out of the
 * grid below, so it is not listed twice). A car rental has none.
 */
function serviceRequests(order: OrderDTO): { label: string; value: string }[] {
  const entries: [label: string, value: string | null | undefined][] = [];
  switch (serviceTypeOf(order)) {
    case ServiceType.FLIGHT:
      entries.push(["Passenger notes", order.flight?.passengerNotes]);
      break;
    case ServiceType.HOTEL:
      entries.push(
        ["Room preference", order.hotel?.roomPreference],
        ["Guest notes", order.hotel?.guestNotes],
      );
      break;
  }
  return entries
    .filter((entry): entry is [string, string] => Boolean(entry[1]?.trim()))
    .map(([label, value]) => ({ label, value }));
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
 * A flight's rows are trip-level only (trip type, routes, cabin,
 * passengers); its flights and layovers render in the itinerary card. The
 * booking reference has its own card on this page and the requests their
 * own blocks, so neither is repeated here.
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
      {serviceDetailRows(order, formatDateTime, {
        omitReference: true,
        omitRequests: true,
      }).map((row) => (
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
