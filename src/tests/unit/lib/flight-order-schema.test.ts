import { describe, expect, it } from "vitest";

import {
  DEFAULT_FLIGHT_CHARGE_NAME,
  DEFAULT_FLIGHT_CHARGE_NAMES,
  flightChargeName,
  namedFlightCharge,
  normaliseFlightChargeName,
  summarizeCharges,
  summarizeFlightAmounts,
} from "@/lib/charges";
import {
  BookingType,
  FlightTripType,
  PaymentTiming,
  ServiceType,
} from "@/lib/constants/enums";
import {
  CONNECTION_CHRONOLOGY_MESSAGE,
  MAX_LAYOVER_OVERRIDE_MINUTES,
} from "@/lib/flight-itinerary";
import {
  createOrderRequestSchema,
  flightJourneyInputSchema,
  flightOrderSchema,
  flightSegmentInputSchema,
} from "@/lib/validation/order";
import {
  FLIGHT_SEGMENTS,
  flightJourneyInput,
  flightSegmentInput,
  flightServiceCharge,
  multiCityFlightInput,
  oneWayConnectingFlightInput,
  roundTripFlightInput,
  validCreateOrderInput,
  validFlightOrderInput,
} from "@/tests/fixtures/order-input.fixture";

/**
 * `flightOrderSchema` — what the API accepts as a flight itinerary.
 *
 * Pure zod, no database. The schema is the last line of defence before an
 * itinerary is frozen onto an order (and its evidence chain), so this pins
 * the client's rules on the PARSED output as well as on what is refused:
 *
 *   - One Way / Multi-City are one ordered segment list; a Round Trip has
 *     two independent journeys. Anything else's `return` is dropped.
 *   - Connections are positional — exactly one per gap — whatever arrives.
 *   - An impossible connection is refused with the client's exact wording,
 *     at the departure field of the flight that leaves too early.
 *   - A flight is PREPAID only, with ONE charge line — the amount the
 *     payment link collects, NAMED by the operator ("Rental Cost",
 *     "Processing Fee", …). The name is stored as typed (trimmed); blank
 *     means "Service Charge". The airline charge is a required figure of
 *     its own — never a line, and never the line's name.
 */

/** The client's copy, pinned verbatim. */
const ONE_CHARGE_MESSAGE =
  "A flight has one charge: the amount this payment link collects. Enter the airline charge in its own field — it is never collected through the payment link.";
const AIRLINE_NAME_MESSAGE =
  "The airline charge has its own field and is never collected here. Name the charge this link collects (e.g. Service Charge, Processing Fee).";

type SafeParse = ReturnType<typeof flightOrderSchema.safeParse>;

function issuesOf(result: SafeParse) {
  return result.success
    ? []
    : result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      }));
}

function messagesAt(result: SafeParse, path: string): string[] {
  return issuesOf(result)
    .filter((i) => i.path === path)
    .map((i) => i.message);
}

function parsed(input: unknown) {
  const result = flightOrderSchema.safeParse(input);
  if (!result.success) {
    throw new Error(
      `expected a valid flight, got: ${JSON.stringify(issuesOf(result))}`,
    );
  }
  return result.data;
}

