import { describe, expect, it } from "vitest";

import {
  DEFAULT_FLIGHT_CHARGE_NAME,
  DEFAULT_FLIGHT_CHARGE_NAMES,
  defaultFlightChargeName,
  FLIGHT_AMOUNT_LABELS,
  flightAmountLabels,
  flightChargeName,
  flightCollection,
  flightLabelsWithCharge,
  flightMoneyWording,
  isAirlineChargeName,
  isDefaultFlightChargeName,
  LEGACY_FLIGHT_AMOUNT_LABELS,
  LEGACY_FLIGHT_CHARGE_NAME,
  namedFlightCharge,
  normaliseFlightChargeName,
  summarizeFlightAmounts,
} from "@/lib/charges";
import {
  BookingType,
  FlightTripType,
  OrderStatus,
  PaymentCaptureStatus,
  PaymentTiming,
} from "@/lib/constants/enums";
import {
  flightServiceCharge,
  oneWayConnectingFlightInput,
  roundTripFlightInput,
  validFlightOrderInput,
} from "@/tests/fixtures/order-input.fixture";
import type { OrderCharge } from "@/types";

/**
 * The flight money COPY — one source for every page and email.
 *
 * A flight's payment link collects ONE charge line, and the OPERATOR names
 * it ("Service Charge", "Processing Fee", "Rental Cost", "Agency Fee"…).
 * That stored name (`order.charges[0].name`) is what the customer reads
 * wherever the collected amount is labelled. The Airline Charge is a
 * separate figure with a fixed label: never collected, never renamed.
 *
 * The wording is decided once per order, from the flight, its booking type
 * and its charge line:
 *
 *   - an ITINERARY flight whose line the operator named shows that name in
 *     every slot that names the collected charge, whatever the booking type;
 *   - one whose line was never named (it still carries the pre-naming
 *     "Service charge") keeps what it was sent with: a NEW BOOKING's line is
 *     the "Service Charge"; a modification or cancellation charge is worded
 *     neutrally;
 *   - a flight created BEFORE itineraries usually charged its whole fare
 *     online (the old form defaulted to a prepaid "Airfare" line), so its
 *     labels are neutral whatever its line is called.
 *
 * The SENTENCES that name the charge (`serviceChargeModel`) stay gated on a
 * NEW BOOKING of an itinerary flight.
 *
 * The fixed strings are pinned verbatim: they are the client's copy, and
 * every surface reads them from here, so a change here IS a change on every
 * page.
 */

/** The three slots that name the collected charge — the only ones an
 *  operator's charge name ever changes. */
const NAMED_SLOTS = ["serviceCharge", "paidNow", "heldNow"] as const;

/** Charge names an operator might give the collected amount. */
const OPERATOR_NAMES = ["Rental Cost", "Processing Fee", "Agency Fee"] as const;

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

