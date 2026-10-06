import type { z } from "zod";
import {
  get,
  set,
  type FieldValues,
  type ResolverResult,
} from "react-hook-form";

import { FlightTripType } from "@/lib/constants/enums";
import {
  connectionAt,
  type FlightItineraryInputLike,
  type FlightJourneyKey,
  type FlightJourneyLike,
  type FlightSegmentLike,
  formatDuration,
  formatLocalDate,
  formatLocalTime,
  isLocalDate,
  isLocalTime,
  type ItineraryIssue,
  itineraryIssues,
  layoverTiming,
} from "@/lib/flight-itinerary";
import type { flightOrderSchema } from "@/lib/validation";

/**
 * The pure half of the operator's flight itinerary editor: default rows,
 * the bookkeeping that keeps connections aligned with segments, where each
 * live itinerary issue is shown, and the wording of a connection.
 *
 * No React in here on purpose — every rule the client asked for (layovers
 * belong to the gap between two flights, a discarded layover is never
 * silent, a cross-flight error is explained once) is a plain function the
 * components call, so it can be read and tested on its own.
 */

/** Form state of the flight tab. `z.input`, not `z.output`: the schema's
 *  coercions, defaults and journey normalisation make the two differ. */
export type FlightOrderFormValues = z.input<typeof flightOrderSchema>;
export type FlightJourneyFormValue = NonNullable<
  FlightOrderFormValues["flight"]["return"]
>;
export type FlightSegmentFormValue = FlightJourneyFormValue["segments"][number];
type FlightConnectionFormValue = NonNullable<
  FlightJourneyFormValue["connections"]
>[number];
export type FlightLayoverFormValue = NonNullable<
  FlightConnectionFormValue["layover"]
>;

/** A blank flight. `origin` is the suggestion carried over from the
 *  previous flight's To, if there is one. */
export function emptySegment(
  origin = "",
  destination = "",
): FlightSegmentFormValue {
  return {
    origin,
    destination,
    departure: { date: "", time: "" },
    arrival: { date: "", time: "" },
    airline: "",
    flightNumber: "",
    details: "",
  };
}

/** What "+ Add Layover" starts from: nothing named, the calculated
 *  duration, no notes. */
export function emptyLayover(): FlightLayoverFormValue {
  return { location: "", durationMinutesOverride: null, notes: "" };
}

/** The return journey a round trip starts with: one flight from where the
 *  outbound journey ends back to where it began. */
export function initialReturnJourney(
  outbound: readonly FlightSegmentLike[] | null | undefined,
): FlightJourneyFormValue {
  const first = outbound?.[0];
  const last = outbound?.[outbound.length - 1];
  return {
    segments: [
      emptySegment(
        (last?.destination ?? "").trim(),
        (first?.origin ?? "").trim(),
      ),
    ],
    connections: [],
  };
}

/** Heading of the outbound (or only) journey for each trip type. */
export function outboundHeading(tripType: FlightTripType): string {
  switch (tripType) {
    case FlightTripType.ROUND_TRIP:
      return "Outbound";
    case FlightTripType.MULTI_CITY:
      return "Multi-city flights";
    case FlightTripType.ONE_WAY:
    default:
      return "Flights";
  }
}

export function hasLayover(
  connection: { layover?: unknown } | null | undefined,
): boolean {
  return connection?.layover != null;
}

/**
 * Connections whose layover is lost when segment `index` of `count` is
 * deleted. The first and last flights each touch one connection; a middle
 * flight sits between two, which merge into a single new (empty) one.
 */
export function connectionsLostOnRemove(count: number, index: number): number[] {
  if (count <= 1) return [];
  if (index === 0) return [0];
  if (index === count - 1) return [count - 2];
  return [index - 1, index];
}

/**
 * Connections that stop describing the same pair of flights when segments
 * `upper` and `upper + 1` swap places: the gap between them, and the gap on
 * either side.
 */
export function connectionsAroundSwap(count: number, upper: number): number[] {
  return [upper - 1, upper, upper + 1].filter((c) => c >= 0 && c <= count - 2);
}

/* ------------------------------------------------------------------ *
 * Where each live issue is shown.
 * ------------------------------------------------------------------ */

export interface JourneyIssueSlots {
  /** About the journey as a whole, e.g. a multi-city trip of one flight. */
  journey: ItineraryIssue[];
  /** Under each flight, by segment index. */
  segments: ItineraryIssue[][];
  /** In each connection row, by connection index. */
  connections: ItineraryIssue[][];
}

