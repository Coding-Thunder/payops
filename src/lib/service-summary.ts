import { ServiceType, TripType } from "@/lib/constants/enums";
import {
  CabinClassLabel,
  CruiseCabinCategoryLabel,
  ServiceDueLabel,
  ServiceItemLabel,
  ServiceTotalLabel,
} from "@/lib/constants/labels";

/**
 * ONE place that answers "what does this order actually describe?".
 *
 * Every surface that used to reach straight into `order.vehicle` and
 * `order.trip` — the gateway product name, the confirmation and
 * payment-request emails, the consent mailto body, the order table, the
 * detail card, the evidence PDF, the /pay/success page — asks here instead.
 * Without a single source of truth those surfaces drift, and the failure
 * mode is a cruise passenger being shown "Pick-up" and "Drop-off" on the
 * page where they part with money.
 *
 * THE CAR_RENTAL BRANCH IS A VERBATIM COPY of the strings each call site
 * produced before this module existed. That is deliberate and is what makes
 * this change additive: every order inherited from the car-rental baseline
 * renders byte-identically, and the unit tests pin the exact strings so any
 * drift fails the suite.
 *
 * Deliberately dependency-free and framework-free — no `server-only`, no
 * date-fns, no React — so both server code and client components can import
 * it and neither pays for the other's dependencies.
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
  flight?: {
    tripType: TripType;
    airline?: string | null;
    flightNumber?: string | null;
    origin: string;
    destination: string;
    departureDate: DateLike;
    /** Outbound arrival. Absent until an itinerary is chosen. */
    arrivalDate?: DateLike | null;
    returnDate?: DateLike | null;
    cabinClass?: string | null;
    /** Airline record locator, present once the booking is ticketed. */
    pnr?: string | null;
    passengers?: { adults: number; children: number; infants: number } | null;
  } | null;
  cruise?: {
    cruiseLine?: string | null;
    shipName?: string | null;
    itinerary?: string | null;
    departurePort: string;
    arrivalPort?: string | null;
    departureDate: DateLike;
    returnDate: DateLike;
    cabinCategory?: string | null;
    cabinNumber?: string | null;
    guests?: { adults: number; children: number } | null;
    /** Cruise-line booking reference, present once the cabin is held. */
    bookingReference?: string | null;
  } | null;
}

/** One label/value pair for a detail table or an email metadata row. */
export interface ServiceRow {
  label: string;
  value: string;
}

/** `YYYY-MM-DD`, matching what the rental description has always emitted. */
function isoDay(value: DateLike): string {
  return new Date(value).toISOString().slice(0, 10);
}

/** Whole nights between two instants, floored at 1 so a same-day sailing
 *  still reads as a night rather than "0 nights". */
