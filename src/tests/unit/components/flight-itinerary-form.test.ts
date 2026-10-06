import { describe, expect, it } from "vitest";
import type { FieldValues, ResolverResult } from "react-hook-form";

import {
  connectionsAroundSwap,
  connectionsLostOnRemove,
  connectionView,
  durationParts,
  emptyLayover,
  emptySegment,
  flagItineraryErrors,
  initialReturnJourney,
  joinDuration,
  layoverCalculatedText,
  normalizeJourneyArrayErrors,
  outboundHeading,
  overridePrefill,
  placeJourneyIssues,
  staleItineraryFlags,
} from "@/components/features/orders/flight/itinerary-form";
import { FlightTripType } from "@/lib/constants/enums";
import {
  CONNECTION_CHRONOLOGY_MESSAGE,
  itineraryIssues,
} from "@/lib/flight-itinerary";
import {
  FLIGHT_SEGMENTS,
  flightJourneyInput,
  flightSegmentInput,
} from "@/tests/fixtures/order-input.fixture";

/**
 * The pure half of the operator's itinerary editor
 * (`src/components/features/orders/flight/itinerary-form.ts`).
 *
 * These are the client's editing rules, as plain functions: a layover
 * belongs to the GAP between two flights, so deleting or reordering flights
 * must say exactly which layovers stop describing the same pair; a problem
 * with how one flight follows another is shown in the row between them; and
 * a cross-flight error blocks the submit but is explained once, not twice.
 */

describe("default rows", () => {
  it("starts a blank flight, optionally carrying the suggested From", () => {
    expect(emptySegment()).toEqual({
      origin: "",
      destination: "",
      departure: { date: "", time: "" },
      arrival: { date: "", time: "" },
      airline: "",
      flightNumber: "",
      details: "",
    });
    expect(emptySegment("Varanasi").origin).toBe("Varanasi");
  });

  it("starts a layover with nothing named and the calculated duration", () => {
    expect(emptyLayover()).toEqual({ location: "", durationMinutesOverride: null, notes: "" });
  });

  it("starts a round trip's return from where the outbound ends, back to where it began", () => {
    const back = initialReturnJourney([
      FLIGHT_SEGMENTS.delhiVaranasi(),
      FLIGHT_SEGMENTS.varanasiMumbai(),
    ]);
    expect(back.segments).toHaveLength(1);
    expect(back.segments[0]).toMatchObject({ origin: "Mumbai", destination: "Delhi" });
    expect(back.connections).toEqual([]);
    expect(initialReturnJourney([]).segments[0]).toMatchObject({ origin: "", destination: "" });
  });

  it("heads the outbound journey for each trip type", () => {
    expect(outboundHeading(FlightTripType.ONE_WAY)).toBe("Flights");
    expect(outboundHeading(FlightTripType.ROUND_TRIP)).toBe("Outbound");
    expect(outboundHeading(FlightTripType.MULTI_CITY)).toBe("Multi-city flights");
  });
});

describe("connection bookkeeping", () => {
  it("knows which layovers a deleted flight takes with it", () => {
    expect(connectionsLostOnRemove(1, 0)).toEqual([]);
    expect(connectionsLostOnRemove(3, 0)).toEqual([0]); // first flight
    expect(connectionsLostOnRemove(3, 2)).toEqual([1]); // last flight
    expect(connectionsLostOnRemove(4, 1)).toEqual([0, 1]); // a middle flight
  });

  it("knows which gaps stop describing the same pair when two flights swap", () => {
    expect(connectionsAroundSwap(2, 0)).toEqual([0]);
    expect(connectionsAroundSwap(3, 0)).toEqual([0, 1]);
    expect(connectionsAroundSwap(3, 1)).toEqual([0, 1]);
    expect(connectionsAroundSwap(5, 2)).toEqual([1, 2, 3]);
  });
});