/**
 * Sort `itineraryIssues` output into the places the editor shows them.
 *
 * A problem with how flight i+1 FOLLOWS flight i — it leaves before flight
 * i lands, or from another airport — is a problem with the connection, so
 * it goes in the row between the two. Everything else about a flight goes
 * under that flight. Issues pointing past the end of the journey (the
 * watched values can be a render behind a just-deleted flight) are dropped;
 * they are recomputed on the next render.
 */
export function placeJourneyIssues(
  issues: readonly ItineraryIssue[],
  journey: FlightJourneyKey,
  segmentCount: number,
): JourneyIssueSlots {
  const slots: JourneyIssueSlots = {
    journey: [],
    segments: Array.from({ length: segmentCount }, () => []),
    connections: Array.from({ length: Math.max(0, segmentCount - 1) }, () => []),
  };
  for (const issue of issues) {
    const [key, group, index, ...field] = issue.path;
    if (key !== journey) continue;
    if (group !== "segments" || typeof index !== "number") {
      slots.journey.push(issue);
      continue;
    }
    const at = field.join(".");
    if (index > 0 && (at === "departure.date" || at === "origin")) {
      slots.connections[index - 1]?.push(issue);
    } else {
      slots.segments[index]?.push(issue);
    }
  }
  return slots;
}

/* ------------------------------------------------------------------ *
 * Connection wording.
 * ------------------------------------------------------------------ */

export interface ConnectionView {
  /** "Lands Varanasi 12:00 PM · next departs 2:30 PM · 2h 30m". */
  gap: string;
  /** Where the previous flight lands — the layover's place when the
   *  operator names none. */
  arrivalAirport: string;
  /** Next departure − previous arrival; null until both are entered. */
  calculatedMinutes: number | null;
  hasLayover: boolean;
}

/** Everything a connection row shows, from the journey's live values. */
export function connectionView(
  journey: FlightJourneyLike | null | undefined,
  index: number,
): ConnectionView {
  const segments = journey?.segments ?? [];
  const prev = segments[index] ?? {};
  const next = segments[index + 1] ?? {};
  const { calculatedMinutes } = layoverTiming(journey, index);
  return {
    gap: connectionGapText(prev, next, calculatedMinutes),
    arrivalAirport: (prev.destination ?? "").trim(),
    calculatedMinutes,
    hasLayover: hasLayover(connectionAt(journey, index)),
  };
}

function connectionGapText(
  prev: FlightSegmentLike,
  next: FlightSegmentLike,
  minutes: number | null,
): string {
  const parts: string[] = [];

  const airport = (prev.destination ?? "").trim();
  const lands = isLocalTime(prev.arrival?.time)
    ? formatLocalTime(prev.arrival.time)
    : "";
  if (airport || lands) {
    parts.push(["Lands", airport, lands].filter(Boolean).join(" "));
  }

  const departs = isLocalTime(next.departure?.time)
    ? formatLocalTime(next.departure.time)
    : "";
  if (departs) {
    // An overnight connection says which day the next flight leaves.
    const nextDate = next.departure?.date;
    const otherDay =
      isLocalDate(nextDate) &&
      isLocalDate(prev.arrival?.date) &&
      nextDate !== prev.arrival?.date;
    parts.push(
      otherDay
        ? `next departs ${formatLocalDate(nextDate, { short: true })}, ${departs}`
        : `next departs ${departs}`,
    );
  }

  // A negative gap is an impossible itinerary; its error is shown instead.
  if (minutes !== null && minutes >= 0) parts.push(formatDuration(minutes));

  return parts.length > 0
    ? parts.join(" · ")
    : "Enter both flights' times to see the connection.";
}

/** "Calculated: 2h 30m" — the duration the flight times give. */
export function layoverCalculatedText(minutes: number | null): string {
  if (minutes === null) return "Calculated: — (enter both flights' times)";
  if (minutes < 0) return "Calculated: —";
  return `Calculated: ${formatDuration(minutes)}`;
}

/** What "Override duration" starts from: the calculated duration when there
 *  is a usable one, otherwise zero for the operator to type over. */
export function overridePrefill(calculatedMinutes: number | null): number {
  return calculatedMinutes !== null && calculatedMinutes > 0
    ? calculatedMinutes
    : 0;
}

