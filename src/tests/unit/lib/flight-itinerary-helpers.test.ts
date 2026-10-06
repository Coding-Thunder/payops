import { describe, expect, it } from "vitest";

import { FlightTripType } from "@/lib/constants/enums";
import {
  arrivalNeedsDate,
  buildFlightItinerary,
  connectionAt,
  formatLocalDateTime,
  formatSegmentTime,
  hasFlightItinerary,
  itineraryFirstDeparture,
  itineraryReturnDeparture,
  itinerarySegmentCount,
  journeyLabel,
  journeyStopsLabel,
  normalizeTripType,
  segmentCarrier,
  toPlainJourney,
  truncateText,
  wallClockMinutes,
} from "@/lib/flight-itinerary";
import {
  FLIGHT_SEGMENTS,
  multiCityFlightInput,
  roundTripFlightInput,
} from "@/tests/fixtures/order-input.fixture";

/**
 * The smaller pure helpers of `@/lib/flight-itinerary` that every surface
 * leans on (the core model — validation, layover timing, the display view —
 * is pinned in flight-itinerary.test.ts):
 *
 *   - `hasFlightItinerary` is THE test for "itinerary flight or legacy"; the
 *     order model's validation rules and the money wording both branch on
 *     it, so a wrong answer mislabels what a customer paid.
 *   - `toPlainJourney` is the one mapper the order DTO and the consent
 *     snapshot share, so a journey can never be shaped two ways.
 *   - `journeyStopsLabel` is one rule for "Direct / 1 stop / 2 flights" on
 *     the web itinerary, the emails, the mailto and the evidence PDF.
 */

describe("hasFlightItinerary", () => {
  it("is true for a flight with an outbound journey of at least one flight", () => {
    expect(hasFlightItinerary(roundTripFlightInput().flight)).toBe(true);
    expect(
      hasFlightItinerary({ outbound: { segments: [FLIGHT_SEGMENTS.delhiVaranasi()] } }),
    ).toBe(true);
  });

  it("is false for a legacy flat-field flight", () => {
    expect(
      hasFlightItinerary({ origin: "LHR", destination: "JFK" } as never),
    ).toBe(false);
    expect(hasFlightItinerary({ outbound: null })).toBe(false);
  });

  it("is false for no flight, and for an empty outbound journey", () => {
    expect(hasFlightItinerary(null)).toBe(false);
    expect(hasFlightItinerary(undefined)).toBe(false);
    expect(hasFlightItinerary({ outbound: { segments: [] } })).toBe(false);
    expect(hasFlightItinerary({ outbound: { segments: null } })).toBe(false);
  });
});

describe("toPlainJourney", () => {
  it("returns null for a journey with no flights", () => {
    expect(toPlainJourney(null)).toBeNull();
    expect(toPlainJourney(undefined)).toBeNull();
    expect(toPlainJourney({ segments: [] })).toBeNull();
  });

  it("normalises every optional segment field to null", () => {
    const journey = toPlainJourney({
      segments: [
        {
          origin: "Delhi",
          destination: "Varanasi",
          departure: { date: "2026-10-10", time: "10:30" },
          arrival: { date: "2026-10-10", time: "12:00" },
        },
      ],
    });
    expect(journey).toEqual({
      segments: [
        {
          origin: "Delhi",
          destination: "Varanasi",
          departure: { date: "2026-10-10", time: "10:30" },
          arrival: { date: "2026-10-10", time: "12:00" },
          airline: null,
          flightNumber: null,
          details: null,
        },
      ],
      connections: [],
    });
  });

  it("emits EXACTLY one connection per gap, whatever was stored", () => {
    const segments = [
      FLIGHT_SEGMENTS.delhiVaranasi(),
      FLIGHT_SEGMENTS.varanasiMumbai(),
      FLIGHT_SEGMENTS.mumbaiGoa(),
    ];
    const layover = { location: "Varanasi", durationMinutesOverride: 150, notes: "x" };

    // A short array means "no layover recorded" for the missing gap.
    expect(toPlainJourney({ segments, connections: [{ layover }] })!.connections).toEqual([
      { layover },
      { layover: null },
    ]);
    // Extra entries are dropped.
    expect(
      toPlainJourney({
        segments: segments.slice(0, 2),
        connections: [{ layover }, { layover }, { layover }],
      })!.connections,
    ).toEqual([{ layover }]);
    // No array at all.
    expect(toPlainJourney({ segments, connections: null })!.connections).toEqual([
      { layover: null },
      { layover: null },
    ]);
  });

  it("normalises layover fields and refuses a non-finite override", () => {
    const journey = toPlainJourney({
      segments: [FLIGHT_SEGMENTS.delhiVaranasi(), FLIGHT_SEGMENTS.varanasiMumbai()],
      connections: [{ layover: { durationMinutesOverride: Number.NaN } }],
    });
    expect(journey!.connections).toEqual([
      { layover: { location: null, durationMinutesOverride: null, notes: null } },
    ]);
  });

  it("returns plain data detached from its input", () => {
    const source = roundTripFlightInput().flight.outbound;
    const plain = toPlainJourney(source)!;
    expect(plain).toEqual(JSON.parse(JSON.stringify(plain)));
    expect(plain.segments[0]).not.toBe(source.segments[0]);
    expect(plain.segments[0]!.departure).not.toBe(source.segments[0]!.departure);
  });
});