describe("placeJourneyIssues — each issue where the operator will look for it", () => {
  it("puts a chronology error and an airport mismatch in the row BETWEEN the two flights", () => {
    const issues = itineraryIssues({
      tripType: FlightTripType.ONE_WAY,
      outbound: flightJourneyInput([
        FLIGHT_SEGMENTS.delhiVaranasi(),
        flightSegmentInput("Lucknow", "Mumbai", ["2026-10-10", "11:00"], ["2026-10-10", "13:00"]),
      ]),
    });
    const slots = placeJourneyIssues(issues, "outbound", 2);
    expect(slots.connections[0]!.map((i) => i.message)).toEqual([
      CONNECTION_CHRONOLOGY_MESSAGE,
      expect.stringContaining("departs from Lucknow"),
    ]);
    expect(slots.segments).toEqual([[], []]);
    expect(slots.journey).toEqual([]);
  });

  it("puts a same-airport or arrival problem under the flight itself", () => {
    const issues = itineraryIssues({
      tripType: FlightTripType.ONE_WAY,
      outbound: flightJourneyInput([
        flightSegmentInput("DEL", "del", ["2026-10-10", "10:00"], ["2026-10-08", "09:00"]),
      ]),
    });
    const slots = placeJourneyIssues(issues, "outbound", 1);
    expect(slots.segments[0]!.map((i) => i.path.slice(3).join("."))).toEqual([
      "destination",
      "arrival.date",
    ]);
    expect(slots.connections).toEqual([]);
  });

  it("keeps journey-level issues at the journey, and ignores the other journey's", () => {
    const multi = itineraryIssues({
      tripType: FlightTripType.MULTI_CITY,
      outbound: flightJourneyInput([FLIGHT_SEGMENTS.delhiVaranasi()]),
    });
    expect(placeJourneyIssues(multi, "outbound", 1).journey.map((i) => i.message)).toEqual([
      "A multi-city trip needs at least two flights.",
    ]);

    const noReturn = itineraryIssues({
      tripType: FlightTripType.ROUND_TRIP,
      outbound: flightJourneyInput([FLIGHT_SEGMENTS.delhiVaranasi()]),
      return: null,
    });
    expect(placeJourneyIssues(noReturn, "return", 0).journey.map((i) => i.message)).toEqual([
      "Add the return flight.",
    ]);
    expect(placeJourneyIssues(noReturn, "outbound", 1).journey).toEqual([]);
  });

  it("drops an issue that points past a just-deleted flight", () => {
    const slots = placeJourneyIssues(
      [
        {
          severity: "error",
          path: ["outbound", "segments", 3, "departure", "date"],
          message: CONNECTION_CHRONOLOGY_MESSAGE,
        },
      ],
      "outbound",
      2,
    );
    expect(slots.connections).toEqual([[]]);
    expect(slots.segments).toEqual([[], []]);
  });
});

describe("connectionView — the gap line between two flights", () => {
  it("describes a same-day connection with its calculated duration", () => {
    const view = connectionView(
      flightJourneyInput([FLIGHT_SEGMENTS.delhiVaranasi(), FLIGHT_SEGMENTS.varanasiMumbai()], [
        { layover: { location: null, durationMinutesOverride: null, notes: null } },
      ]),
      0,
    );
    expect(view).toEqual({
      gap: "Lands Varanasi 12:00 PM · next departs 2:30 PM · 2h 30m",
      arrivalAirport: "Varanasi",
      calculatedMinutes: 150,
      hasLayover: true,
    });
  });

  it("names the day of an overnight connection", () => {
    const view = connectionView(
      flightJourneyInput([
        flightSegmentInput("Delhi", "Varanasi", ["2026-10-10", "20:00"], ["2026-10-10", "22:00"]),
        flightSegmentInput("Varanasi", "Mumbai", ["2026-10-11", "07:00"], ["2026-10-11", "09:00"]),
      ]),
      0,
    );
    expect(view.gap).toBe("Lands Varanasi 10:00 PM · next departs Oct 11, 7:00 AM · 9h");
    expect(view.hasLayover).toBe(false);
  });

  it("shows no duration for an impossible (negative) gap", () => {
    const view = connectionView(
      flightJourneyInput([
        FLIGHT_SEGMENTS.delhiVaranasi(),
        flightSegmentInput("Varanasi", "Mumbai", ["2026-10-10", "11:30"], ["2026-10-10", "13:30"]),
      ]),
      0,
    );
    expect(view.gap).toBe("Lands Varanasi 12:00 PM · next departs 11:30 AM");
    expect(view.calculatedMinutes).toBe(-30);
  });

  it("asks for the times until both flights have them", () => {
    expect(connectionView({ segments: [{}, {}] }, 0).gap).toBe(
      "Enter both flights' times to see the connection.",
    );
    expect(
      connectionView({ segments: [{ destination: "Varanasi" }, {}] }, 0).gap,
    ).toBe("Lands Varanasi");
  });
});

describe("layover duration inputs", () => {
  it("words the calculated duration", () => {
    expect(layoverCalculatedText(150)).toBe("Calculated: 2h 30m");
    expect(layoverCalculatedText(null)).toBe("Calculated: — (enter both flights' times)");
    expect(layoverCalculatedText(-30)).toBe("Calculated: —");
  });

  it("pre-fills an override with the calculated duration when there is a usable one", () => {
    expect(overridePrefill(150)).toBe(150);
    expect(overridePrefill(null)).toBe(0);
    expect(overridePrefill(-30)).toBe(0);
  });

  it("splits and joins hours and minutes, counting a cleared input as zero", () => {
    expect(durationParts(150)).toEqual({ hours: 2, minutes: 30 });
    expect(durationParts(-5)).toEqual({ hours: 0, minutes: 0 });
    expect(joinDuration(2, 30)).toBe(150);
    expect(joinDuration("", 90)).toBe(90); // 90 minutes is simply 1h 30m
    expect(joinDuration("1", "30")).toBe(90);
    expect(joinDuration("abc", 5)).toBe(5);
  });
});

