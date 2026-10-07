import "server-only";

import {
  flightMoneyWording,
  showsAirlineCharge,
  summarizeFlightAmounts,
} from "@/lib/charges";
import { FlightTripType, ServiceType } from "@/lib/constants/enums";
import { providerLabelFor } from "@/lib/constants/labels";
import {
  buildFlightItinerary,
  formatLocalDate,
  formatSegmentTime,
  journeyStopsLabel,
  truncateText,
} from "@/lib/flight-itinerary";
import { serviceDetailRows, serviceTypeOf } from "@/lib/service-summary";
import type { OrderDTO } from "@/types";

import { formatEmailDay } from "./format";

/** A multi-city route can list a dozen airports; one line each keeps the
 *  body inside its length budget. */
const FLIGHT_ROUTE_MAX_LENGTH = 90;

/** The trip-level rows a flight's body keeps from `serviceDetailRows` —
 *  its routes are written per journey below, with their departures. */
const FLIGHT_SUMMARY_ROWS = new Set(["Cabin", "Passengers", "PNR"]);

/**
 * The order-facts block: what was booked, in the booking's own vocabulary.
 *
 * CAR_RENTAL reproduces the three lines this function emitted inline before
 * service types existed — "Vehicle: Company • Type" then the bare pick-up
 * and drop-off days, no locations. `serviceDetailRows()` renders the rental
 * case slightly differently (a space instead of "•"), so the rental branch
 * deliberately keeps its own literals rather than routing through it; a
 * flight or hotel has no vehicle and no pick-up at all and takes the shared
 * helper, which is the whole point of that module.
 */
function serviceLines(order: OrderDTO): string[] {
  if (serviceTypeOf(order) === ServiceType.CAR_RENTAL) {
    const lines: string[] = [];
    if (order.vehicle) {
      lines.push(`Vehicle: ${order.vehicle.company} • ${order.vehicle.type}`);
    }
    if (order.trip) {
      lines.push(`Pick-up: ${formatEmailDay(order.trip.pickupDate)}`);
      lines.push(`Drop-off: ${formatEmailDay(order.trip.dropoffDate)}`);
    }
    return lines;
  }
  if (serviceTypeOf(order) === ServiceType.FLIGHT) return flightLines(order);
  return serviceDetailRows(order, formatEmailDay).map(
    (row) => `${row.label}: ${row.value}`,
  );
}

/**
 * A flight, compactly: one line per journey with its route, first
 * departure and stops — "Outbound: Delhi → Varanasi → Mumbai • Sat, Oct 10,
 * 2026 10:30 AM • 1 stop" ("2 flights" on a multi-city trip) — then cabin,
 * passengers and PNR. Every flight and layover is already in the email
 * above; this is the customer's written acknowledgement of what they are
 * booking.
 */
function flightLines(order: OrderDTO): string[] {
  const lines: string[] = [];
  const itinerary = buildFlightItinerary(order.flight);
  const tripType = itinerary?.tripType ?? FlightTripType.ONE_WAY;
  for (const journey of itinerary?.journeys ?? []) {
    const parts = [truncateText(journey.route, FLIGHT_ROUTE_MAX_LENGTH)];
    const departure = journey.segments[0]?.departure;
    if (departure) {
      parts.push(
        `${formatLocalDate(departure.date)} ${formatSegmentTime(
          departure,
          journey.timeZoneLabel,
        )}`,
      );
    }
    // Lower-case: "direct", "1 stop", "2 flights".
    parts.push(journeyStopsLabel(journey, tripType).toLowerCase());
    lines.push(`${journey.label}: ${parts.join(" • ")}`);
  }
  for (const row of serviceDetailRows(order, formatEmailDay)) {
    if (FLIGHT_SUMMARY_ROWS.has(row.label)) {
      lines.push(`${row.label}: ${row.value}`);
    }
  }
  return lines;
}

/**
 * The money line(s). A flight labels each figure, in the order every flight
 * breakdown uses — Airline Charge (when there is one), Service Charge,
 * Total Booking Value, Amount Payable Now — because on an itinerary flight
 * the payment link collects only the service charge, so an unlabelled
 * "Amount" would read as the price of the trip. A flight created before
 * itineraries usually charged its whole fare, so its labels are the
 * neutral legacy set. Every other service keeps its historic line.
 */
function amountLines(order: OrderDTO): string[] {
  const currency = order.pricing.currency;
  if (serviceTypeOf(order) !== ServiceType.FLIGHT) {
    return [`Amount: ${order.pricing.amount.toFixed(2)} ${currency}`];
  }
  const { labels } = flightMoneyWording(order.flight, order.bookingType);
  const a = summarizeFlightAmounts(
    order.charges,
    order.flight?.airlineFare,
    order.pricing.amount,
  );
  const lines: string[] = [];
  if (showsAirlineCharge(a)) {
    lines.push(
      `${labels.airlineFare}: ${a.airlineFare.toFixed(2)} ${currency} (${labels.airlineFareNote.toLowerCase()})`,
    );
  }
  lines.push(`${labels.serviceCharge}: ${a.serviceCharge.toFixed(2)} ${currency}`);
  if (a.dueLater > 0) {
    lines.push(`${labels.dueLater}: ${a.dueLater.toFixed(2)} ${currency}`);
  }
  lines.push(
    `${labels.bookingTotal}: ${a.bookingTotal.toFixed(2)} ${currency}`,
    `${labels.payableNow}: ${order.pricing.amount.toFixed(2)} ${currency}`,
  );
  return lines;
}

/**
 * Build the mailto: URL used by the "Email us instead" fallback link in
 * the payment-request email. Prefills:
 *   - recipient (support@brand)
 *   - subject line tied to the order number
 *   - body: order facts + acknowledgement statement
 *
 * The customer's mail client opens with a draft ready to send — they
 * just hit "Send" to give us a paper trail.
 *
 * Why we keep it short: some clients (especially iOS Mail) truncate
 * mailto: bodies past ~1500 chars. Keep this under 600 chars.
 */
export function buildConsentMailto(args: {
  toEmail: string;
  brandName: string;
  order: OrderDTO;
  consentMessage: string;
}): string {
  const { order } = args;
  const subject = `Acknowledgement • Order ${order.orderNumber}`;
  const providerLabel = providerLabelFor(serviceTypeOf(order), "Provider");
  const lines = [
    `Hi ${args.brandName} team,`,
    "",
    args.consentMessage,
    "",
    `Customer: ${order.customer.name}`,
    `Order: ${order.orderNumber}`,
    `${providerLabel}: ${order.provider?.name ?? "—"}`,
    ...serviceLines(order),
    ...amountLines(order),
    order.payment.paymentUrl
      ? `Payment link: ${order.payment.paymentUrl}`
      : "",
    "",
    "Thank you,",
    order.customer.name,
  ].filter(Boolean);
  const body = lines.join("\n");
  return `mailto:${encodeURIComponent(args.toEmail)}?subject=${encodeURIComponent(
    subject,
  )}&body=${encodeURIComponent(body)}`;
}