describe("flightOrderSchema — accepted itineraries", () => {
  it("accepts a direct one-way flight", () => {
    const data = parsed(validFlightOrderInput());
    expect(data.flight.tripType).toBe(FlightTripType.ONE_WAY);
    expect(data.flight.outbound.segments).toHaveLength(1);
    expect(data.flight.outbound.connections).toEqual([]);
    expect(data.flight.return).toBeNull();
  });

  it("accepts a connecting one-way flight with a layover and a duration override", () => {
    const data = parsed(
      oneWayConnectingFlightInput(
        {},
        {
          outbound: flightJourneyInput(
            [FLIGHT_SEGMENTS.delhiVaranasi(), FLIGHT_SEGMENTS.varanasiMumbai()],
            [
              {
                layover: {
                  location: "Varanasi (VNS) — Terminal 2",
                  durationMinutesOverride: 165,
                  notes: "Change terminals",
                },
              },
            ],
          ),
        },
      ),
    );
    expect(data.flight.outbound.segments.map((s) => s.origin)).toEqual([
      "Delhi",
      "Varanasi",
    ]);
    // The layover belongs to the CONNECTION, and only what the two flights
    // cannot express is stored: a place, an override and notes.
    expect(data.flight.outbound.connections).toEqual([
      {
        layover: {
          location: "Varanasi (VNS) — Terminal 2",
          durationMinutesOverride: 165,
          notes: "Change terminals",
        },
      },
    ]);
  });

  it("accepts a round trip whose outbound and return are fully independent", () => {
    const data = parsed(roundTripFlightInput());
    const { outbound, return: back } = data.flight;
    expect(outbound.segments.map((s) => `${s.origin}-${s.destination}`)).toEqual([
      "Delhi-Varanasi",
      "Varanasi-Mumbai",
    ]);
    expect(back).not.toBeNull();
    expect(back!.segments.map((s) => `${s.origin}-${s.destination}`)).toEqual([
      "Mumbai-Varanasi",
      "Varanasi-Delhi",
    ]);
    // Each direction keeps its OWN connections and layovers.
    expect(outbound.connections[0]!.layover).toMatchObject({
      durationMinutesOverride: null,
      notes: "Change terminals",
    });
    expect(back!.connections[0]!.layover).toMatchObject({
      durationMinutesOverride: 120,
      notes: "Lounge access included",
    });
  });

  it("accepts a multi-city trip of two or more flights", () => {
    const data = parsed(multiCityFlightInput());
    expect(data.flight.tripType).toBe(FlightTripType.MULTI_CITY);
    expect(data.flight.outbound.segments).toHaveLength(3);
    expect(data.flight.outbound.connections).toHaveLength(2);

    const two = parsed(
      validFlightOrderInput(
        {},
        {
          tripType: FlightTripType.MULTI_CITY,
          outbound: flightJourneyInput([
            FLIGHT_SEGMENTS.delhiVaranasi(),
            FLIGHT_SEGMENTS.varanasiMumbai(),
          ]),
        },
      ),
    );
    expect(two.flight.outbound.segments).toHaveLength(2);
  });

  it("accepts an overnight connection — the full dates decide, not the clock", () => {
    const data = parsed(
      validFlightOrderInput(
        {},
        {
          outbound: flightJourneyInput([
            flightSegmentInput("Delhi", "Varanasi", ["2026-10-10", "20:00"], ["2026-10-10", "22:00"]),
            flightSegmentInput("Varanasi", "Mumbai", ["2026-10-11", "07:00"], ["2026-10-11", "09:00"]),
          ]),
        },
      ),
    );
    expect(data.flight.outbound.segments).toHaveLength(2);
  });

  it("lets WARNINGS through: an airport change and a date-line arrival never block saving", () => {
    expect(
      flightOrderSchema.safeParse(
        validFlightOrderInput(
          {},
          {
            outbound: flightJourneyInput([
              FLIGHT_SEGMENTS.delhiVaranasi(),
              // Lands at Varanasi, leaves from Lucknow: unusual, legitimate.
              flightSegmentInput("Lucknow", "Mumbai", ["2026-10-10", "18:00"], ["2026-10-10", "20:00"]),
            ]),
          },
        ),
      ).success,
    ).toBe(true);
    expect(
      flightOrderSchema.safeParse(
        validFlightOrderInput(
          {},
          {
            outbound: flightJourneyInput([
              // Crosses the International Date Line: lands "before" it left.
              flightSegmentInput("Tokyo", "Los Angeles", ["2026-10-10", "17:00"], ["2026-10-10", "10:00"]),
            ]),
          },
        ),
      ).success,
    ).toBe(true);
  });

  it("accepts an airline charge of 0 — a flight with none still states it", () => {
    expect(parsed(validFlightOrderInput({}, { airlineFare: 0 })).flight.airlineFare).toBe(0);
  });

  it("keeps decimal amounts as entered", () => {
    const data = parsed(
      validFlightOrderInput(
        { charges: flightServiceCharge(75.5) },
        { airlineFare: 825.25 },
      ),
    );
    expect(data.flight.airlineFare).toBe(825.25);
    // The fixture's line carries the pre-naming "Service charge", which is
    // stored as the default name.
    expect(data.charges).toEqual([
      { name: "Service Charge", amount: 75.5, timing: PaymentTiming.PREPAID },
    ]);
  });
});