describe("namedFlightCharge / flightChargeName — the operator's name for the collected charge", () => {
  it("pins the default name and the pre-naming marker", () => {
    // What a blank name is stored and shown as …
    expect(DEFAULT_FLIGHT_CHARGE_NAME).toBe("Service Charge");
    // … and what every flight line was stored as before operators named
    // the charge (lower-case "c"): the mark of a line nobody named.
    expect(LEGACY_FLIGHT_CHARGE_NAME).toBe("Service charge");
  });

  it.each([
    ["Rental Cost", "Rental Cost"],
    ["Processing Fee", "Processing Fee"],
    ["Agency Fee", "Agency Fee"],
    ["  Service Fee  ", "Service Fee"],
    // The default IS a name: it is what a new order stores for a blank one.
    ["Service Charge", "Service Charge"],
    // Only the exact pre-naming marker is special — any other casing of
    // "service charge" is a name an operator typed.
    ["service charge", "service charge"],
    ["SERVICE CHARGE", "SERVICE CHARGE"],
  ])("a single line named %j goes by %j", (stored, expected) => {
    expect(namedFlightCharge([{ name: stored }])).toBe(expected);
    expect(flightChargeName([{ name: stored }])).toBe(expected);
  });

  it("is null for a line nobody named — whose name falls back to the default", () => {
    const unnamed: ReadonlyArray<{ name?: string | null }>[] = [
      [{ name: "" }],
      [{ name: "   " }],
      [{ name: null }],
      [{ name: undefined }],
      [{}],
      [{ name: "Service charge" }],
      [{ name: "  Service charge  " }],
    ];
    for (const charges of unnamed) {
      expect(namedFlightCharge(charges), JSON.stringify(charges)).toBeNull();
      expect(flightChargeName(charges), JSON.stringify(charges)).toBe("Service Charge");
    }
  });

  it("is null unless there is exactly one line", () => {
    for (const charges of [
      null,
      undefined,
      [],
      [{ name: "Processing Fee" }, { name: "Agency Fee" }],
      [{ name: "Rental Cost" }, { name: "Rental Cost" }],
    ]) {
      expect(namedFlightCharge(charges), JSON.stringify(charges)).toBeNull();
      expect(flightChargeName(charges), JSON.stringify(charges)).toBe("Service Charge");
    }
  });

  it("reads the charge line exactly as an order carries it", () => {
    expect(namedFlightCharge(flightServiceCharge(100, "Processing Fee"))).toBe(
      "Processing Fee",
    );
    expect(
      flightChargeName(
        validFlightOrderInput({ charges: flightServiceCharge(100, "Rental Cost") }).charges,
      ),
    ).toBe("Rental Cost");
  });
});

describe("flightLabelsWithCharge — the operator's name in every slot that names the charge", () => {
  it.each(OPERATOR_NAMES)(
    "%s names the charge row, what was paid and what is on hold",
    (name) => {
      const labels = flightLabelsWithCharge(name);
      expect(labels.serviceCharge).toBe(name);
      expect(labels.paidNow).toBe(`${name} Paid`);
      expect(labels.heldNow).toBe(`${name} On Hold`);
      // The Airline Charge keeps its fixed label — never the operator's to
      // rename.
      expect(labels.airlineFare).toBe("Airline Charge");
      expect(labels.airlineFareNote).toBe("Not collected through this payment link");
      // Once the operator named it otherwise, "Service Charge" is gone.
      for (const label of Object.values(labels)) {
        expect(label.toLowerCase()).not.toContain("service charge");
      }
    },
  );

  it("keeps every other slot exactly as the itinerary-flight copy", () => {
    for (const name of OPERATOR_NAMES) {
      const labels = flightLabelsWithCharge(name);
      expect(Object.keys(labels).sort()).toEqual(Object.keys(FLIGHT_AMOUNT_LABELS).sort());
      for (const key of Object.keys(FLIGHT_AMOUNT_LABELS) as Array<
        keyof typeof FLIGHT_AMOUNT_LABELS
      >) {
        if ((NAMED_SLOTS as readonly string[]).includes(key)) continue;
        expect(labels[key], key).toBe(FLIGHT_AMOUNT_LABELS[key]);
      }
    }
  });

  it("with the default name, is exactly the itinerary-flight copy", () => {
    expect(flightLabelsWithCharge(DEFAULT_FLIGHT_CHARGE_NAME)).toEqual(FLIGHT_AMOUNT_LABELS);
  });

  it("never rewrites the shared copy", () => {
    flightLabelsWithCharge("Rental Cost");
    flightAmountLabels("Processing Fee");
    expect(FLIGHT_AMOUNT_LABELS.serviceCharge).toBe("Service Charge");
    expect(FLIGHT_AMOUNT_LABELS.paidNow).toBe("Service Charge Paid");
    expect(FLIGHT_AMOUNT_LABELS.heldNow).toBe("Service Charge On Hold");
    expect(LEGACY_FLIGHT_AMOUNT_LABELS.serviceCharge).toBe("Charged Online");
  });
});

