import { FlightTripType, ServiceType } from "@/lib/constants/enums";
import {
  cabinClassLabel,
  FlightTripTypeLabel,
} from "@/lib/constants/labels";
import {
  buildFlightItinerary,
  type FlightItinerarySource,
  formatLocalDate,
  formatLocalTime,
  itineraryFirstDeparture,
  itineraryReturnDeparture,
  truncateText,
} from "@/lib/flight-itinerary";

/**
 * ONE place that answers "what does this order actually describe?".
 *
 * Every surface that used to reach straight into `order.vehicle` and
 * `order.trip` — the gateway product name, the confirmation and
 * payment-request emails, the consent mailto body, the order table, the
 * detail card, the /pay/success page — now asks here instead. Without a
 * single source of truth those seven surfaces drift, and the failure mode
 * is a FlightBizz customer being shown "Pick-up" and "Drop-off" for a
 * flight, on the page where they part with money.
 *
 * THE CAR_RENTAL BRANCH IS A VERBATIM COPY of the strings each call site
 * produced before this module existed. That is deliberate and is what makes
 * this change additive: RentalConfirmation's and TripReservations' output is
 * byte-identical, and `src/tests/integration/services/brand-leak.test.ts`
 * pins the exact strings so any drift fails the suite.
 *
 * Deliberately dependency-free and framework-free so both server code and
 * client components can import it.
 */

/** Accepts a Mongoose document (Date) or a DTO (ISO string). */
type DateLike = Date | string;

export interface ServiceSummarySource {
  serviceType?: ServiceType | null;
  vehicle?: { company: string; type: string } | null;
  trip?: {
    pickupDate: DateLike;
    dropoffDate: DateLike;
    pickupLocation?: string | null;
    dropoffLocation?: string | null;
  } | null;
  /** Itinerary orders carry `outbound` / `return`; orders created before
   *  itineraries carry the legacy flat fields. `buildFlightItinerary`
   *  reads both. */
  flight?: (FlightItinerarySource & {
    cabinClass?: string | null;
    /** Airline record locator, present once the booking is ticketed. */
    pnr?: string | null;
    passengers?: { adults: number; children: number; infants: number } | null;
  }) | null;
  hotel?: {
    destination: string;
    propertyName?: string | null;
    checkInDate: DateLike;
    checkOutDate: DateLike;
    rooms?: number | null;
    guests?: { adults: number; children: number } | null;
  } | null;
}

/** One label/value pair for a detail table or an email metadata row. */
export interface ServiceRow {
  label: string;
  value: string;
}

/**
 * Cap on the flight "what was bought" string. A multi-city route can list a
 * dozen airports, and this string lands in places with hard limits: the
 * consent snapshot's `vehicle` (160 chars) and gateway line-item names.
 */
const FLIGHT_ITEM_MAX_LENGTH = 120;

/** `YYYY-MM-DD`, matching what the rental description has always emitted. */
function isoDay(value: DateLike): string {
  return new Date(value).toISOString().slice(0, 10);
}

/**
 * An order's service type, defaulting to CAR_RENTAL.
 *
 * Every read path goes through this rather than touching `serviceType`
 * directly, because a document stored before the field existed has no such
 * key and `.lean()` does not apply Mongoose defaults.
 */
export function serviceTypeOf(order: ServiceSummarySource): ServiceType {
  return order.serviceType ?? ServiceType.CAR_RENTAL;
}

/**
 * The short "what was bought" string — a car, a route, or a property.
 * Falls back to the service label when the payload is missing, so a
 * malformed row degrades to a readable noun instead of "undefined
 * undefined".
 */
