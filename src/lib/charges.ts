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
  ServiceType,
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
 * A flight has exactly ONE charge line — the amount the payment link
 * collects — and the operator NAMES it (Service Charge, Processing Fee,
 * Rental Cost, Agency Fee…). That stored name is what every surface shows
 * for it. The airline charge is never a line and keeps its fixed label.
 *
 * The name a charge starts with, by booking type — what the create form
 * prefills and what a blank name is stored as. A new booking's charge is
 * the operator's service charge for arranging it; a modification or a
 * cancellation charge is a fee for the change, which calling a "service
 * charge" would misdescribe.
 */
export const DEFAULT_FLIGHT_CHARGE_NAMES: Readonly<Record<BookingType, string>> = {
  [BookingType.NEW_BOOKING]: "Service Charge",
  [BookingType.MODIFICATION]: "Modification Fee",
  [BookingType.CANCELLATION_CHARGE]: "Cancellation Charge",
};

/** A new booking's default charge name — and the name an itinerary new
 *  booking's charge goes by when nobody named it (`flightMoneyWording`). */
export const DEFAULT_FLIGHT_CHARGE_NAME =
  DEFAULT_FLIGHT_CHARGE_NAMES[BookingType.NEW_BOOKING];

/** The default charge name for a booking type (a new booking's when the
 *  type is unknown). */
export function defaultFlightChargeName(
  bookingType: BookingType | null | undefined,
): string {
  return (
    (bookingType ? DEFAULT_FLIGHT_CHARGE_NAMES[bookingType] : undefined) ??
    DEFAULT_FLIGHT_CHARGE_NAME
  );
}

/** Whether a charge name is still a default (or blank) — one the create
 *  form may swap when the booking type changes, unlike a name the operator
 *  typed. */
export function isDefaultFlightChargeName(
  name: string | null | undefined,
): boolean {
  const trimmed = name?.trim() ?? "";
  return (
    trimmed === "" ||
    Object.values(DEFAULT_FLIGHT_CHARGE_NAMES).includes(trimmed)
  );
}

/**
 * What every flight line was stored as before operators named the charge:
 * the old form's default, then a name the server forced onto every line,
 * whatever its booking type. A line still called exactly this was never
 * named by an operator, so its order keeps the wording it was sent with
 * (see `flightMoneyWording`). A new order never stores it — the schema
 * stores `DEFAULT_FLIGHT_CHARGE_NAME` in its place.
 */
export const LEGACY_FLIGHT_CHARGE_NAME = "Service charge";

/**
 * An operator's charge name as it is stored: trimmed, with the pre-naming
 * marker turned into the default it stood for. Blank stays "" — the order
 * then takes its booking type's default (`defaultFlightChargeName`).
 */
export function normaliseFlightChargeName(
  name: string | null | undefined,
): string {
  const trimmed = name?.trim() ?? "";
  return trimmed === LEGACY_FLIGHT_CHARGE_NAME
    ? DEFAULT_FLIGHT_CHARGE_NAME
    : trimmed;
}

/**
 * Names that mean the AIRLINE's amount — the fare, the ticket, its cost —
 * refused as the name of the charge the payment link collects, so the
 * airline charge can never be entered (or presented) as the collected line.
 * Whole names only, ignoring a trailing qualifier ("Airline Charge (USD)")
 * or full stop: "Ticketing Fee" or "Airline Booking Fee" are the operator's
 * own charges and stay allowed.
 */
export function isAirlineChargeName(name: string): boolean {
  const bare = name
    .trim()
    .replace(/\s*\([^)]*\)$/, "")
    .replace(/[\s.,:;!]+$/, "");
  return /^(?:(?:airline|air|flight)[\s-]*(?:ticket[\s-]*)?(?:charge|fare|ticket|cost|price|amount)s?|airline[\s-]*fees?|(?:base[\s-]*|total[\s-]*)?fares?(?:[\s-]*(?:charge|amount)s?)?|tickets?(?:[\s-]*(?:fare|price|cost|charge|amount)s?)?)$/i.test(
    bare,
  );
}

/**
 * The name the OPERATOR gave a flight's collected charge: its one charge
 * line's stored name. Null when nobody named it — no single line, a blank
 * name, the pre-naming `LEGACY_FLIGHT_CHARGE_NAME` — or when it names the
 * airline's amount, which no form accepts (an order written before that
 * rule keeps the wording it was sent with).
 */
export function namedFlightCharge(
  charges: ReadonlyArray<{ name?: string | null }> | null | undefined,
): string | null {
  if (charges?.length !== 1) return null;
  const name = charges[0]?.name?.trim() ?? "";
  return name && name !== LEGACY_FLIGHT_CHARGE_NAME && !isAirlineChargeName(name)
    ? name
    : null;
}

/** The name a flight's collected charge goes by: the operator's
 *  (`namedFlightCharge`), else its booking type's default — what the schema
 *  stores for a blank name, so the create form's live summary (which passes
 *  the name being typed, `normaliseFlightChargeName`d) shows what will be
 *  saved. */
export function flightChargeName(
  charges: ReadonlyArray<{ name?: string | null }> | null | undefined,
  bookingType?: BookingType | null,
): string {
  return namedFlightCharge(charges) ?? defaultFlightChargeName(bookingType);
}

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

/**
 * The labels for an itinerary flight's money, with its OWN charge name in
 * every slot that names the collected charge: the charge row, and what was
 * paid or put on hold. Everything else keeps its fixed wording — the
 * Airline Charge label above all, which is never the operator's to rename.
 */
export function flightLabelsWithCharge(chargeName: string): FlightAmountLabels {
  return {
    ...FLIGHT_AMOUNT_LABELS,
    serviceCharge: chargeName,
    paidNow: `${chargeName} Paid`,
    heldNow: `${chargeName} On Hold`,
  };
}

