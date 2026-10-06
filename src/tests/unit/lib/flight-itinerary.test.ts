import { describe, expect, it } from "vitest";

import { FlightTripType } from "@/lib/constants/enums";
import {
  buildFlightItinerary,
  CONNECTION_CHRONOLOGY_MESSAGE,
  formatDuration,
  formatLocalDate,
  formatLocalTime,
  type FlightJourney,
  type FlightSegment,
  isLocalDate,
  isLocalTime,
  itineraryIssues,
  layoverLocation,
  layoverTiming,
  minutesBetween,
} from "@/lib/flight-itinerary";

/**
 * The itinerary model every surface renders. Pure functions, so this file
 * pins the client's rules directly: layover = next departure − previous
 * arrival (overnight included), an override never replaces the timestamps,
 * a layover belongs to the connection between two flights, and an
 * impossible connection is refused with the client's exact wording.
 */

function seg(
  origin: string,
  destination: string,
  dep: [string, string],
  arr: [string, string],
  extra: Partial<FlightSegment> = {},
): FlightSegment {
  return {
    origin,
    destination,
    departure: { date: dep[0], time: dep[1] },
    arrival: { date: arr[0], time: arr[1] },
    airline: null,
    flightNumber: null,
    details: null,
    ...extra,
  };
}

const DEL_VNS = seg("Delhi", "Varanasi", ["2026-10-10", "10:30"], ["2026-10-10", "12:00"], {
  airline: "Air India",
  flightNumber: "AI123",
});
const VNS_BOM = seg("Varanasi", "Mumbai", ["2026-10-10", "14:30"], ["2026-10-10", "16:30"], {
  airline: "IndiGo",
  flightNumber: "6E456",
});
const BOM_GOI = seg("Mumbai", "Goa", ["2026-10-10", "19:45"], ["2026-10-10", "21:00"]);

describe("local date/time primitives", () => {
  it("accepts only real calendar dates and 24h times", () => {
    expect(isLocalDate("2026-10-10")).toBe(true);
    expect(isLocalDate("2026-02-30")).toBe(false);
    expect(isLocalDate("10/10/2026")).toBe(false);
    expect(isLocalTime("00:00")).toBe(true);
    expect(isLocalTime("23:59")).toBe(true);
    expect(isLocalTime("24:00")).toBe(false);
    expect(isLocalTime("7:00")).toBe(false);
  });

  it("formats durations the way the client writes them", () => {
    expect(formatDuration(150)).toBe("2h 30m");
    expect(formatDuration(540)).toBe("9h");
    expect(formatDuration(195)).toBe("3h 15m");
    expect(formatDuration(45)).toBe("45m");
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(1530)).toBe("1d 1h 30m");
  });

  it("formats airport-local dates and times without any time zone shift", () => {
    expect(formatLocalTime("10:30")).toBe("10:30 AM");
    expect(formatLocalTime("12:00")).toBe("12:00 PM");
    expect(formatLocalTime("00:05")).toBe("12:05 AM");
    expect(formatLocalTime("14:30")).toBe("2:30 PM");
    expect(formatLocalDate("2026-10-10")).toBe("Sat, Oct 10, 2026");
    expect(formatLocalDate("2026-10-10", { short: true })).toBe("Oct 10");
  });

  it("measures minutes across midnight using the full dates", () => {
    expect(
      minutesBetween(
        { date: "2026-10-10", time: "22:00" },
        { date: "2026-10-11", time: "07:00" },
      ),
    ).toBe(540);
    expect(minutesBetween({ date: "2026-10-10", time: "" }, { date: "2026-10-10", time: "07:00" })).toBeNull();
  });
});

