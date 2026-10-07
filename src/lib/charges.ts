/**
 * Charge breakdown — the SINGLE source of truth for the three figures the
 * rental flow cares about:
 *
 *   prepaid       → collected online via the initial payment link (this and
 *                   ONLY this is what the gateway is asked to charge).
 *   dueAtCounter  → collected by the rental counter at pick-up.
 *   total         → prepaid + dueAtCounter (the full rental cost).
 *
 * Every consumer (order service, DTO, admin UI, customer pages, emails,
 * evidence) derives these from `summarizeCharges` so they can never drift.
 * Pure + dependency-light on purpose: safe to import from client and server.
 */
import {
  BookingType,
  OrderStatus,
  PaymentCaptureStatus,
  PaymentTiming,
} from "@/lib/constants/enums";
import {
  type FlightItineraryInputLike,
  hasFlightItinerary,
} from "@/lib/flight-itinerary";
import type { OrderCharge } from "@/types";

export interface ChargeSummary {
  /** Normalised, cent-rounded copy of the input charges (legacy orders get a
   *  single synthesised prepaid line). */
  charges: OrderCharge[];
  /** Sum of PREPAID charge amounts — the online/Stripe amount. */
  prepaid: number;
  /** Sum of DUE_AT_COUNTER charge amounts. */
  dueAtCounter: number;
  /** prepaid + dueAtCounter. */
  total: number;
}

/** Round to 2dp, killing binary-float dust (0.1 + 0.2 → 0.3, not 0.30000004). */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

type ChargeLike = Pick<OrderCharge, "name" | "amount" | "timing">;

/**
 * Reduce a charge list to its prepaid / due-at-counter / total figures.
 *
 * Backward compatibility: orders created before the charges model exists
 * carry no `charges[]`. Passing `fallbackPrepaidAmount` (the legacy
 * `pricing.amount`) synthesises a single fully-prepaid "Rental cost" line so
 * every downstream consumer renders identically with zero migration.
 */
export function summarizeCharges(
  charges: ReadonlyArray<ChargeLike> | null | undefined,
  fallbackPrepaidAmount?: number | null,
): ChargeSummary {
  const list = (charges ?? []).filter(
    (c): c is ChargeLike => !!c && Number.isFinite(c.amount),
  );

  if (list.length === 0) {
    const amt = round2(Math.max(0, fallbackPrepaidAmount ?? 0));
    return {
      charges:
        amt > 0
          ? [{ name: "Rental cost", amount: amt, timing: PaymentTiming.PREPAID }]
          : [],
      prepaid: amt,
      dueAtCounter: 0,
      total: amt,
    };
  }

  let prepaid = 0;
  let dueAtCounter = 0;
  for (const c of list) {
    if (c.timing === PaymentTiming.DUE_AT_COUNTER) dueAtCounter += c.amount;
    else prepaid += c.amount;
  }
  prepaid = round2(prepaid);
  dueAtCounter = round2(dueAtCounter);

  return {
    charges: list.map((c) => ({
      name: c.name,
      amount: round2(c.amount),
      timing: c.timing,
    })),
    prepaid,
    dueAtCounter,
    total: round2(prepaid + dueAtCounter),
  };
}

/**
 * The four figures a FLIGHT shows its customer.
 *
 *   airlineFare   → the AIRLINE CHARGE (`flight.airlineFare`), the ticket
 *                   cost. Its own field on the flight, never a charge line,
 *                   so it can never reach `prepaid`, `pricing.amount` or
 *                   the gateway.
 *   serviceCharge → the operator's single charge line (PREPAID) — the only
 *                   money the payment link collects.
 *   payableNow    → what the payment link charges: the service charge.
 *   bookingTotal  → airline charge + service charge: the full booking value.
 *
 * `dueLater` exists only for flights created before flights became
 * prepaid-only, which could carry a "due later" line; it is 0 for every
 * new flight and is included in `bookingTotal` so an old receipt still adds
 * up.
 */
export interface FlightAmountSummary {
  charges: OrderCharge[];
  airlineFare: number;
  serviceCharge: number;
  payableNow: number;
  dueLater: number;
  bookingTotal: number;
}

/**
 * Customer-facing wording for the flight money breakdown — ONE copy source
 * for every page and email, so the same order can never be described three
 * different ways. Deliberately says what IS true (this payment covers the
 * service charge; the fare is not part of it) without asserting who
 * collects the fare.
 *
 * True of an ITINERARY flight only. Surfaces that show an existing order
 * read their labels through `flightMoneyWording(order.flight)`, never from
 * this object directly, so a flight created before itineraries gets
 * `LEGACY_FLIGHT_AMOUNT_LABELS`. (The create form, which only ever makes
 * itinerary flights, uses it as is.)
 */
export const FLIGHT_AMOUNT_LABELS = {
  airlineFare: "Airline Charge",
  airlineFareNote: "Not collected through this payment link",
  /** Shown under every breakdown that shows an Airline Charge row. */
  airlineFareExplainer:
    "Airline Charge is shown for the total booking value and is not collected through this payment link.",
  serviceCharge: "Service Charge",
  bookingTotal: "Total Booking Value",
  payableNow: "Amount Payable Now",
  paidNow: "Service Charge Paid",
  heldNow: "Service Charge On Hold",
  dueLater: "Remaining Balance Due Later",
  breakdownTitle: "Price breakdown",
  collectedOnline: "Collected online",
  notCollected: "Not collected yet",
  onHoldNotCollected: "On hold — not collected yet",
} as const;

/**
 * The name of a flight's one charge line. A flight has exactly one — its
 * service charge — whatever name a request sent (`flightOrderSchema`); the
 * airline charge is never a line.
 */