describe("flightOrderSchema — the money: one charge the operator names, the airline charge on its own", () => {
  it("refuses a blank or missing airline charge — 0 when there is none", () => {
    const blank = flightOrderSchema.safeParse(
      validFlightOrderInput({}, { airlineFare: null as never }),
    );
    expect(messagesAt(blank, "flight.airlineFare")).toEqual([
      "Enter the airline charge (0 if there is none)",
    ]);
    const omitted = validFlightOrderInput();
    delete (omitted.flight as Record<string, unknown>).airlineFare;
    expect(messagesAt(flightOrderSchema.safeParse(omitted), "flight.airlineFare")).toEqual([
      "Enter the airline charge (0 if there is none)",
    ]);
  });

  it("refuses a second charge line — an airline charge can never ride along into the payment", () => {
    const result = flightOrderSchema.safeParse(
      validFlightOrderInput({
        charges: [
          { name: "Airline charge", amount: 400, timing: PaymentTiming.PREPAID },
          { name: "Service charge", amount: 100, timing: PaymentTiming.PREPAID },
        ],
      }),
    );
    expect(messagesAt(result, "charges")).toEqual([ONE_CHARGE_MESSAGE]);
    // … nor can the airline's amount be passed off as the line collected.
    expect(messagesAt(result, "charges.0.name")).toEqual([AIRLINE_NAME_MESSAGE]);

    // A second line is refused whatever the lines are called.
    const twoNamed = flightOrderSchema.safeParse(
      validFlightOrderInput({
        charges: [
          { name: "Processing Fee", amount: 100, timing: PaymentTiming.PREPAID },
          { name: "Agency Fee", amount: 400, timing: PaymentTiming.PREPAID },
        ],
      }),
    );
    expect(issuesOf(twoNamed)).toEqual([{ path: "charges", message: ONE_CHARGE_MESSAGE }]);
  });

  it.each(["Rental Cost", "Processing Fee", "Agency Fee", "Service Fee", "Booking Fee"])(
    "stores the operator's charge name %j exactly as typed",
    (name) => {
      const data = parsed(validFlightOrderInput({ charges: flightServiceCharge(100, name) }));
      expect(data.charges).toEqual([{ name, amount: 100, timing: PaymentTiming.PREPAID }]);
      // A custom name is never swapped for the default.
      expect(data.charges[0]!.name).not.toBe("Service Charge");
    },
  );

  it("trims the name but otherwise keeps it as typed — its case included", () => {
    const cases: Array<[typed: string, stored: string]> = [
      ["  Processing Fee  ", "Processing Fee"],
      ["processing fee", "processing fee"],
      ["AGENCY FEE", "AGENCY FEE"],
      // Only the exact pre-naming "Service charge" is rewritten (below).
      ["service charge", "service charge"],
      ["Service Charge", "Service Charge"],
    ];
    for (const [typed, stored] of cases) {
      const data = parsed(validFlightOrderInput({ charges: flightServiceCharge(100, typed) }));
      expect(data.charges[0]!.name, JSON.stringify(typed)).toBe(stored);
    }
  });

  it("stores the default 'Service Charge' when the operator leaves the name blank", () => {
    for (const name of ["", "   ", undefined, null]) {
      const data = parsed(
        roundTripFlightInput({
          charges: [{ name, amount: 95, timing: PaymentTiming.PREPAID }] as never,
        }),
      );
      // The default — never a name borrowed from elsewhere on the order
      // (the customer, the airline, the booking reference).
      expect(data.charges, JSON.stringify(name)).toEqual([
        { name: "Service Charge", amount: 95, timing: PaymentTiming.PREPAID },
      ]);
    }
    // No `name` key at all.
    const noName = parsed(
      validFlightOrderInput({
        charges: [{ amount: 100, timing: PaymentTiming.PREPAID }] as never,
      }),
    );
    expect(noName.charges[0]!.name).toBe(DEFAULT_FLIGHT_CHARGE_NAME);
    expect(DEFAULT_FLIGHT_CHARGE_NAME).toBe("Service Charge");
  });

  it("stores the pre-naming 'Service charge' as the default 'Service Charge'", () => {
    for (const name of ["Service charge", "  Service charge  "]) {
      const data = parsed(validFlightOrderInput({ charges: flightServiceCharge(100, name) }));
      expect(data.charges[0]!.name, JSON.stringify(name)).toBe("Service Charge");
    }
  });

  it("stores exactly the name the form's live summary showed — one every surface reads as the operator's", () => {
    for (const typed of [
      "",
      "   ",
      "Service charge",
      "Service Charge",
      "service charge",
      "  Processing Fee ",
      "Rental Cost",
      "Agency Fee",
    ]) {
      const data = parsed(validFlightOrderInput({ charges: flightServiceCharge(100, typed) }));
      const stored = data.charges[0]!.name;
      // The create form's summary labels the row `flightChargeName` of what
      // is being typed …
      expect(stored, JSON.stringify(typed)).toBe(flightChargeName([{ name: typed }]));
      // … and a stored name is never one `namedFlightCharge` ignores, so
      // every page, email and gateway line shows it.
      expect(namedFlightCharge(data.charges), JSON.stringify(typed)).toBe(stored);
    }
  });

  it("refuses a charge name over 120 characters", () => {
    const result = flightOrderSchema.safeParse(
      validFlightOrderInput({ charges: flightServiceCharge(100, "x".repeat(121)) }),
    );
    expect(messagesAt(result, "charges.0.name")).toEqual([
      "Charge name must be 120 characters or fewer",
    ]);
    // 120 is the limit, counted after trimming.
    const limit = "x".repeat(120);
    for (const typed of [limit, `  ${limit}  `]) {
      expect(
        parsed(validFlightOrderInput({ charges: flightServiceCharge(100, typed) })).charges[0]!
          .name,
      ).toBe(limit);
    }
  });

  it.each(["Airline Charge", "airline fare", "Airfare", "Flight Fare", "Ticket Price", "  Airline Charges  "])(
    "refuses %j as the charge name — the airline charge has its own field and is never collected",
    (name) => {
      const result = flightOrderSchema.safeParse(
        validFlightOrderInput({ charges: flightServiceCharge(100, name) }),
      );
      expect(result.success).toBe(false);
      expect(messagesAt(result, "charges.0.name")).toEqual([AIRLINE_NAME_MESSAGE]);
    },
  );

  it.each(["Airline Booking Fee", "Fare Protection"])(
    "accepts %j — it mentions the airline or the fare but is not the airline's amount",
    (name) => {
      const data = parsed(validFlightOrderInput({ charges: flightServiceCharge(100, name) }));
      expect(data.charges[0]!.name).toBe(name);
    },
  );

  it("refuses a blank or zero charge amount — the payment link must collect something", () => {
    const blank = flightOrderSchema.safeParse(
      validFlightOrderInput({
        charges: [{ name: "Service charge", amount: null, timing: PaymentTiming.PREPAID }] as never,
      }),
    );
    expect(messagesAt(blank, "charges.0.amount")).toEqual(["Enter the charge amount"]);
    const missing = flightOrderSchema.safeParse(
      validFlightOrderInput({
        charges: [{ name: "Processing Fee", timing: PaymentTiming.PREPAID }] as never,
      }),
    );
    expect(messagesAt(missing, "charges.0.amount")).toEqual(["Enter the charge amount"]);
    for (const amount of [0, -5]) {
      const result = flightOrderSchema.safeParse(
        validFlightOrderInput({ charges: flightServiceCharge(amount) }),
      );
      expect(messagesAt(result, "charges.0.amount"), String(amount)).toEqual([
        "The charge amount must be greater than zero",
      ]);
    }
  });

  it("changes nothing but the name when the charge is renamed — the link collects the charge, never the airline charge", () => {
    const names = ["Rental Cost", "Processing Fee", "Agency Fee", "Service Fee"];
    const orders = names.map((name) =>
      parsed(
        validFlightOrderInput({ charges: flightServiceCharge(100, name) }, { airlineFare: 400 }),
      ),
    );
    orders.forEach((data, i) => {
      expect(data.charges).toEqual([
        { name: names[i], amount: 100, timing: PaymentTiming.PREPAID },
      ]);
      expect(data.flight.airlineFare).toBe(400);
      // What `createOrder` stores as `pricing.amount` — the amount the
      // gateway is asked for: the charge alone.
      expect(summarizeCharges(data.charges).prepaid).toBe(100);
      expect(summarizeFlightAmounts(data.charges, data.flight.airlineFare)).toMatchObject({
        airlineFare: 400,
        serviceCharge: 100,
        payableNow: 100,
        bookingTotal: 500,
      });
    });
    // Apart from the name, every order parses identically.
    const withoutName = orders.map(({ charges, ...rest }) => ({
      ...rest,
      charges: charges.map((c) => ({ amount: c.amount, timing: c.timing })),
    }));
    for (const other of withoutName.slice(1)) expect(other).toEqual(withoutName[0]);
  });
});