describe("layover timing (connection between segment i and i + 1)", () => {
  const journey: FlightJourney = {
    segments: [DEL_VNS, VNS_BOM, BOM_GOI],
    connections: [
      { layover: { location: null, durationMinutesOverride: null, notes: null } },
      { layover: { location: null, durationMinutesOverride: 200, notes: "Change terminals" } },
    ],
  };

  it("calculates next departure minus previous arrival", () => {
    expect(layoverTiming(journey, 0)).toEqual({
      calculatedMinutes: 150,
      overrideMinutes: null,
      effectiveMinutes: 150,
    });
  });

  it("keeps the calculated value alongside an explicit override", () => {
    // 16:30 → 19:45 is 3h 15m; the operator typed 3h 20m over it.
    expect(layoverTiming(journey, 1)).toEqual({
      calculatedMinutes: 195,
      overrideMinutes: 200,
      effectiveMinutes: 200,
    });
  });

  it("supports an overnight layover", () => {
    const overnight: FlightJourney = {
      segments: [
        seg("Delhi", "Varanasi", ["2026-10-10", "20:00"], ["2026-10-10", "22:00"]),
        seg("Varanasi", "Mumbai", ["2026-10-11", "07:00"], ["2026-10-11", "09:00"]),
      ],
      connections: [{ layover: {} }],
    };
    expect(layoverTiming(overnight, 0).effectiveMinutes).toBe(540);
    expect(formatDuration(layoverTiming(overnight, 0).effectiveMinutes!)).toBe("9h");
  });

  it("never shows a negative calculated duration", () => {
    const backwards: FlightJourney = {
      segments: [DEL_VNS, seg("Varanasi", "Mumbai", ["2026-10-10", "11:00"], ["2026-10-10", "13:00"])],
      connections: [{ layover: {} }],
    };
    expect(layoverTiming(backwards, 0)).toEqual({
      calculatedMinutes: -60,
      overrideMinutes: null,
      effectiveMinutes: null,
    });
  });

  it("derives the place from the previous arrival unless the operator named one", () => {
    expect(layoverLocation(journey, 0)).toBe("Varanasi");
    const renamed: FlightJourney = {
      segments: [DEL_VNS, VNS_BOM],
      connections: [{ layover: { location: "Varanasi (VNS) — Terminal 2" } }],
    };
    expect(layoverLocation(renamed, 0)).toBe("Varanasi (VNS) — Terminal 2");
  });
});