/** 150 → { hours: 2, minutes: 30 }. */
export function durationParts(total: number): { hours: number; minutes: number } {
  const whole = Math.max(0, Math.floor(total));
  return { hours: Math.floor(whole / 60), minutes: whole % 60 };
}

/** The hours + minutes inputs back to a minute total. A cleared input
 *  counts as zero; 90 minutes is simply 1h 30m. */
export function joinDuration(
  hours: number | string,
  minutes: number | string,
): number {
  const whole = (v: number | string) => Math.max(0, Math.floor(Number(v) || 0));
  return whole(hours) * 60 + whole(minutes);
}

/* ------------------------------------------------------------------ *
 * Cross-flight errors, explained once.
 *
 * `flightOrderSchema` turns every itinerary error into a field error at the
 * flight it concerns (`flight.outbound.segments.1.departure.date`), which
 * is what blocks the submit and focuses the field. The editor already
 * explains each of those errors in the connection row or under the flight,
 * from the same `itineraryIssues` call — so the resolver keeps the error
 * (field flagged red, submit blocked) but blanks its message, and
 * `<FormMessage>` renders nothing instead of a second copy.
 *
 * RHF only re-validates the field being edited, so a flag can outlive its
 * cause (fixing flight 1's arrival does not touch flight 2's departure).
 * `staleItineraryFlags` finds those for the editor to clear.
 * ------------------------------------------------------------------ */

function isFieldError(
  value: unknown,
): value is { type: string; message?: string } {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/** Resolver post-step: blank the message of each itinerary error. */
export function flagItineraryErrors<
  TFieldValues extends FieldValues,
  TTransformedValues,
>(
  result: ResolverResult<TFieldValues, TTransformedValues>,
  flight: FlightItineraryInputLike | null | undefined,
): ResolverResult<TFieldValues, TTransformedValues> {
  if (Object.keys(result.errors).length === 0) return result;
  for (const issue of itineraryIssues(flight)) {
    if (issue.severity !== "error") continue;
    const path = ["flight", ...issue.path].join(".");
    const error: unknown = get(result.errors, path);
    if (isFieldError(error) && error.message === issue.message) {
      set(result.errors, path, { ...error, message: "" });
    }
  }
  return result;
}

/**
 * Put each journey's segment errors back into the shape react-hook-form
 * gives a field array: an ARRAY of per-flight errors with any error about
 * the list itself on `.root`.
 *
 * The multi-city rule ("needs at least two flights") is an error on the
 * segments list itself. Through the zod resolver it arrives either as a
 * plain object `{ 0: …, root: … }` (full validation) or as the bare error
 * replacing every per-flight error (the array-only re-validation that runs
 * after add / move / delete). RHF only shifts ARRAY errors when flights move
 * and keeps per-index errors only under an array, so either shape would make
 * flags vanish or stay on the wrong flight.
 */
export function normalizeJourneyArrayErrors<
  TFieldValues extends FieldValues,
  TTransformedValues,
>(
  result: ResolverResult<TFieldValues, TTransformedValues>,
): ResolverResult<TFieldValues, TTransformedValues> {
  for (const journey of ["outbound", "return"] as const) {
    const path = `flight.${journey}.segments`;
    const node: unknown = get(result.errors, path);
    if (!node || typeof node !== "object" || Array.isArray(node)) continue;
    const record = node as Record<string, unknown>;
    const list: unknown[] & { root?: unknown } = [];
    for (const [key, value] of Object.entries(record)) {
      if (/^\d+$/.test(key)) list[Number(key)] = value;
    }
    if (record.root) {
      list.root = record.root;
    } else if (typeof record.type === "string") {
      list.root = { type: record.type, message: record.message, ref: record.ref };
    }
    set(result.errors, path, list);
  }
  return result;
}

/** Paths of blanked itinerary flags in `flightErrors` (the form's
 *  `errors.flight`) that no live itinerary error backs any more. */
export function staleItineraryFlags(
  flightErrors: unknown,
  issues: readonly ItineraryIssue[],
): string[] {
  const live = new Set(
    issues
      .filter((i) => i.severity === "error")
      .map((i) => ["flight", ...i.path].join(".")),
  );
  const stale: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== "object") return;
    if (isFieldError(node)) {
      if (node.message === "" && !live.has(path)) stale.push(path);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      walk(child, `${path}.${key}`);
    }
  };
  walk(flightErrors, "flight");
  return stale;
}
