import { describe, expect, it } from "vitest";

import {
  FLIGHT_AMOUNT_LABELS,
  flightAmountLabels,
  flightCollection,
  flightMoneyWording,
  LEGACY_FLIGHT_AMOUNT_LABELS,
} from "@/lib/charges";
import {
  BookingType,
  FlightTripType,
  OrderStatus,
  PaymentCaptureStatus,
} from "@/lib/constants/enums";
import {
  oneWayConnectingFlightInput,
  roundTripFlightInput,
} from "@/tests/fixtures/order-input.fixture";

/**
 * The flight money COPY — one source for every page and email.
 *
 * Two wordings, decided from the flight and its booking type:
 *
 *   - a NEW BOOKING of an ITINERARY flight: its charge lines are the
 *     operator's service charge and the airline fare is not part of the
 *     payment, so its labels say so;
 *   - a flight created BEFORE itineraries usually charged its whole fare
 *     online (the old form defaulted to a prepaid "Airfare" line), and a
 *     modification or cancellation charge is not a service charge either —
 *     calling those a "service charge" would misdescribe what the customer
 *     paid, so their labels are neutral.
 *
 * The strings are pinned verbatim: they are the client's copy, and every
 * surface reads them from here, so a change here IS a change on every page.
 */

describe("FLIGHT_AMOUNT_LABELS — the itinerary-flight copy", () => {
  it("carries exactly the client-approved wording", () => {
    expect(FLIGHT_AMOUNT_LABELS).toMatchObject({
      airlineFare: "Airline Charge",
      airlineFareNote: "Not collected through this payment link",
      airlineFareExplainer:
        "Airline Charge is shown for the total booking value and is not collected through this payment link.",
      serviceCharge: "Service Charge",
      bookingTotal: "Total Booking Value",
      payableNow: "Amount Payable Now",
      paidNow: "Service Charge Paid",
      heldNow: "Service Charge On Hold",
      dueLater: "Remaining Balance Due Later",
      breakdownTitle: "Price breakdown",
    });
  });

  it("says what was actually collected — and never claims money that was not taken", () => {
    expect(FLIGHT_AMOUNT_LABELS.collectedOnline).toBe("Collected online");
    expect(FLIGHT_AMOUNT_LABELS.notCollected.toLowerCase()).toContain("not collected");
    expect(FLIGHT_AMOUNT_LABELS.onHoldNotCollected.toLowerCase()).toContain("on hold");
    expect(FLIGHT_AMOUNT_LABELS.onHoldNotCollected.toLowerCase()).toContain("not collected");
  });
});

describe("LEGACY_FLIGHT_AMOUNT_LABELS — the pre-itinerary copy", () => {
  it("has the same slots as the itinerary wording", () => {
    expect(Object.keys(LEGACY_FLIGHT_AMOUNT_LABELS).sort()).toEqual(
      Object.keys(FLIGHT_AMOUNT_LABELS).sort(),
    );
  });

  it("words the money neutrally — what was charged, paid or held, not a 'service charge'", () => {
    expect(LEGACY_FLIGHT_AMOUNT_LABELS.serviceCharge).toBe("Charged Online");
    expect(LEGACY_FLIGHT_AMOUNT_LABELS.paidNow).toBe("Amount Paid");
    expect(LEGACY_FLIGHT_AMOUNT_LABELS.heldNow).toBe("Amount On Hold");
    for (const label of Object.values(LEGACY_FLIGHT_AMOUNT_LABELS)) {
      expect(label.toLowerCase()).not.toContain("service charge");
    }
  });

  it("keeps every label that is true of ANY flight", () => {
    for (const key of [
      "airlineFare",
      "airlineFareNote",
      "airlineFareExplainer",
      "bookingTotal",
      "payableNow",
      "dueLater",
      "breakdownTitle",
      "collectedOnline",
      "notCollected",
      "onHoldNotCollected",
    ] as const) {
      expect(LEGACY_FLIGHT_AMOUNT_LABELS[key]).toBe(FLIGHT_AMOUNT_LABELS[key]);
    }
  });

  it("never uses rental or airport-desk vocabulary in either wording", () => {
    for (const labels of [FLIGHT_AMOUNT_LABELS, LEGACY_FLIGHT_AMOUNT_LABELS]) {
      for (const label of Object.values(labels)) {
        const lower = label.toLowerCase();
        for (const banned of ["counter", "rental", "pick-up", "vehicle", "airport"]) {
          expect(lower).not.toContain(banned);
        }
      }
    }
  });
});

describe("flightAmountLabels", () => {
  it("picks the service-charge wording for the service-charge model", () => {
    expect(flightAmountLabels(true)).toBe(FLIGHT_AMOUNT_LABELS);
  });

  it("picks the neutral wording otherwise", () => {
    expect(flightAmountLabels(false)).toBe(LEGACY_FLIGHT_AMOUNT_LABELS);
  });
});