describe("flightOrderSchema — normalisation", () => {
  it("drops a return journey on a one-way trip", () => {
    const data = parsed(
      validFlightOrderInput(
        {},
        {
          tripType: FlightTripType.ONE_WAY,
          return: flightJourneyInput([FLIGHT_SEGMENTS.varanasiDelhi()]),
        },
      ),
    );
    expect(data.flight.return).toBeNull();
  });

  it("drops a return journey on a multi-city trip", () => {
    const data = parsed(
      multiCityFlightInput(
        {},
        { return: flightJourneyInput([FLIGHT_SEGMENTS.varanasiDelhi()]) },
      ),
    );
    expect(data.flight.return).toBeNull();
  });

  it("normalises connections to exactly segments - 1, whatever arrives", () => {
    const segments = [
      FLIGHT_SEGMENTS.delhiVaranasi(),
      FLIGHT_SEGMENTS.varanasiMumbai(),
      FLIGHT_SEGMENTS.mumbaiGoa(),
    ];
    const layover = { location: null, durationMinutesOverride: 60, notes: null };

    // Too few: the missing gap is "no layover recorded".
    const short = parsed(
      validFlightOrderInput(
        {},
        { outbound: { segments, connections: [{ layover }] } },
      ),
    );
    expect(short.flight.outbound.connections).toEqual([
      { layover },
      { layover: null },
    ]);

    // Too many: extra entries are dropped.
    const long = parsed(
      validFlightOrderInput(
        {},
        {
          outbound: {
            segments: segments.slice(0, 2),
            connections: [{ layover }, { layover }, { layover }],
          },
        },
      ),
    );
    expect(long.flight.outbound.connections).toEqual([{ layover }]);

    // Absent altogether.
    const missing = parsed(
      validFlightOrderInput(
        {},
        { outbound: { segments } as never },
      ),
    );
    expect(missing.flight.outbound.connections).toEqual([
      { layover: null },
      { layover: null },
    ]);
  });

  it("normalises a journey the same way through the exported journey schema", () => {
    const journey = flightJourneyInputSchema.parse({
      segments: [FLIGHT_SEGMENTS.delhiVaranasi(), FLIGHT_SEGMENTS.varanasiMumbai()],
      connections: null,
    });
    expect(journey.connections).toEqual([{ layover: null }]);
  });

  // The create form's PNR field. The order stores it as its one booking
  // reference (`confirmationNumber`); the API keeps accepting it under
  // `flight.pnr`, exactly as before.
  it("accepts the PNR under flight.pnr — trimmed, up to 32 characters — and refuses a longer one", () => {
    expect(parsed(validFlightOrderInput({}, { pnr: "  XYZ789 " })).flight.pnr).toBe("XYZ789");
    expect(parsed(validFlightOrderInput({}, { pnr: "P".repeat(32) })).flight.pnr).toBe(
      "P".repeat(32),
    );
    expect(parsed(validFlightOrderInput({}, { pnr: null })).flight.pnr).toBeNull();
    const tooLong = flightOrderSchema.safeParse(validFlightOrderInput({}, { pnr: "P".repeat(33) }));
    expect(tooLong.success).toBe(false);
    expect(issuesOf(tooLong).map((i) => i.path)).toEqual(["flight.pnr"]);
  });
});