describe("journeyStopsLabel", () => {
  const journeyOf = (n: number) => ({ segments: Array.from({ length: n }) });

  it.each([FlightTripType.ONE_WAY, FlightTripType.ROUND_TRIP])(
    "counts stops on a %s journey",
    (tripType) => {
      expect(journeyStopsLabel(journeyOf(1), tripType)).toBe("Direct");
      expect(journeyStopsLabel(journeyOf(2), tripType)).toBe("1 stop");
      expect(journeyStopsLabel(journeyOf(3), tripType)).toBe("2 stops");
    },
  );

  it("counts FLIGHTS on a multi-city trip — its legs are destinations, not stops", () => {
    expect(journeyStopsLabel(journeyOf(1), FlightTripType.MULTI_CITY)).toBe("1 flight");
    expect(journeyStopsLabel(journeyOf(2), FlightTripType.MULTI_CITY)).toBe("2 flights");
    expect(journeyStopsLabel(journeyOf(3), FlightTripType.MULTI_CITY)).toBe("3 flights");
  });

  it("agrees with the display view of a real multi-city itinerary", () => {
    const view = buildFlightItinerary(multiCityFlightInput().flight)!;
    expect(journeyStopsLabel(view.journeys[0]!, view.tripType)).toBe("3 flights");
  });
});

describe("journey routes", () => {
  it("lists every airport, and shows an airport change as 'landed / departs'", () => {
    const view = buildFlightItinerary({
      tripType: FlightTripType.MULTI_CITY,
      outbound: {
        segments: [
          { origin: "JFK", destination: "LHR", departure: { date: "2026-10-10", time: "18:00" }, arrival: { date: "2026-10-11", time: "06:30" } },
          { origin: "CDG", destination: "FCO", departure: { date: "2026-10-12", time: "09:00" }, arrival: { date: "2026-10-12", time: "11:00" } },
          { origin: "FCO", destination: "JFK", departure: { date: "2026-10-14", time: "10:00" }, arrival: { date: "2026-10-14", time: "14:00" } },
        ],
      },
    })!;
    expect(view.journeys[0]!.route).toBe("JFK → LHR / CDG → FCO → JFK");
  });

  it("is unchanged when every flight leaves from where the last one landed", () => {
    expect(buildFlightItinerary(roundTripFlightInput().flight)!.journeys.map((j) => j.route)).toEqual([
      "Delhi → Varanasi → Mumbai",
      "Mumbai → Varanasi → Delhi",
    ]);
  });

  it("keeps each journey's route to itself — an open-jaw return starts its own route", () => {
    const view = buildFlightItinerary({
      tripType: FlightTripType.ROUND_TRIP,
      outbound: { segments: [FLIGHT_SEGMENTS.delhiVaranasi()] },
      return: {
        segments: [
          { origin: "Lucknow", destination: "Delhi", departure: { date: "2026-10-15", time: "09:00" }, arrival: { date: "2026-10-15", time: "10:15" } },
        ],
      },
    })!;
    expect(view.journeys.map((j) => j.route)).toEqual(["Delhi → Varanasi", "Lucknow → Delhi"]);
  });
});

describe("arrivalNeedsDate — when a flight's arrival must name its day", () => {
  it("names the day when the flight lands on another calendar day", () => {
    expect(
      arrivalNeedsDate({ date: "2026-10-10", time: "22:00" }, { date: "2026-10-11", time: "06:00" }),
    ).toBe(true);
  });

  it("names the day for a date-line arrival: same date, earlier clock time", () => {
    // Tokyo 17:00 → Los Angeles 10:00 the same calendar day.
    expect(
      arrivalNeedsDate({ date: "2026-10-10", time: "17:00" }, { date: "2026-10-10", time: "10:00" }),
    ).toBe(true);
  });

  it("stays quiet for an ordinary same-day flight, or when a time is missing", () => {
    expect(
      arrivalNeedsDate({ date: "2026-10-10", time: "10:30" }, { date: "2026-10-10", time: "12:00" }),
    ).toBe(false);
    expect(arrivalNeedsDate({ date: "2026-10-10", time: "10:30" }, null)).toBe(false);
    expect(arrivalNeedsDate(null, { date: "2026-10-10", time: "12:00" })).toBe(false);
  });
});