describe("flightAmountLabels — the label set for a charge's name", () => {
  it("puts the name in every slot that names the collected charge", () => {
    for (const name of OPERATOR_NAMES) {
      expect(flightAmountLabels(name)).toEqual(flightLabelsWithCharge(name));
      expect(flightAmountLabels(name)).toMatchObject({
        serviceCharge: name,
        paidNow: `${name} Paid`,
        heldNow: `${name} On Hold`,
        airlineFare: "Airline Charge",
      });
    }
  });

  it("gives the default name the itinerary-flight copy", () => {
    expect(flightAmountLabels("Service Charge")).toEqual(FLIGHT_AMOUNT_LABELS);
  });

  it("picks the neutral wording when there is no name", () => {
    for (const none of ["", null, undefined]) {
      expect(flightAmountLabels(none)).toBe(LEGACY_FLIGHT_AMOUNT_LABELS);
    }
  });
});

describe("flightMoneyWording — decided once, from the flight, its booking type and its charge", () => {
  const NEW = BookingType.NEW_BOOKING;
  const itineraryFlights = () => [
    oneWayConnectingFlightInput().flight,
    roundTripFlightInput().flight,
  ];

  it("treats a NEW BOOKING of an itinerary flight as the service-charge model", () => {
    // No charges passed, or a line still carrying the pre-naming "Service
    // charge": the Service Charge it was sent with.
    for (const flight of itineraryFlights()) {
      for (const charges of [
        undefined,
        null,
        flightServiceCharge(100, LEGACY_FLIGHT_CHARGE_NAME),
        flightServiceCharge(100, DEFAULT_FLIGHT_CHARGE_NAME),
      ]) {
        expect(flightMoneyWording(flight, NEW, charges)).toEqual({
          labels: FLIGHT_AMOUNT_LABELS,
          serviceChargeModel: true,
          chargeName: "Service Charge",
        });
      }
    }
  });

  it.each(OPERATOR_NAMES)(
    "a NEW BOOKING whose charge the operator named %j shows that name — no 'Service Charge' anywhere",
    (name) => {
      for (const flight of itineraryFlights()) {
        const wording = flightMoneyWording(flight, NEW, flightServiceCharge(100, name));
        expect(wording).toEqual({
          labels: flightLabelsWithCharge(name),
          serviceChargeModel: true,
          chargeName: name,
        });
        expect(wording.labels).toMatchObject({
          airlineFare: "Airline Charge",
          serviceCharge: name,
          bookingTotal: "Total Booking Value",
          payableNow: "Amount Payable Now",
          paidNow: `${name} Paid`,
          heldNow: `${name} On Hold`,
        });
        for (const label of Object.values(wording.labels)) {
          expect(label.toLowerCase()).not.toContain("service charge");
        }
      }
    },
  );

  it.each(OPERATOR_NAMES)(
    "the customer's breakdown for %j reads Airline Charge / the name / Total Booking Value / Amount Payable Now",
    (name) => {
      const order = validFlightOrderInput(
        { charges: flightServiceCharge(100, name) },
        { airlineFare: 400 },
      );
      const { labels } = flightMoneyWording(order.flight, order.bookingType, order.charges);
      const amounts = summarizeFlightAmounts(order.charges, order.flight.airlineFare);
      expect([
        [labels.airlineFare, amounts.airlineFare],
        [labels.serviceCharge, amounts.serviceCharge],
        [labels.bookingTotal, amounts.bookingTotal],
        [labels.payableNow, amounts.payableNow],
      ]).toEqual([
        ["Airline Charge", 400],
        [name, 100],
        ["Total Booking Value", 500],
        ["Amount Payable Now", 100],
      ]);
    },
  );

  it("takes the name from the charge line only — never the airline, the booking reference or the customer", () => {
    const order = roundTripFlightInput({ charges: flightServiceCharge(95, "Agency Fee") });
    const named = flightMoneyWording(order.flight, order.bookingType, order.charges);
    const unnamed = flightMoneyWording(
      order.flight,
      order.bookingType,
      flightServiceCharge(95, LEGACY_FLIGHT_CHARGE_NAME),
    );
    expect(named.chargeName).toBe("Agency Fee");
    expect(unnamed.chargeName).toBe("Service Charge");

    const elsewhere = [
      order.customer.name,
      order.flight.pnr,
      ...[...order.flight.outbound.segments, ...(order.flight.return?.segments ?? [])].flatMap(
        (s) => [s.airline, s.flightNumber],
      ),
    ].filter((v): v is string => !!v);
    expect(elsewhere).toEqual(
      expect.arrayContaining(["Grace Hopper", "ABC123", "Air India", "IndiGo"]),
    );
    for (const wording of [named, unnamed]) {
      for (const label of Object.values(wording.labels)) {
        for (const value of elsewhere) expect(label).not.toContain(value);
      }
    }
  });

  it("words an UNNAMED modification or cancellation charge neutrally, even on an itinerary flight", () => {
    for (const bookingType of [
      BookingType.MODIFICATION,
      BookingType.CANCELLATION_CHARGE,
    ]) {
      for (const charges of [undefined, flightServiceCharge(60, LEGACY_FLIGHT_CHARGE_NAME)]) {
        expect(
          flightMoneyWording(roundTripFlightInput().flight, bookingType, charges),
        ).toEqual({
          labels: LEGACY_FLIGHT_AMOUNT_LABELS,
          serviceChargeModel: false,
          chargeName: "",
        });
      }
    }
  });

  it("labels a NAMED modification or cancellation charge with its name — but keeps the sentences neutral", () => {
    for (const [bookingType, name] of [
      [BookingType.MODIFICATION, "Change Fee"],
      [BookingType.CANCELLATION_CHARGE, "Cancellation Fee"],
      [BookingType.MODIFICATION, "Processing Fee"],
      // A new order always stores a name (a blank one as the default), so a
      // modification created now and left at the default shows it, exactly
      // as the create form showed it.
      [BookingType.MODIFICATION, DEFAULT_FLIGHT_CHARGE_NAME],
    ] as const) {
      const wording = flightMoneyWording(
        roundTripFlightInput().flight,
        bookingType,
        flightServiceCharge(60, name),
      );
      expect(wording).toEqual({
        labels: flightLabelsWithCharge(name),
        serviceChargeModel: false,
        chargeName: name,
      });
      expect(wording.labels.serviceCharge).toBe(name);
      expect(wording.labels.paidNow).toBe(`${name} Paid`);
      expect(wording.labels.airlineFare).toBe("Airline Charge");
    }
  });

  it("never assumes a new booking when the booking type is unknown", () => {
    for (const bookingType of [undefined, null]) {
      expect(
        flightMoneyWording(roundTripFlightInput().flight, bookingType),
      ).toEqual({
        labels: LEGACY_FLIGHT_AMOUNT_LABELS,
        serviceChargeModel: false,
        chargeName: "",
      });
      // A named charge is still labelled with its name; the sentences stay
      // neutral.
      expect(
        flightMoneyWording(
          roundTripFlightInput().flight,
          bookingType,
          flightServiceCharge(95, "Processing Fee"),
        ),
      ).toEqual({
        labels: flightLabelsWithCharge("Processing Fee"),
        serviceChargeModel: false,
        chargeName: "Processing Fee",
      });
    }
  });

  it("keeps the Service Charge wording for an itinerary new booking stored with more than one line", () => {
    // Written before the one-line rule: no single line names the charge.
    const twoLines: OrderCharge[] = [
      { name: "Processing Fee", amount: 60, timing: PaymentTiming.PREPAID },
      { name: "Agency Fee", amount: 35, timing: PaymentTiming.PREPAID },
    ];
    expect(flightMoneyWording(roundTripFlightInput().flight, NEW, twoLines)).toEqual({
      labels: FLIGHT_AMOUNT_LABELS,
      serviceChargeModel: true,
      chargeName: "Service Charge",
    });
  });

  it("treats a legacy flat-field flight as NOT the service-charge model — whatever its line is called", () => {
    const legacy = {
      tripType: FlightTripType.ONE_WAY,
      origin: "LHR",
      destination: "JFK",
      outbound: null,
      return: null,
    };
    for (const charges of [
      undefined,
      flightServiceCharge(100, LEGACY_FLIGHT_CHARGE_NAME),
      // The old form's default line: usually the WHOLE fare.
      flightServiceCharge(500, "Airfare"),
      // Even a name an operator could give today.
      flightServiceCharge(100, "Processing Fee"),
    ]) {
      expect(flightMoneyWording(legacy, NEW, charges)).toEqual({
        labels: LEGACY_FLIGHT_AMOUNT_LABELS,
        serviceChargeModel: false,
        chargeName: "",
      });
    }
    // A legacy document as it is actually stored: no `outbound` key at all.
    expect(
      flightMoneyWording({ tripType: "ONE_WAY" } as never, NEW).serviceChargeModel,
    ).toBe(false);
    expect(
      flightMoneyWording(
        { tripType: "ONE_WAY" } as never,
        NEW,
        flightServiceCharge(100, "Rental Cost"),
      ),
    ).toEqual({
      labels: LEGACY_FLIGHT_AMOUNT_LABELS,
      serviceChargeModel: false,
      chargeName: "",
    });
  });

  it("reads a consent record's frozen snapshot the same way — its frozen charge name included", () => {
    // A record frozen from an itinerary flight …
    const frozenFlight = {
      tripType: FlightTripType.ROUND_TRIP,
      outbound: roundTripFlightInput().flight.outbound,
      return: roundTripFlightInput().flight.return,
    };
    expect(flightMoneyWording(frozenFlight, NEW).serviceChargeModel).toBe(true);
    // … with the charge name the customer was shown when consent was asked.
    const frozenCharges: OrderCharge[] = [
      { name: "Agency Fee", amount: 95, timing: PaymentTiming.PREPAID },
    ];
    expect(flightMoneyWording(frozenFlight, NEW, frozenCharges)).toEqual({
      labels: flightLabelsWithCharge("Agency Fee"),
      serviceChargeModel: true,
      chargeName: "Agency Fee",
    });
    // … and one frozen before itineraries, which carries no outbound.
    expect(flightMoneyWording(null, NEW).serviceChargeModel).toBe(false);
    expect(flightMoneyWording(undefined, NEW).labels).toBe(LEGACY_FLIGHT_AMOUNT_LABELS);
    expect(flightMoneyWording(null, NEW, frozenCharges)).toEqual({
      labels: LEGACY_FLIGHT_AMOUNT_LABELS,
      serviceChargeModel: false,
      chargeName: "",
    });
  });

  it("is not fooled by an empty outbound journey", () => {
    expect(
      flightMoneyWording({ outbound: { segments: [] } }, NEW).serviceChargeModel,
    ).toBe(false);
    expect(
      flightMoneyWording(
        { outbound: { segments: [] } },
        NEW,
        flightServiceCharge(100, "Processing Fee"),
      ),
    ).toEqual({
      labels: LEGACY_FLIGHT_AMOUNT_LABELS,
      serviceChargeModel: false,
      chargeName: "",
    });
  });
});