describe("itineraryIssues", () => {
  it("accepts a valid connecting one-way", () => {
    const issues = itineraryIssues({
      tripType: FlightTripType.ONE_WAY,
      outbound: { segments: [DEL_VNS, VNS_BOM], connections: [{ layover: null }] },
    });
    expect(issues).toEqual([]);
  });

  it("refuses a next flight that departs before the previous one arrives", () => {
    const issues = itineraryIssues({
      tripType: FlightTripType.ONE_WAY,
      outbound: {
        segments: [DEL_VNS, seg("Varanasi", "Mumbai", ["2026-10-10", "11:30"], ["2026-10-10", "13:30"])],
      },
    });
    expect(issues).toContainEqual({
      severity: "error",
      path: ["outbound", "segments", 1, "departure", "date"],
      message: CONNECTION_CHRONOLOGY_MESSAGE,
    });
    expect(CONNECTION_CHRONOLOGY_MESSAGE).toBe(
      "Please check the flight times. The next flight departs before the previous flight arrives.",
    );
  });

  it("does not treat an overnight connection as impossible", () => {
    const issues = itineraryIssues({
      tripType: FlightTripType.ONE_WAY,
      outbound: {
        segments: [
          seg("Delhi", "Varanasi", ["2026-10-10", "20:00"], ["2026-10-10", "22:00"]),
          seg("Varanasi", "Mumbai", ["2026-10-11", "07:00"], ["2026-10-11", "09:00"]),
        ],
      },
    });
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("warns, but does not block, when connecting airports differ", () => {
    const issues = itineraryIssues({
      tripType: FlightTripType.ONE_WAY,
      outbound: {
        segments: [
          DEL_VNS,
          seg("Lucknow", "Mumbai", ["2026-10-10", "18:00"], ["2026-10-10", "20:00"]),
        ],
      },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: "warning",
      path: ["outbound", "segments", 1, "origin"],
    });
  });

  it("refuses the same airport as From and To", () => {
    const issues = itineraryIssues({
      tripType: FlightTripType.ONE_WAY,
      outbound: { segments: [seg("DEL", "del", ["2026-10-10", "10:00"], ["2026-10-10", "11:00"])] },
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: "error", path: ["outbound", "segments", 0, "destination"] }),
    );
  });

  it("warns on a date-line arrival but refuses an arrival over a day early", () => {
    const dateLine = itineraryIssues({
      tripType: FlightTripType.ONE_WAY,
      outbound: { segments: [seg("Tokyo", "Los Angeles", ["2026-10-10", "17:00"], ["2026-10-10", "10:00"])] },
    });
    expect(dateLine).toEqual([
      expect.objectContaining({ severity: "warning", path: ["outbound", "segments", 0, "arrival", "date"] }),
    ]);
    const typo = itineraryIssues({
      tripType: FlightTripType.ONE_WAY,
      outbound: { segments: [seg("Tokyo", "Los Angeles", ["2026-10-10", "17:00"], ["2026-10-08", "10:00"])] },
    });
    expect(typo).toEqual([
      expect.objectContaining({ severity: "error", path: ["outbound", "segments", 0, "arrival", "date"] }),
    ]);
  });

  it("needs two flights for a multi-city trip", () => {
    const issues = itineraryIssues({
      tripType: FlightTripType.MULTI_CITY,
      outbound: { segments: [DEL_VNS] },
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ severity: "error", path: ["outbound", "segments"] }),
    );
  });

  it("needs a return journey for a round trip, departing after the outbound arrives", () => {
    expect(
      itineraryIssues({ tripType: FlightTripType.ROUND_TRIP, outbound: { segments: [DEL_VNS] }, return: null }),
    ).toContainEqual(expect.objectContaining({ severity: "error", path: ["return"] }));

    const early = itineraryIssues({
      tripType: FlightTripType.ROUND_TRIP,
      outbound: { segments: [DEL_VNS, VNS_BOM] },
      return: { segments: [seg("Mumbai", "Delhi", ["2026-10-10", "15:00"], ["2026-10-10", "17:00"])] },
    });
    expect(early).toContainEqual(
      expect.objectContaining({ severity: "error", path: ["return", "segments", 0, "departure", "date"] }),
    );
  });

  it("checks each round-trip direction on its own connections", () => {
    const issues = itineraryIssues({
      tripType: FlightTripType.ROUND_TRIP,
      outbound: { segments: [DEL_VNS, VNS_BOM] },
      return: {
        segments: [
          seg("Mumbai", "Varanasi", ["2026-10-15", "09:00"], ["2026-10-15", "11:00"]),
          seg("Varanasi", "Delhi", ["2026-10-15", "10:00"], ["2026-10-15", "12:00"]),
        ],
      },
    });
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([
      {
        severity: "error",
        path: ["return", "segments", 1, "departure", "date"],
        message: CONNECTION_CHRONOLOGY_MESSAGE,
      },
    ]);
  });
});