describe("cross-flight errors are explained once", () => {
  const impossible = {
    tripType: FlightTripType.ONE_WAY,
    outbound: flightJourneyInput([
      FLIGHT_SEGMENTS.delhiVaranasi(),
      flightSegmentInput("Varanasi", "", ["2026-10-10", "11:30"], ["2026-10-10", "13:30"]),
    ]),
  };

  function resolverResult(): ResolverResult<FieldValues> {
    return {
      values: {},
      errors: {
        flight: {
          outbound: {
            segments: [
              undefined,
              {
                departure: {
                  date: { type: "custom", message: CONNECTION_CHRONOLOGY_MESSAGE },
                },
                destination: { type: "too_small", message: "To is required" },
              },
            ],
          },
        },
      },
    } as unknown as ResolverResult<FieldValues>;
  }

  it("keeps the flag but blanks the message of an itinerary error the editor already shows", () => {
    const result = flagItineraryErrors(resolverResult(), impossible);
    type FieldError = { type: string; message: string };
    const segment = (
      result.errors as unknown as {
        flight: {
          outbound: {
            segments: ({ departure: { date: FieldError }; destination: FieldError } | undefined)[];
          };
        };
      }
    ).flight.outbound.segments[1]!;
    expect(segment.departure.date).toEqual({ type: "custom", message: "" });
    // A plain field error is not an itinerary issue: left alone.
    expect(segment.destination).toEqual({ type: "too_small", message: "To is required" });
  });

  it("is a no-op on a successful parse", () => {
    const ok = { values: { flight: {} }, errors: {} } as ResolverResult<FieldValues>;
    expect(flagItineraryErrors(ok, impossible)).toBe(ok);
  });

  it("finds blanked flags whose cause has since been fixed", () => {
    const flagged = flagItineraryErrors(resolverResult(), impossible).errors as Record<
      string,
      unknown
    >;
    // Still impossible: nothing stale.
    expect(staleItineraryFlags(flagged.flight, itineraryIssues(impossible))).toEqual([]);
    // Fixed: the blanked chronology flag is stale; the real message is not.
    expect(staleItineraryFlags(flagged.flight, [])).toEqual([
      "flight.outbound.segments.1.departure.date",
    ]);
  });
});

describe("normalizeJourneyArrayErrors — segment errors in the shape a field array expects", () => {
  type Segments = unknown[] & { root?: unknown };
  const segmentsOf = (result: ResolverResult<FieldValues>, journey: "outbound" | "return") =>
    (result.errors as unknown as {
      flight?: Record<string, { segments?: Segments } | undefined>;
    }).flight?.[journey]?.segments;
  const withErrors = (errors: Record<string, unknown>) =>
    ({ values: {}, errors }) as unknown as ResolverResult<FieldValues>;

  it("turns a plain { 0: …, root: … } object into an array with .root", () => {
    const flightError = { departure: { date: { type: "custom", message: "" } } };
    const rootError = { type: "custom", message: "A multi-city trip needs at least two flights." };
    const result = normalizeJourneyArrayErrors(
      withErrors({ flight: { outbound: { segments: { 0: flightError, root: rootError } } } }),
    );
    const segments = segmentsOf(result, "outbound")!;
    expect(Array.isArray(segments)).toBe(true);
    expect(segments[0]).toEqual(flightError);
    expect(segments.root).toEqual(rootError);
  });

  it("moves a bare list error (the array-only re-validation) onto .root", () => {
    const result = normalizeJourneyArrayErrors(
      withErrors({
        flight: {
          outbound: {
            segments: { type: "custom", message: "A multi-city trip needs at least two flights." },
          },
        },
      }),
    );
    const segments = segmentsOf(result, "outbound")!;
    expect(Array.isArray(segments)).toBe(true);
    expect(segments).toHaveLength(0);
    expect(segments.root).toMatchObject({
      type: "custom",
      message: "A multi-city trip needs at least two flights.",
    });
  });

  it("normalises the return journey too, and leaves arrays and absent errors alone", () => {
    const already: Segments = [undefined, { origin: { type: "too_small", message: "From is required" } }];
    const result = normalizeJourneyArrayErrors(
      withErrors({
        flight: {
          outbound: { segments: already },
          return: { segments: { 1: { origin: { type: "too_small", message: "From is required" } } } },
        },
      }),
    );
    expect(segmentsOf(result, "outbound")).toBe(already);
    const back = segmentsOf(result, "return")!;
    expect(Array.isArray(back)).toBe(true);
    expect(back[1]).toEqual({ origin: { type: "too_small", message: "From is required" } });
    expect(back.root).toBeUndefined();

    const untouched = withErrors({ customer: { name: { type: "too_small", message: "x" } } });
    expect(normalizeJourneyArrayErrors(untouched).errors).toEqual({
      customer: { name: { type: "too_small", message: "x" } },
    });
  });
});