describe("isAirlineChargeName — the airline's amount is never the collected charge", () => {
  it.each([
    "Airline Charge",
    "airline charges",
    "Airline Fare",
    "AIRLINE TICKET",
    "Airline Cost",
    "Airline Price",
    "Air Fare",
    "Airfare",
    "airfares",
    "Flight Fare",
    "Flight Fares",
    "Ticket Fare",
    "Ticket Price",
    "Ticket Cost",
    "  Airline Charge  ",
  ])("%j is the airline's amount", (name) => {
    expect(isAirlineChargeName(name)).toBe(true);
  });

  it.each([
    "Service Charge",
    "Service charge",
    "Processing Fee",
    "Rental Cost",
    "Agency Fee",
    "Service Fee",
    "Booking Fee",
    // Only MENTIONS the airline or the fare: not the airline's amount.
    "Airline Booking Fee",
    "Fare Protection",
    "Ticketing Fee",
    "",
  ])("%j is not", (name) => {
    expect(isAirlineChargeName(name)).toBe(false);
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

describe("default charge names by booking type", () => {
  it("pins each booking type's default — a change is never a 'Service Charge'", () => {
    expect(DEFAULT_FLIGHT_CHARGE_NAMES).toEqual({
      [BookingType.NEW_BOOKING]: "Service Charge",
      [BookingType.MODIFICATION]: "Modification Fee",
      [BookingType.CANCELLATION_CHARGE]: "Cancellation Charge",
    });
    expect(DEFAULT_FLIGHT_CHARGE_NAME).toBe(DEFAULT_FLIGHT_CHARGE_NAMES[BookingType.NEW_BOOKING]);
    expect(defaultFlightChargeName(BookingType.MODIFICATION)).toBe("Modification Fee");
    expect(defaultFlightChargeName(BookingType.CANCELLATION_CHARGE)).toBe("Cancellation Charge");
    expect(defaultFlightChargeName(undefined)).toBe("Service Charge");
    expect(defaultFlightChargeName(null)).toBe("Service Charge");
  });

  it("tells a default (or blank) name from one the operator typed", () => {
    for (const name of ["", "  ", null, undefined, "Service Charge", " Modification Fee ", "Cancellation Charge"]) {
      expect(isDefaultFlightChargeName(name), JSON.stringify(name)).toBe(true);
    }
    for (const name of ["Rental Cost", "Change Fee", "service charge", LEGACY_FLIGHT_CHARGE_NAME]) {
      expect(isDefaultFlightChargeName(name), JSON.stringify(name)).toBe(false);
    }
  });

  it("normalises a typed name the way the schema stores it", () => {
    expect(normaliseFlightChargeName("  Rental Cost ")).toBe("Rental Cost");
    expect(normaliseFlightChargeName("Service charge")).toBe("Service Charge");
    expect(normaliseFlightChargeName("service charge")).toBe("service charge");
    for (const blank of ["", "   ", null, undefined]) {
      expect(normaliseFlightChargeName(blank)).toBe("");
    }
  });

  it("gives an unnamed charge its booking type's default, and keeps a named one", () => {
    expect(flightChargeName([{ name: "" }], BookingType.MODIFICATION)).toBe("Modification Fee");
    expect(flightChargeName([{ name: "" }], BookingType.CANCELLATION_CHARGE)).toBe("Cancellation Charge");
    expect(flightChargeName([{ name: "" }])).toBe("Service Charge");
    expect(flightChargeName([{ name: "Rental Cost" }], BookingType.MODIFICATION)).toBe("Rental Cost");
  });

  it("labels a new modification by its default name — sentences neutral", () => {
    const wording = flightMoneyWording(roundTripFlightInput().flight, BookingType.MODIFICATION, [
      { name: "Modification Fee" },
    ]);
    expect(wording).toMatchObject({ serviceChargeModel: false, chargeName: "Modification Fee" });
    expect(wording.labels.serviceCharge).toBe("Modification Fee");
    expect(wording.labels.paidNow).toBe("Modification Fee Paid");
    expect(wording.labels.heldNow).toBe("Modification Fee On Hold");
  });
});

describe("a stored name that means the airline's amount is never shown as the collected charge", () => {
  // The schema refuses these now, but a flight saved before that rule (or
  // written around it) may carry one. It reads as never named, so its order
  // keeps the wording it was sent with.
  it.each(["Airfare", "Airline Charge", "Ticket Price", "Flight Cost"])("%j", (name) => {
    const charges = [{ name, amount: 95, timing: PaymentTiming.PREPAID }];
    expect(namedFlightCharge(charges)).toBeNull();

    const wording = flightMoneyWording(roundTripFlightInput().flight, BookingType.NEW_BOOKING, charges);
    expect(wording.chargeName).toBe("Service Charge");
    expect(wording.labels).toEqual(FLIGHT_AMOUNT_LABELS);
    expect(wording.labels.serviceCharge).not.toBe(name);

    // A modification of such a flight stays neutral.
    const modification = flightMoneyWording(roundTripFlightInput().flight, BookingType.MODIFICATION, charges);
    expect(modification.chargeName).toBe("");
    expect(modification.labels).toBe(LEGACY_FLIGHT_AMOUNT_LABELS);
  });
});
