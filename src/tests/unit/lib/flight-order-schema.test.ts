import { describe, expect, it } from "vitest";

import { FlightTripType, PaymentTiming } from "@/lib/constants/enums";
import {
  CONNECTION_CHRONOLOGY_MESSAGE,
  MAX_LAYOVER_OVERRIDE_MINUTES,
} from "@/lib/flight-itinerary";
import {
  flightJourneyInputSchema,
  flightOrderSchema,
  flightSegmentInputSchema,
} from "@/lib/validation/order";
import {
  FLIGHT_SEGMENTS,
  flightJourneyInput,
  flightSegmentInput,
  multiCityFlightInput,
  oneWayConnectingFlightInput,
  roundTripFlightInput,
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
 *   - A flight is PREPAID only; the airline fare is a figure, never a charge.
 */

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

  it("accepts a blank airline fare", () => {
    expect(parsed(validFlightOrderInput({}, { airlineFare: null })).flight.airlineFare).toBeNull();
    const omitted = validFlightOrderInput();
    delete (omitted.flight as Record<string, unknown>).airlineFare;
    expect(parsed(omitted).flight.airlineFare).toBeUndefined();
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

  it("refuses an order with no service charge at all", () => {
    const result = flightOrderSchema.safeParse(validFlightOrderInput({ charges: [] }));
    expect(messagesAt(result, "charges")).toEqual(["Add the service charge"]);
  });

  it("refuses a negative airline fare", () => {
    const result = flightOrderSchema.safeParse(validFlightOrderInput({}, { airlineFare: -1 }));
    expect(messagesAt(result, "flight.airlineFare")).toEqual([
      "The airline fare can't be negative",
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