describe("flightMoneyWording — decided once, from the flight and its booking type", () => {
  const NEW = BookingType.NEW_BOOKING;

  it("treats a NEW BOOKING of an itinerary flight as the service-charge model", () => {
    for (const flight of [
      oneWayConnectingFlightInput().flight,
      roundTripFlightInput().flight,
    ]) {
      expect(flightMoneyWording(flight, NEW)).toEqual({
        labels: FLIGHT_AMOUNT_LABELS,
        serviceChargeModel: true,
      });
    }
  });

  it("words a modification or a cancellation charge neutrally, even on an itinerary flight", () => {
    for (const bookingType of [
      BookingType.MODIFICATION,
      BookingType.CANCELLATION_CHARGE,
    ]) {
      expect(flightMoneyWording(roundTripFlightInput().flight, bookingType)).toEqual({
        labels: LEGACY_FLIGHT_AMOUNT_LABELS,
        serviceChargeModel: false,
      });
    }
  });

  it("never assumes a new booking when the booking type is unknown", () => {
    expect(
      flightMoneyWording(roundTripFlightInput().flight, undefined).serviceChargeModel,
    ).toBe(false);
    expect(
      flightMoneyWording(roundTripFlightInput().flight, null).serviceChargeModel,
    ).toBe(false);
  });

  it("treats a legacy flat-field flight as NOT the service-charge model", () => {
    const legacy = {
      tripType: FlightTripType.ONE_WAY,
      origin: "LHR",
      destination: "JFK",
      outbound: null,
      return: null,
    };
    expect(flightMoneyWording(legacy, NEW)).toEqual({
      labels: LEGACY_FLIGHT_AMOUNT_LABELS,
      serviceChargeModel: false,
    });
    // A legacy document as it is actually stored: no `outbound` key at all.
    expect(
      flightMoneyWording({ tripType: "ONE_WAY" } as never, NEW).serviceChargeModel,
    ).toBe(false);
  });

  it("reads a consent record's frozen snapshot the same way", () => {
    // A record frozen from an itinerary flight …
    expect(
      flightMoneyWording(
        {
          tripType: FlightTripType.ROUND_TRIP,
          outbound: roundTripFlightInput().flight.outbound,
          return: roundTripFlightInput().flight.return,
        },
        NEW,
      ).serviceChargeModel,
    ).toBe(true);
    // … and one frozen before itineraries, which carries no outbound.
    expect(flightMoneyWording(null, NEW).serviceChargeModel).toBe(false);
    expect(flightMoneyWording(undefined, NEW).labels).toBe(LEGACY_FLIGHT_AMOUNT_LABELS);
  });

  it("is not fooled by an empty outbound journey", () => {
    expect(
      flightMoneyWording({ outbound: { segments: [] } }, NEW).serviceChargeModel,
    ).toBe(false);
  });
});

describe("flightCollection — what the payment link has ACTUALLY collected", () => {
  const order = (
    status: string,
    payment: {
      amountReceived?: number | null;
      capture?: { status?: string | null; amountCaptured?: number | null } | null;
    } = {},
  ) => ({ status, pricing: { amount: 100 }, payment });

  it("counts money as collected only once the order is PAID", () => {
    expect(flightCollection(order(OrderStatus.PAID, { amountReceived: 100 }))).toEqual({
      status: "COLLECTED",
      amount: 100,
    });
    // A manual capture collects what was captured; a bare PAID row falls
    // back to the order amount.
    expect(
      flightCollection(
        order(OrderStatus.PAID, {
          amountReceived: 100,
          capture: { status: PaymentCaptureStatus.CAPTURED, amountCaptured: 80 },
        }),
      ).amount,
    ).toBe(80);
    expect(flightCollection(order(OrderStatus.PAID)).amount).toBe(100);
  });

  it("reports a live hold as on hold — nothing taken yet", () => {
    for (const status of [
      PaymentCaptureStatus.AUTHORIZED,
      PaymentCaptureStatus.CAPTURE_PENDING,
      PaymentCaptureStatus.CAPTURE_FAILED,
    ]) {
      expect(
        flightCollection(order(OrderStatus.PAYMENT_PENDING, { capture: { status } })),
      ).toEqual({ status: "ON_HOLD", amount: null });
    }
  });

  it("reports an unpaid link, or a released hold, as not collected", () => {
    for (const status of [
      OrderStatus.NOT_INITIATED,
      OrderStatus.LINK_GENERATED,
      OrderStatus.PAYMENT_PENDING,
      OrderStatus.EXPIRED,
      OrderStatus.FAILED,
    ]) {
      expect(flightCollection(order(status))).toEqual({
        status: "NOT_COLLECTED",
        amount: null,
      });
    }
    expect(
      flightCollection(
        order(OrderStatus.PAYMENT_PENDING, {
          capture: { status: PaymentCaptureStatus.CANCELLED },
        }),
      ),
    ).toEqual({ status: "NOT_COLLECTED", amount: null });
  });
});