describe("flightOrderSchema — refused itineraries", () => {
  it("refuses a next flight that departs before the previous one arrives, with the client's exact message", () => {
    const result = flightOrderSchema.safeParse(
      validFlightOrderInput(
        {},
        {
          outbound: flightJourneyInput([
            FLIGHT_SEGMENTS.delhiVaranasi(), // lands 12:00
            flightSegmentInput("Varanasi", "Mumbai", ["2026-10-10", "11:30"], ["2026-10-10", "13:30"]),
          ]),
        },
      ),
    );
    expect(result.success).toBe(false);
    expect(messagesAt(result, "flight.outbound.segments.1.departure.date")).toEqual([
      "Please check the flight times. The next flight departs before the previous flight arrives.",
    ]);
    expect(CONNECTION_CHRONOLOGY_MESSAGE).toBe(
      "Please check the flight times. The next flight departs before the previous flight arrives.",
    );
  });

  it("applies the chronology rule inside the RETURN journey too", () => {
    const result = flightOrderSchema.safeParse(
      roundTripFlightInput(
        {},
        {
          return: flightJourneyInput([
            FLIGHT_SEGMENTS.mumbaiVaranasi(), // lands 11:00
            flightSegmentInput("Varanasi", "Delhi", ["2026-10-15", "10:00"], ["2026-10-15", "12:00"]),
          ]),
        },
      ),
    );
    expect(messagesAt(result, "flight.return.segments.1.departure.date")).toEqual([
      CONNECTION_CHRONOLOGY_MESSAGE,
    ]);
  });

  it("refuses a return that departs before the outbound journey arrives", () => {
    const result = flightOrderSchema.safeParse(
      roundTripFlightInput(
        {},
        {
          return: flightJourneyInput([
            flightSegmentInput("Mumbai", "Delhi", ["2026-10-10", "15:00"], ["2026-10-10", "17:00"]),
          ]),
        },
      ),
    );
    expect(messagesAt(result, "flight.return.segments.0.departure.date")).toEqual([
      "The return flight departs before the outbound flights arrive. Please check the dates.",
    ]);
  });

  it("refuses a multi-city trip with a single flight", () => {
    const result = flightOrderSchema.safeParse(
      validFlightOrderInput(
        {},
        {
          tripType: FlightTripType.MULTI_CITY,
          outbound: flightJourneyInput([FLIGHT_SEGMENTS.delhiVaranasi()]),
        },
      ),
    );
    expect(messagesAt(result, "flight.outbound.segments")).toEqual([
      "A multi-city trip needs at least two flights.",
    ]);
  });

  it("refuses a round trip without a return journey", () => {
    for (const back of [null, undefined]) {
      const input = roundTripFlightInput();
      (input.flight as Record<string, unknown>).return = back;
      const result = flightOrderSchema.safeParse(input);
      expect(messagesAt(result, "flight.return")).toEqual(["Add the return flight."]);
    }
  });

  it("refuses a DUE_AT_COUNTER charge — a flight is prepaid only", () => {
    const result = flightOrderSchema.safeParse(
      validFlightOrderInput({
        charges: [
          { name: "Service charge", amount: 50, timing: PaymentTiming.PREPAID },
          {
            name: "Balance at the airport",
            amount: 300,
            timing: PaymentTiming.DUE_AT_COUNTER as never,
          },
        ],
      }),
    );
    expect(messagesAt(result, "charges.1.timing")).toEqual([
      "Flight charges are always prepaid",
    ]);
  });

  it("refuses an order with no charge at all", () => {
    const result = flightOrderSchema.safeParse(validFlightOrderInput({ charges: [] }));
    expect(messagesAt(result, "charges")).toEqual(["Enter the charge amount"]);
  });

  it("refuses a negative airline charge", () => {
    const result = flightOrderSchema.safeParse(validFlightOrderInput({}, { airlineFare: -1 }));
    expect(messagesAt(result, "flight.airlineFare")).toEqual([
      "The airline charge can't be negative",
    ]);
  });

  it.each([
    ["10/10/2026", "an ambiguous local format"],
    ["2026-13-01", "a 13th month"],
    ["2026-02-30", "a day that does not exist"],
    ["2026-10-10T10:30:00Z", "an instant instead of a wall-clock date"],
  ])("refuses the departure date %s (%s)", (date) => {
    const segment = FLIGHT_SEGMENTS.londonNewYork();
    segment.departure.date = date;
    const result = flightOrderSchema.safeParse(
      validFlightOrderInput({}, { outbound: flightJourneyInput([segment]) }),
    );
    expect(messagesAt(result, "flight.outbound.segments.0.departure.date")).toContain(
      "Enter a valid date",
    );
  });

  it.each([
    ["24:00", "past midnight"],
    ["7:30", "an unpadded hour"],
    ["10:30 PM", "a 12-hour clock"],
    ["10:60", "a 60th minute"],
  ])("refuses the arrival time %s (%s)", (time) => {
    const segment = FLIGHT_SEGMENTS.londonNewYork();
    segment.arrival.time = time;
    const result = flightOrderSchema.safeParse(
      validFlightOrderInput({}, { outbound: flightJourneyInput([segment]) }),
    );
    expect(messagesAt(result, "flight.outbound.segments.0.arrival.time")).toContain(
      "Enter a valid time",
    );
  });

  it("says a blank date or time is required rather than malformed", () => {
    const segment = FLIGHT_SEGMENTS.londonNewYork();
    segment.departure = { date: "", time: "" };
    const result = flightOrderSchema.safeParse(
      validFlightOrderInput({}, { outbound: flightJourneyInput([segment]) }),
    );
    expect(messagesAt(result, "flight.outbound.segments.0.departure.date")).toContain(
      "Date is required",
    );
    expect(messagesAt(result, "flight.outbound.segments.0.departure.time")).toContain(
      "Time is required",
    );
  });

  it.each([
    [0, "Enter a duration of at least 1 minute"],
    [-30, "Enter a duration of at least 1 minute"],
    [MAX_LAYOVER_OVERRIDE_MINUTES + 1, "A layover can't be longer than 7 days"],
    [90.5, "Enter a whole number of minutes"],
  ])("refuses a layover override of %s minutes", (minutes, message) => {
    const result = flightOrderSchema.safeParse(
      oneWayConnectingFlightInput(
        {},
        {
          outbound: flightJourneyInput(
            [FLIGHT_SEGMENTS.delhiVaranasi(), FLIGHT_SEGMENTS.varanasiMumbai()],
            [{ layover: { location: null, durationMinutesOverride: minutes, notes: null } }],
          ),
        },
      ),
    );
    expect(
      messagesAt(result, "flight.outbound.connections.0.layover.durationMinutesOverride"),
    ).toEqual([message]);
  });

  it("accepts an override of exactly 7 days, and of 1 minute", () => {
    for (const minutes of [1, MAX_LAYOVER_OVERRIDE_MINUTES]) {
      expect(MAX_LAYOVER_OVERRIDE_MINUTES).toBe(7 * 24 * 60);
      const result = flightOrderSchema.safeParse(
        oneWayConnectingFlightInput(
          {},
          {
            outbound: flightJourneyInput(
              [FLIGHT_SEGMENTS.delhiVaranasi(), FLIGHT_SEGMENTS.varanasiMumbai()],
              [{ layover: { location: null, durationMinutesOverride: minutes, notes: null } }],
            ),
          },
        ),
      );
      expect(result.success, JSON.stringify(issuesOf(result))).toBe(true);
    }
  });
});