function nightsBetween(start: DateLike, end: DateLike): number {
  return Math.max(
    1,
    Math.round(
      (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000,
    ),
  );
}

/**
 * An order's service type, defaulting to CAR_RENTAL.
 *
 * Every read path goes through this rather than touching `serviceType`
 * directly, because a document stored before the field existed has no such
 * key and `.lean()` does NOT apply Mongoose defaults.
 */
export function serviceTypeOf(order: ServiceSummarySource): ServiceType {
  return order.serviceType ?? ServiceType.CAR_RENTAL;
}

/**
 * The short "what was bought" string — a car, a route, or a sailing.
 * Falls back to the service noun when the payload is missing, so a
 * malformed row degrades to a readable word instead of "undefined
 * undefined".
 */
export function describeServiceItem(order: ServiceSummarySource): string {
  switch (serviceTypeOf(order)) {
    case ServiceType.FLIGHT: {
      const f = order.flight;
      if (!f) return "Flight";
      const route = `${f.origin} → ${f.destination}`;
      const carrier = [f.airline, f.flightNumber].filter(Boolean).join(" ");
      return carrier ? `${carrier} • ${route}` : route;
    }
    case ServiceType.CRUISE: {
      const c = order.cruise;
      if (!c) return "Cruise";
      // The ship is what a passenger recognises; the line qualifies it.
      // Falls back to the route when neither has been sourced yet.
      const vessel = [c.cruiseLine, c.shipName].filter(Boolean).join(" ");
      const route = c.arrivalPort && c.arrivalPort !== c.departurePort
        ? `${c.departurePort} → ${c.arrivalPort}`
        : `Round trip from ${c.departurePort}`;
      return vessel ? `${vessel} • ${route}` : route;
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
  return ServiceItemLabel[serviceTypeOf(order)];
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
      const out = `Departs: ${isoDay(f.departureDate)}`;
      if (f.tripType === TripType.ROUND_TRIP && f.returnDate) {
        return `${out} • Returns: ${isoDay(f.returnDate)}`;
      }
      return `${out} • One way`;
    }
    case ServiceType.CRUISE: {
      const c = order.cruise;
      if (!c) return "";
      const nights = nightsBetween(c.departureDate, c.returnDate);
      return `Sails: ${isoDay(c.departureDate)} • Returns: ${isoDay(
        c.returnDate,
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
      const f = order.flight;
      if (!f) return [];
      const rows: ServiceRow[] = [
        { label: "Route", value: `${f.origin} → ${f.destination}` },
      ];
      const carrier = [f.airline, f.flightNumber].filter(Boolean).join(" ");
      if (carrier) rows.push({ label: "Airline", value: carrier });
      if (f.pnr) rows.push({ label: "PNR", value: f.pnr });
      rows.push({ label: "Departure", value: formatDate(f.departureDate) });
      if (f.arrivalDate) {
        rows.push({ label: "Arrival", value: formatDate(f.arrivalDate) });
      }
      if (f.tripType === TripType.ROUND_TRIP && f.returnDate) {
        rows.push({ label: "Return", value: formatDate(f.returnDate) });
      } else {
        rows.push({ label: "Trip type", value: "One way" });
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
      return rows;
    }
    case ServiceType.CRUISE: {
      const c = order.cruise;
      if (!c) return [];
      const rows: ServiceRow[] = [];
      const vessel = [c.cruiseLine, c.shipName].filter(Boolean).join(" ");
      if (vessel) rows.push({ label: "Ship", value: vessel });
      if (c.itinerary) rows.push({ label: "Itinerary", value: c.itinerary });
      rows.push({ label: "Departs from", value: c.departurePort });
      // Only worth a row when the sailing actually ends somewhere else — a
      // round trip repeating the home port is noise on a receipt.
      if (c.arrivalPort && c.arrivalPort !== c.departurePort) {
        rows.push({ label: "Disembarks at", value: c.arrivalPort });
      }
      rows.push({ label: "Sailing date", value: formatDate(c.departureDate) });
      rows.push({ label: "Return date", value: formatDate(c.returnDate) });
      const nights = nightsBetween(c.departureDate, c.returnDate);
      rows.push({
        label: "Duration",
        value: `${nights} night${nights === 1 ? "" : "s"}`,
      });
      if (c.cabinCategory) {
        rows.push({ label: "Cabin", value: cruiseCabinLabel(c.cabinCategory) });
      }
      if (c.cabinNumber) {
        rows.push({ label: "Stateroom", value: c.cabinNumber });
      }
      if (c.bookingReference) {
        rows.push({ label: "Booking ref", value: c.bookingReference });
      }
      if (c.guests) {
        rows.push({ label: "Guests", value: describeGuests(c.guests) });
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

/**
 * The item + start/end slots of a PaymentConsentSnapshot.
 *
 * That snapshot predates service types and has exactly three slots for
 * "what and when": `vehicle`, `pickupDate`, `dropoffDate`, all required.
 * Keeping ONE shape is what stops the append-only consent chain forking, so
 * flights and cruises map their own item and dates into the same slots and
 * the customer-facing page relabels them from `serviceType`.
 *
 * CAR_RENTAL fills them from the trip verbatim — same string, same ISO
 * stamps — so an existing consent record is byte-identical.
 */
export function serviceConsentSlots(order: ServiceSummarySource): {
  item: string;
  startDate: string;
  endDate: string;
  startLocation: string | null;
  endLocation: string | null;
} {
  const t = order.trip;
  if (t) {
    return {
      item: order.vehicle
        ? `${order.vehicle.company} • ${order.vehicle.type}`
        : describeServiceItem(order),
      startDate: new Date(t.pickupDate).toISOString(),
      endDate: new Date(t.dropoffDate).toISOString(),
      startLocation: t.pickupLocation ?? null,
      endLocation: t.dropoffLocation ?? null,
    };
  }
  const f = order.flight;
  if (f) {
    return {
      item: describeServiceItem(order),
      startDate: new Date(f.departureDate).toISOString(),
      // A one-way flight has no return leg. Repeating the departure keeps
      // the required slot filled; the consent page detects the repeat and
      // omits the row rather than printing a return that does not exist.
      endDate: new Date(f.returnDate ?? f.departureDate).toISOString(),
      startLocation: f.origin,
      endLocation: f.destination,
    };
  }
  const c = order.cruise;
  if (c) {
    return {
      item: describeServiceItem(order),
      startDate: new Date(c.departureDate).toISOString(),
      endDate: new Date(c.returnDate).toISOString(),
      startLocation: c.departurePort,
      endLocation: c.arrivalPort ?? c.departurePort,
    };
  }
  // No service payload at all — a malformed row. Store the readable noun
  // and today's stamp rather than throwing on the customer's send path.
  const now = new Date().toISOString();
  return {
    item: describeServiceItem(order),
    startDate: now,
    endDate: now,
    startLocation: null,
    endLocation: null,
  };
}

function cabinClassLabel(value: string): string {
  return (CabinClassLabel as Record<string, string>)[value] ?? value;
}

function cruiseCabinLabel(value: string): string {
  return (CruiseCabinCategoryLabel as Record<string, string>)[value] ?? value;
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
    case ServiceType.CRUISE:
      return "cruise";
    case ServiceType.CAR_RENTAL:
    default:
      return "rental";
  }
}

/** Breakdown-row copy for this order's service. Re-exported from the label
 *  registry so a caller needs one import, not three. */
export function serviceChargeWording(order: ServiceSummarySource): {
  dueLabel: string;
  totalLabel: string;
} {
  const t = serviceTypeOf(order);
  return { dueLabel: ServiceDueLabel[t], totalLabel: ServiceTotalLabel[t] };
}