describe("buildFlightItinerary", () => {
  it("numbers segments and attaches layovers to the connection they sit on", () => {
    const view = buildFlightItinerary({
      tripType: FlightTripType.ONE_WAY,
      outbound: {
        segments: [DEL_VNS, VNS_BOM, BOM_GOI],
        connections: [
          { layover: { location: null, durationMinutesOverride: null, notes: null } },
          { layover: null },
        ],
      },
    })!;
    expect(view.legacy).toBe(false);
    expect(view.journeys).toHaveLength(1);
    const [journey] = view.journeys;
    expect(journey.label).toBe("One way");
    expect(journey.route).toBe("Delhi → Varanasi → Mumbai → Goa");
    expect(journey.segments.map((s) => s.number)).toEqual([1, 2, 3]);
    expect(journey.connections).toEqual([
      {
        after: 1,
        layover: {
          location: "Varanasi",
          calculatedMinutes: 150,
          overrideMinutes: null,
          minutes: 150,
          notes: null,
        },
      },
      { after: 2, layover: null },
    ]);
    expect(journey.timeZoneLabel).toBeNull();
  });

  it("keeps a round trip's outbound and return independent", () => {
    const view = buildFlightItinerary({
      tripType: FlightTripType.ROUND_TRIP,
      outbound: { segments: [DEL_VNS, VNS_BOM], connections: [{ layover: {} }] },
      return: {
        segments: [
          seg("Mumbai", "Varanasi", ["2026-10-15", "09:00"], ["2026-10-15", "11:00"]),
          seg("Varanasi", "Delhi", ["2026-10-15", "13:00"], ["2026-10-15", "14:30"]),
        ],
        connections: [{ layover: { durationMinutesOverride: 90 } }],
      },
    })!;
    expect(view.journeys.map((j) => j.label)).toEqual(["Outbound", "Return"]);
    expect(view.journeys[0].connections[0].layover?.minutes).toBe(150);
    expect(view.journeys[1].connections[0].layover).toMatchObject({
      location: "Varanasi",
      calculatedMinutes: 120,
      overrideMinutes: 90,
      minutes: 90,
    });
  });

  it("drops a stray return journey on a one-way trip", () => {
    const view = buildFlightItinerary({
      tripType: FlightTripType.ONE_WAY,
      outbound: { segments: [DEL_VNS] },
      return: { segments: [VNS_BOM] },
    })!;
    expect(view.journeys).toHaveLength(1);
  });

  it("labels a multi-city itinerary", () => {
    const view = buildFlightItinerary({
      tripType: FlightTripType.MULTI_CITY,
      outbound: { segments: [DEL_VNS, VNS_BOM] },
    })!;
    expect(view.journeys[0].label).toBe("Multi-city");
  });

  it("renders a legacy flat flight as one UTC-labelled segment", () => {
    const view = buildFlightItinerary({
      tripType: "ONE_WAY",
      origin: "LHR",
      destination: "JFK",
      departureDate: "2026-11-01T09:15:00.000Z",
      arrivalDate: new Date("2026-11-01T17:40:00.000Z"),
      airline: "British Airways",
      flightNumber: "BA117",
    })!;
    expect(view.legacy).toBe(true);
    expect(view.journeys).toHaveLength(1);
    expect(view.journeys[0].timeZoneLabel).toBe("UTC");
    expect(view.journeys[0].segments[0]).toEqual({
      number: 1,
      origin: "LHR",
      destination: "JFK",
      airline: "British Airways",
      flightNumber: "BA117",
      details: null,
      departure: { date: "2026-11-01", time: "09:15" },
      arrival: { date: "2026-11-01", time: "17:40" },
    });
  });

  it("renders a legacy round trip's return date as the reversed route", () => {
    const view = buildFlightItinerary({
      tripType: "ROUND_TRIP",
      origin: "LHR",
      destination: "JFK",
      departureDate: "2026-11-01T09:15:00.000Z",
      returnDate: "2026-11-08T20:00:00.000Z",
    })!;
    expect(view.journeys.map((j) => j.label)).toEqual(["Outbound", "Return"]);
    expect(view.journeys[1].segments[0]).toMatchObject({
      origin: "JFK",
      destination: "LHR",
      departure: { date: "2026-11-08", time: "20:00" },
      arrival: null,
    });
  });

  it("returns null when there is nothing to render", () => {
    expect(buildFlightItinerary(null)).toBeNull();
    expect(buildFlightItinerary({ tripType: "ONE_WAY" })).toBeNull();
  });
});