export function describeServiceItem(order: ServiceSummarySource): string {
  switch (serviceTypeOf(order)) {
    case ServiceType.FLIGHT: {
      const f = order.flight;
      if (!f) return "Flight";
      const view = buildFlightItinerary(f);
      if (!view) return "Flight";
      if (view.legacy) {
        // Historic format, unchanged for orders created before itineraries.
        const route = `${f.origin} → ${f.destination}`;
        const carrier = [f.airline, f.flightNumber].filter(Boolean).join(" ");
        return carrier ? `${carrier} • ${route}` : route;
      }
      const outbound = view.journeys[0];
      // A single direct one-way keeps the "carrier • route" shape; anything
      // with more flights shows every airport rather than collapsing a
      // connecting itinerary into one origin → destination pair.
      if (view.journeys.length === 1 && outbound.segments.length === 1) {
        const s = outbound.segments[0];
        const carrier = [s.airline, s.flightNumber].filter(Boolean).join(" ");
        return truncateText(
          carrier ? `${carrier} • ${outbound.route}` : outbound.route,
          FLIGHT_ITEM_MAX_LENGTH,
        );
      }
      const suffix =
        view.tripType === FlightTripType.ROUND_TRIP ? " (round trip)" : "";
      return truncateText(`${outbound.route}${suffix}`, FLIGHT_ITEM_MAX_LENGTH);
    }
    case ServiceType.HOTEL: {
      const h = order.hotel;
      if (!h) return "Hotel";
      return h.propertyName
        ? `${h.propertyName} • ${h.destination}`
        : h.destination;
    }
    case ServiceType.CAR_RENTAL:
    default: {
      const v = order.vehicle;
      // Historic format, unchanged: "Toyota Corolla".
      return v ? `${v.company} ${v.type}` : "Vehicle";
    }
  }
}

/** Header for the "what was bought" column / row, per service type. */
export function serviceItemLabel(order: ServiceSummarySource): string {
  switch (serviceTypeOf(order)) {
    case ServiceType.FLIGHT:
      return "Route";
    case ServiceType.HOTEL:
      return "Property";
    case ServiceType.CAR_RENTAL:
    default:
      return "Vehicle";
  }
}

/**
 * The gateway-hosted checkout line-item description.
 *
 * CAR_RENTAL returns exactly what `describeProductDescription` in
 * order.service.ts returned before this module existed, including the
 * bullet separator and the parenthesised locations.
 */
export function describeServiceDates(order: ServiceSummarySource): string {
  switch (serviceTypeOf(order)) {
    case ServiceType.FLIGHT: {
      const f = order.flight;
      if (!f) return "";
      const view = buildFlightItinerary(f);
      if (!view) return "";
      if (view.legacy) {
        // Historic format, unchanged for orders created before itineraries.
        if (!f.departureDate) return "";
        const out = `Departs: ${isoDay(f.departureDate)}`;
        if (f.tripType === FlightTripType.ROUND_TRIP && f.returnDate) {
          return `${out} • Returns: ${isoDay(f.returnDate)}`;
        }
        return `${out} • One way`;
      }
      const first = itineraryFirstDeparture(view);
      const out = first
        ? `Departs: ${formatLocalDate(first.date)} ${formatLocalTime(first.time)}`
        : "";
      if (view.tripType === FlightTripType.ROUND_TRIP) {
        const back = itineraryReturnDeparture(view);
        return back
          ? `${out} • Returns: ${formatLocalDate(back.date)} ${formatLocalTime(back.time)}`
          : out;
      }
      const flights = view.journeys[0].segments.length;
      if (view.tripType === FlightTripType.MULTI_CITY) {
        return `${out} • Multi-city, ${flights} flights`;
      }
      const stops = flights - 1;
      return stops > 0
        ? `${out} • One way, ${stops} stop${stops === 1 ? "" : "s"}`
        : `${out} • One way`;
    }
    case ServiceType.HOTEL: {
      const h = order.hotel;
      if (!h) return "";
      const nights = Math.max(
        1,
        Math.round(
          (new Date(h.checkOutDate).getTime() -
            new Date(h.checkInDate).getTime()) /
            86_400_000,
        ),
      );
      return `Check-in: ${isoDay(h.checkInDate)} • Check-out: ${isoDay(
        h.checkOutDate,
      )} • ${nights} night${nights === 1 ? "" : "s"}`;
    }
    case ServiceType.CAR_RENTAL:
    default: {
      const t = order.trip;
      if (!t) return "";
      // VERBATIM from the pre-existing describeProductDescription.
      const pickup = isoDay(t.pickupDate);
      const drop = isoDay(t.dropoffDate);
      const pickupLoc = t.pickupLocation?.trim();
      const dropLoc = t.dropoffLocation?.trim();
      const pickupPart = pickupLoc ? `${pickup} (${pickupLoc})` : pickup;
      const dropPart = dropLoc ? `${drop} (${dropLoc})` : drop;
      return `Pick-up: ${pickupPart} • Drop-off: ${dropPart}`;
    }
  }
}