export const FLIGHT_SERVICE_CHARGE_LINE_NAME = "Service charge";

/**
 * Whether a flight's breakdown shows the Airline Charge row (and its
 * explainer): only for an airline charge above zero. A flight with none —
 * 0, or never recorded — shows service charge, booking value and the
 * amount payable, rather than an "Airline Charge $0.00" row.
 */
export function showsAirlineCharge(amounts: { airlineFare: number }): boolean {
  return amounts.airlineFare > 0;
}

/** One wording for the flight money slots: same keys as
 *  `FLIGHT_AMOUNT_LABELS`, whatever the copy. */
export type FlightAmountLabels = {
  readonly [K in keyof typeof FLIGHT_AMOUNT_LABELS]: string;
};

/**
 * Wording for a flight created BEFORE itineraries existed. Its charge lines
 * are whatever the old form collected — usually the WHOLE airline fare (that
 * form defaulted to a prepaid "Airfare" line) — so calling them a "service
 * charge", or saying the fare is charged separately, would misdescribe what
 * the customer actually paid. The same slots in neutral words; every key
 * that is true of any flight keeps its wording.
 */
export const LEGACY_FLIGHT_AMOUNT_LABELS: FlightAmountLabels = {
  ...FLIGHT_AMOUNT_LABELS,
  serviceCharge: "Charged Online",
  paidNow: "Amount Paid",
  heldNow: "Amount On Hold",
};

/** The label set for a flight: the service-charge wording when its charge
 *  lines are a service charge, the neutral legacy wording otherwise. */
export function flightAmountLabels(
  serviceChargeModel: boolean,
): FlightAmountLabels {
  return serviceChargeModel ? FLIGHT_AMOUNT_LABELS : LEGACY_FLIGHT_AMOUNT_LABELS;
}

export interface FlightMoneyWording {
  /** The labels every money row of this flight uses. */
  labels: FlightAmountLabels;
  /**
   * True when the flight's charge lines are the operator's SERVICE CHARGE
   * and the airline fare is not part of the payment — every new booking of
   * an itinerary flight. Every flight-only SENTENCE that names the service charge, or
   * says the fare is charged separately, is gated on it; a legacy flight
   * (false) gets the generic wording instead.
   */
  serviceChargeModel: boolean;
}

/**
 * How to describe a flight's money, decided once per order: a NEW BOOKING of
 * an itinerary flight (see `hasFlightItinerary`) is the service-charge model.
 * A flight created before itineraries is not, and neither is a modification
 * or cancellation charge — that money is a fee for the change, not the
 * service charge for arranging the booking, which is exactly how the
 * gateway line item names it. Pass the order's `flight` and `bookingType`,
 * or a consent record's frozen `snapshot.flight` / `snapshot.bookingType`
 * (a record without a frozen flight is legacy).
 */
export function flightMoneyWording(
  flight: FlightItineraryInputLike | null | undefined,
  bookingType: BookingType | null | undefined,
): FlightMoneyWording {
  const serviceChargeModel =
    hasFlightItinerary(flight) && bookingType === BookingType.NEW_BOOKING;
  return { labels: flightAmountLabels(serviceChargeModel), serviceChargeModel };
}

export function summarizeFlightAmounts(
  charges: ReadonlyArray<ChargeLike> | null | undefined,
  airlineFare: number | null | undefined,
  fallbackPrepaidAmount?: number | null,
): FlightAmountSummary {
  const summary = summarizeCharges(charges, fallbackPrepaidAmount);
  const fare =
    typeof airlineFare === "number" && Number.isFinite(airlineFare)
      ? round2(Math.max(0, airlineFare))
      : 0;
  return {
    charges: summary.charges,
    airlineFare: fare,
    serviceCharge: summary.prepaid,
    payableNow: summary.prepaid,
    dueLater: summary.dueAtCounter,
    bookingTotal: round2(fare + summary.prepaid + summary.dueAtCounter),
  };
}

export type FlightCollectionStatus = "COLLECTED" | "ON_HOLD" | "NOT_COLLECTED";

export interface FlightCollection {
  status: FlightCollectionStatus;
  /** Set only when COLLECTED. */
  amount: number | null;
}

/** Holds that still have the customer's money reserved. */
const LIVE_HOLD_STATUSES: ReadonlySet<string> = new Set([
  PaymentCaptureStatus.AUTHORIZED,
  PaymentCaptureStatus.CAPTURE_PENDING,
  PaymentCaptureStatus.CAPTURE_FAILED,
]);

/**
 * What a flight's payment link has ACTUALLY collected — the last row of the
 * operator and evidence money breakdowns. Money is collected only once the
 * order is PAID (on a manual capture, the amount captured). A hold still
 * reserving the card, a released or expired hold, and an unpaid, expired or
 * failed link have collected nothing — and say so, rather than repeating
 * the service charge as if it had been taken.
 */
export function flightCollection(order: {
  status: string;
  pricing: { amount: number };
  payment: {
    amountReceived?: number | null;
    capture?: { status?: string | null; amountCaptured?: number | null } | null;
  };
}): FlightCollection {
  if (order.status === OrderStatus.PAID) {
    return {
      status: "COLLECTED",
      amount:
        order.payment.capture?.amountCaptured ??
        order.payment.amountReceived ??
        order.pricing.amount,
    };
  }
  if (LIVE_HOLD_STATUSES.has(order.payment.capture?.status ?? "")) {
    return { status: "ON_HOLD", amount: null };
  }
  return { status: "NOT_COLLECTED", amount: null };
}