describe("From / To messages — exactly one message each", () => {
  /** Every message the segment schema reports for one field. */
  function segmentMessages(field: "origin" | "destination", value: string) {
    const result = flightSegmentInputSchema.safeParse({
      ...FLIGHT_SEGMENTS.londonNewYork(),
      [field]: value,
    });
    return result.success
      ? []
      : result.error.issues
          .filter((i) => i.path.join(".") === field)
          .map((i) => i.message);
  }

  it("a blank From says it is required — and nothing else", () => {
    expect(segmentMessages("origin", "")).toEqual(["From is required"]);
    expect(segmentMessages("origin", "   ")).toEqual(["From is required"]);
  });

  it("a one-character From says what is actually wrong", () => {
    expect(segmentMessages("origin", "X")).toEqual(["Enter at least 2 characters"]);
  });

  it("a blank To says it is required — and nothing else", () => {
    expect(segmentMessages("destination", "")).toEqual(["To is required"]);
  });

  it("a one-character To says what is actually wrong", () => {
    expect(segmentMessages("destination", "J")).toEqual(["Enter at least 2 characters"]);
  });

  it("reports the same single message through the whole order schema", () => {
    const segment = FLIGHT_SEGMENTS.londonNewYork();
    segment.origin = "";
    const result = flightOrderSchema.safeParse(
      validFlightOrderInput({}, { outbound: flightJourneyInput([segment]) }),
    );
    expect(messagesAt(result, "flight.outbound.segments.0.origin")).toEqual([
      "From is required",
    ]);
  });
});