/** The label set for a flight's collected charge: its name in every slot
 *  that names it, or — with no name — the neutral legacy wording. */
export function flightAmountLabels(
  chargeName: string | null | undefined,
): FlightAmountLabels {
  return chargeName
    ? flightLabelsWithCharge(chargeName)
    : LEGACY_FLIGHT_AMOUNT_LABELS;
}

export interface FlightMoneyWording {
  /** The labels every money row of this flight uses. */
  labels: FlightAmountLabels;
  /**
   * True for a NEW BOOKING of an itinerary flight: its one charge line is
   * the operator's charge for arranging the booking and the airline charge
   * is not part of the payment. Every flight-only SENTENCE that names the
   * charge, or says the airline charge is not collected, is gated on it; a
   * legacy flight, or a modification / cancellation charge, gets the
   * generic sentences instead (its LABELS still carry its charge's name).
   */
  serviceChargeModel: boolean;
  /**
   * What the collected charge is called on this flight — the label of its
   * charge row and the word every gated sentence uses. Empty when the
   * flight's money is worded neutrally (never with `serviceChargeModel`).
   */
  chargeName: string;
}

/**
 * How to describe a flight's money, decided once per order.
 *
 * An itinerary flight (see `hasFlightItinerary`) whose one charge line the
 * OPERATOR named shows that name — any booking type — wherever the
 * collected amount is labelled. One created before operators named the
 * charge (`namedFlightCharge` is null) keeps what it was sent with: a new
 * booking's line is the "Service Charge"; a modification or cancellation
 * charge is worded neutrally. A flight created before itineraries is
 * neutral too: its lines were usually the whole fare. Pass the order's
 * `flight`, `bookingType` and `charges`, or a consent record's frozen
 * `snapshot.flight` / `snapshot.bookingType` / `snapshot.charges` (a record
 * without a frozen flight is legacy).
 */
export function flightMoneyWording(
  flight: FlightItineraryInputLike | null | undefined,
  bookingType: BookingType | null | undefined,
  charges?: ReadonlyArray<{ name?: string | null }> | null,
): FlightMoneyWording {
  const hasItinerary = hasFlightItinerary(flight);
  const serviceChargeModel =
    hasItinerary && bookingType === BookingType.NEW_BOOKING;
  const chargeName =
    (hasItinerary ? namedFlightCharge(charges) : null) ??
    (serviceChargeModel ? DEFAULT_FLIGHT_CHARGE_NAME : "");
  return {
    labels: flightAmountLabels(chargeName),
    serviceChargeModel,
    chargeName,
  };
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

/* ─────────── Charge-block wording, per service (emails + operator screens) ─────────── */

/**
 * The four wording slots that used to be hardcoded rental copy.
 *
 * Every one of them DEFAULTS to the exact string this component emitted
 * before service types existed, so a caller that passes none renders
 * byte-identically — which is what both incumbent brands do.
 */
export interface ChargeWording {
  /** Label on the prepaid total row. */
  prepaidLabel?: string;
  /** Label on the due-later total row. */
  dueLabel?: string;
  /** Label on the grand-total row. */
  totalLabel?: string;
  /** Parenthetical appended to a DUE_AT_COUNTER line item. */
  dueSuffix?: string;
}

/** The literals this component shipped with. Named so the defaults are
 *  visible at a glance and can never drift apart from the prop defaults. */
export const RENTAL_CHARGE_WORDING: Required<ChargeWording> = {
  prepaidLabel: "Amount paid online",
  dueLabel: "Amount due at counter",
  totalLabel: "Total rental cost",
  dueSuffix: "(due at counter)",
};

/**
 * FLIGHT wording. A flight is prepaid-only and its airline fare is never a
 * charge line, so nothing is ever "due at the airport". Real flight sends
 * render `FlightChargeBreakdown` (fare / service charge / booking value)
 * instead of this block; this covers a flight rendered without that split,
 * and the "due later" line a flight created before prepaid-only can carry.
 *
 * Neutral on purpose: without the split there is no telling an itinerary
 * flight's service charge from a legacy flight's whole fare, so the prepaid
 * row uses the legacy label ("Charged online"), true of both.
 */
export const FLIGHT_CHARGE_WORDING: Required<ChargeWording> = {
  prepaidLabel: LEGACY_FLIGHT_AMOUNT_LABELS.serviceCharge,
  dueLabel: LEGACY_FLIGHT_AMOUNT_LABELS.dueLater,
  totalLabel: "Total charges",
  dueSuffix: "(due later)",
};

/** HOTEL wording: the balance is settled at the property, never "at the
 *  counter". */
export const HOTEL_CHARGE_WORDING: Required<ChargeWording> = {
  prepaidLabel: "Amount paid online",
  dueLabel: "Amount due at the property",
  totalLabel: "Total hotel cost",
  dueSuffix: "(due at the property)",
};

/**
 * Service-appropriate wording for the charge block.
 *
 * CAR_RENTAL returns `RENTAL_CHARGE_WORDING` — the incumbents' strings,
 * unchanged. A flight has no counter and a hotel has no counter either;
 * saying "due at counter" to a FlightBizz customer is the kind of copy bug
 * that gets read as a different company's email.
 */
export function chargeWordingFor(
  serviceType: ServiceType,
): Required<ChargeWording> {
  switch (serviceType) {
    case ServiceType.FLIGHT:
      return FLIGHT_CHARGE_WORDING;
    case ServiceType.HOTEL:
      return HOTEL_CHARGE_WORDING;
    case ServiceType.CAR_RENTAL:
    default:
      return RENTAL_CHARGE_WORDING;
  }
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