describe("display helpers", () => {
  it("appends the time-zone label only for a legacy (UTC) time", () => {
    expect(formatSegmentTime({ date: "2026-10-10", time: "14:30" }, null)).toBe("2:30 PM");
    expect(formatSegmentTime({ date: "2026-10-10", time: "14:30" }, "UTC")).toBe(
      "2:30 PM UTC",
    );
  });

  it("writes the carrier from whatever is known", () => {
    expect(segmentCarrier({ airline: "Air India", flightNumber: "AI123" })).toBe(
      "Air India • AI123",
    );
    expect(segmentCarrier({ airline: "Air India", flightNumber: null })).toBe("Air India");
    expect(segmentCarrier({ airline: null, flightNumber: "AI123" })).toBe("AI123");
    expect(segmentCarrier({ airline: null, flightNumber: null })).toBe("");
  });

  it("joins a local date and time", () => {
    expect(formatLocalDateTime({ date: "2026-10-10", time: "14:30" })).toBe(
      "Sat, Oct 10, 2026 · 2:30 PM",
    );
    expect(formatLocalDateTime({ date: "2026-10-10", time: null })).toBe(
      "Sat, Oct 10, 2026",
    );
  });

  it("truncates with an ellipsis inside the limit", () => {
    expect(truncateText("Delhi", 10)).toBe("Delhi");
    expect(truncateText("Delhi → Varanasi", 10)).toBe("Delhi → V…");
    expect(truncateText("Delhi → Varanasi", 10)).toHaveLength(10);
  });

  it("labels journeys by trip type", () => {
    expect(journeyLabel(FlightTripType.ROUND_TRIP, "outbound")).toBe("Outbound");
    expect(journeyLabel(FlightTripType.ROUND_TRIP, "return")).toBe("Return");
    expect(journeyLabel(FlightTripType.ONE_WAY, "outbound")).toBe("One way");
    expect(journeyLabel(FlightTripType.MULTI_CITY, "outbound")).toBe("Multi-city");
  });

  it("reads anything unknown as a one-way trip", () => {
    expect(normalizeTripType("ROUND_TRIP")).toBe(FlightTripType.ROUND_TRIP);
    expect(normalizeTripType("MULTI_CITY")).toBe(FlightTripType.MULTI_CITY);
    expect(normalizeTripType("ONE_WAY")).toBe(FlightTripType.ONE_WAY);
    expect(normalizeTripType(undefined)).toBe(FlightTripType.ONE_WAY);
    expect(normalizeTripType("SOMETHING_ELSE")).toBe(FlightTripType.ONE_WAY);
  });
});

describe("itinerary summaries", () => {
  const view = buildFlightItinerary(roundTripFlightInput().flight)!;

  it("counts every flight across both directions", () => {
    expect(itinerarySegmentCount(view)).toBe(4);
  });

  it("finds the first departure and the return departure", () => {
    expect(itineraryFirstDeparture(view)).toEqual({ date: "2026-10-10", time: "10:30" });
    expect(itineraryReturnDeparture(view)).toEqual({ date: "2026-10-15", time: "09:00" });
    const oneWay = buildFlightItinerary(multiCityFlightInput().flight)!;
    expect(itineraryReturnDeparture(oneWay)).toBeNull();
  });

  it("reads connections positionally", () => {
    const outbound = roundTripFlightInput().flight.outbound;
    expect(connectionAt(outbound, 0)?.layover?.notes).toBe("Change terminals");
    expect(connectionAt(outbound, 1)).toBeNull();
    expect(connectionAt(null, 0)).toBeNull();
  });

  it("puts wall-clock times on one notional timeline (only differences mean anything)", () => {
    const a = wallClockMinutes({ date: "2026-10-10", time: "22:00" })!;
    const b = wallClockMinutes({ date: "2026-10-11", time: "07:00" })!;
    expect(b - a).toBe(540);
    expect(wallClockMinutes({ date: "2026-10-10", time: "7:00" })).toBeNull();
    expect(wallClockMinutes(null)).toBeNull();
  });
});