describe("the flight's charge-name rules are the flight's alone — Car is unchanged", () => {
  /** A car order through the same entry point the API uses. */
  function parseCar(charges: unknown) {
    return createOrderRequestSchema.safeParse({
      ...validCreateOrderInput(),
      serviceType: ServiceType.CAR_RENTAL,
      charges,
    });
  }

  it("stores a car's charge lines exactly as typed — no default name, no 'Service charge' rewrite", () => {
    const lines = [
      { name: "Rental cost", amount: 249.99, timing: PaymentTiming.PREPAID },
      { name: "Service charge", amount: 20, timing: PaymentTiming.PREPAID },
      { name: "Deposit", amount: 150, timing: PaymentTiming.DUE_AT_COUNTER },
    ];
    const result = parseCar(lines);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect(result.data?.charges).toEqual(lines);
  });

  it("still requires a car's charge name — a blank one is refused, not defaulted", () => {
    const result = parseCar([{ name: "  ", amount: 249.99, timing: PaymentTiming.PREPAID }]);
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.map((i) => [i.path.join("."), i.message]),
    ).toContainEqual(["charges.0.name", "Charge name is required"]);
  });
});

describe("flightOrderSchema — a charge left unnamed takes its booking type's default", () => {
  it.each([
    [BookingType.NEW_BOOKING, "Service Charge"],
    [BookingType.MODIFICATION, "Modification Fee"],
    [BookingType.CANCELLATION_CHARGE, "Cancellation Charge"],
  ])("a blank name on a %s is stored as %j", (bookingType, expected) => {
    expect(DEFAULT_FLIGHT_CHARGE_NAMES[bookingType]).toBe(expected);
    for (const name of ["", "   ", undefined, null]) {
      const data = parsed(
        validFlightOrderInput({
          bookingType,
          charges: [{ name, amount: 100, timing: PaymentTiming.PREPAID }] as never,
        }),
      );
      expect(data.charges, JSON.stringify(name)).toEqual([
        { name: expected, amount: 100, timing: PaymentTiming.PREPAID },
      ]);
    }
  });

  it("keeps a name the operator typed, whatever the booking type", () => {
    for (const bookingType of Object.values(BookingType)) {
      const data = parsed(
        validFlightOrderInput({ bookingType, charges: flightServiceCharge(100, " Rental Cost ") }),
      );
      expect(data.charges[0]!.name, bookingType).toBe("Rental Cost");
    }
  });

  it("stores the pre-naming 'Service charge' as 'Service Charge' on every booking type — the operator meant a service charge", () => {
    for (const bookingType of Object.values(BookingType)) {
      const data = parsed(
        validFlightOrderInput({ bookingType, charges: flightServiceCharge(100, "Service charge") }),
      );
      expect(data.charges[0]!.name, bookingType).toBe("Service Charge");
    }
  });

  it("applies the default through the service-type union the API parses", () => {
    const result = createOrderRequestSchema.safeParse(
      validFlightOrderInput({
        bookingType: BookingType.MODIFICATION,
        charges: [{ name: "  ", amount: 50, timing: PaymentTiming.PREPAID }] as never,
      }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.serviceType).toBe(ServiceType.FLIGHT);
    expect((result.data as { charges: { name: string }[] }).charges[0]!.name).toBe(
      "Modification Fee",
    );
  });

  it("stores exactly what the form's live summary previews, on every booking type", () => {
    for (const bookingType of Object.values(BookingType)) {
      for (const typed of ["", "  ", "Service charge", "Service Charge", " Agency Fee "]) {
        const data = parsed(
          validFlightOrderInput({ bookingType, charges: flightServiceCharge(100, typed) }),
        );
        const previewed = flightChargeName(
          [{ name: normaliseFlightChargeName(typed) }],
          bookingType,
        );
        expect(data.charges[0]!.name, `${bookingType} ${JSON.stringify(typed)}`).toBe(previewed);
        // … and every surface reads the stored name as the operator's.
        expect(namedFlightCharge(data.charges)).toBe(previewed);
      }
    }
  });
});

describe("flightOrderSchema — every way of naming the airline's amount is refused", () => {
  it.each([
    "Air Ticket",
    "Flight Ticket",
    "Airline Tickets",
    "Flight Cost",
    "Flight Price",
    "Flight Charge",
    "Air-fare",
    "air fare",
    "Fare",
    "Base Fare",
    "Ticket",
    "Tickets",
    "Ticket Cost",
  ])("refuses %j as the collected charge's name", (name) => {
    const result = flightOrderSchema.safeParse(
      validFlightOrderInput({ charges: flightServiceCharge(100, name) }),
    );
    expect(messagesAt(result, "charges.0.name")).toEqual([AIRLINE_NAME_MESSAGE]);
  });

  it.each([
    "Air Ticket Charges",
    "Flight Ticket Price",
    "Airline Ticket Cost",
    "Airline Fee",
    "Airline Fees",
    "Total Fare",
    "Fare Charges",
    "Ticket Charges",
    "Airline Charge (USD)",
    "Airline Charge.",
  ])("refuses %j too — with a ticket noun, a fee, a total or a trailing qualifier", (name) => {
    const result = flightOrderSchema.safeParse(
      validFlightOrderInput({ charges: flightServiceCharge(100, name) }),
    );
    expect(messagesAt(result, "charges.0.name")).toEqual([AIRLINE_NAME_MESSAGE]);
  });

  it.each([
    "Ticketing Fee",
    "Airline Booking Fee",
    "Flight Booking Fee",
    "Fare Protection",
    "Air Service Fee",
    "Rental Cost",
    "Processing Fee",
    "Agency Fee",
    "Service Fee",
    "Booking Fee",
    "Convenience Fee",
    "Change Fee (per passenger)",
  ])("accepts %j — the operator's own charge, not the airline's amount", (name) => {
    expect(parsed(validFlightOrderInput({ charges: flightServiceCharge(100, name) })).charges[0]!.name).toBe(name);
  });
});