/**
 * The label/value rows a receipt or detail panel should show for this
 * order's service. CAR_RENTAL yields exactly the Vehicle / Pick-up /
 * Drop-off triple those surfaces rendered before, in the same order.
 *
 * `formatDate` lets each caller keep its own date formatting (emails use a
 * long human format, the checkout description uses ISO days) without this
 * module taking a dependency on date-fns or the app's locale settings.
 */
export function serviceDetailRows(
  order: ServiceSummarySource,
  formatDate: (value: DateLike) => string = isoDay,
): ServiceRow[] {
  switch (serviceTypeOf(order)) {
    case ServiceType.FLIGHT: {
      // Trip-level summary only. The flights themselves — every segment,
      // time and layover — are rendered from `buildFlightItinerary` by each
      // surface's itinerary block, never squeezed into label/value rows.
      const f = order.flight;
      if (!f) return [];
      const view = buildFlightItinerary(f);
      const rows: ServiceRow[] = [];
      if (view) {
        rows.push({
          label: "Trip type",
          value: FlightTripTypeLabel[view.tripType],
        });
        for (const journey of view.journeys) {
          rows.push({
            label:
              view.tripType === FlightTripType.ROUND_TRIP
                ? journey.label
                : "Route",
            value: journey.route,
          });
        }
      }
      if (f.cabinClass) {
        rows.push({ label: "Cabin", value: cabinClassLabel(f.cabinClass) });
      }
      if (f.passengers) {
        rows.push({
          label: "Passengers",
          value: describePassengers(f.passengers),
        });
      }
      if (f.pnr) rows.push({ label: "PNR", value: f.pnr });
      return rows;
    }
    case ServiceType.HOTEL: {
      const h = order.hotel;
      if (!h) return [];
      const rows: ServiceRow[] = [];
      if (h.propertyName) {
        rows.push({ label: "Property", value: h.propertyName });
      }
      rows.push({ label: "Destination", value: h.destination });
      rows.push({ label: "Check-in", value: formatDate(h.checkInDate) });
      rows.push({ label: "Check-out", value: formatDate(h.checkOutDate) });
      if (h.rooms) {
        rows.push({
          label: "Rooms",
          value: `${h.rooms} room${h.rooms === 1 ? "" : "s"}`,
        });
      }
      if (h.guests) {
        rows.push({ label: "Guests", value: describeGuests(h.guests) });
      }
      return rows;
    }
    case ServiceType.CAR_RENTAL:
    default: {
      const rows: ServiceRow[] = [];
      if (order.vehicle) {
        rows.push({ label: "Vehicle", value: describeServiceItem(order) });
      }
      const t = order.trip;
      if (t) {
        rows.push({ label: "Pick-up", value: formatDate(t.pickupDate) });
        rows.push({ label: "Drop-off", value: formatDate(t.dropoffDate) });
      }
      return rows;
    }
  }
}

function describePassengers(p: {
  adults: number;
  children: number;
  infants: number;
}): string {
  const parts = [`${p.adults} adult${p.adults === 1 ? "" : "s"}`];
  if (p.children > 0) {
    parts.push(`${p.children} child${p.children === 1 ? "" : "ren"}`);
  }
  if (p.infants > 0) {
    parts.push(`${p.infants} infant${p.infants === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

function describeGuests(g: { adults: number; children: number }): string {
  const parts = [`${g.adults} adult${g.adults === 1 ? "" : "s"}`];
  if (g.children > 0) {
    parts.push(`${g.children} child${g.children === 1 ? "" : "ren"}`);
  }
  return parts.join(", ");
}

/**
 * Noun used where copy has to name the thing generically, e.g. the
 * charge-breakdown total line. CAR_RENTAL returns "rental" so the existing
 * "Total rental cost" string is reproduced exactly.
 */
export function serviceNoun(order: ServiceSummarySource): string {
  switch (serviceTypeOf(order)) {
    case ServiceType.FLIGHT:
      return "flight";
    case ServiceType.HOTEL:
      return "hotel";
    case ServiceType.CAR_RENTAL:
    default:
      return "rental";
  }
}
