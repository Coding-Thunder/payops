import { FlightTripType } from "@/lib/constants/enums";

/**
 * FLIGHT itinerary — the one model every surface reads.
 *
 * Stored on `order.flight`:
 *
 *   ONE_WAY     outbound: { segments[], connections[] }
 *   ROUND_TRIP  outbound: { segments[], connections[] }
 *               return:   { segments[], connections[] }
 *   MULTI_CITY  outbound: { segments[], connections[] }   every leg, in order
 *
 * `connections[i]` is the gap between `segments[i]` and `segments[i + 1]`,
 * so a journey of N segments has N - 1 connections. A layover belongs to a
 * CONNECTION, never to a segment: the arrival that starts it and the
 * departure that ends it already live on the two adjacent segments, so the
 * layover itself only stores what those cannot — an optional place name
 * (when the traveller changes airport), an optional duration OVERRIDE, and
 * notes. The calculated duration is always derived, never stored.
 *
 * Times are AIRPORT-LOCAL wall-clock strings ("2026-10-10" + "10:30"),
 * exactly as printed on a ticket. They are deliberately not `Date`s: a
 * `Date` is an instant, and turning "10:30 at Varanasi" into one would need
 * the airport's time zone, which this platform does not know. Kept as
 * strings they render exactly as entered, and a layover's duration is exact
 * because both of its ends are at the same airport.
 *
 * Orders created before itineraries existed carry only the flat legacy
 * fields (origin / destination / departureDate / arrivalDate / returnDate).
 * `buildFlightItinerary` folds those into the same view, so an old order
 * renders through the same code — with its times labelled UTC, which is how
 * they were captured and how every email has always printed them.
 *
 * Pure and dependency-free: safe for server code, client components, emails
 * and PDFs.
 */

/** Wall-clock date + time at an airport, e.g. `{ date: "2026-10-10", time: "10:30" }`. */
export interface LocalDateTime {
  date: string;
  time: string;
}

export interface FlightSegment {
  origin: string;
  destination: string;
  departure: LocalDateTime;
  arrival: LocalDateTime;
  airline?: string | null;
  flightNumber?: string | null;
  /** Free text: terminal, aircraft, baggage, fare notes… */
  details?: string | null;
}

export interface FlightLayover {
  /** Null means "where the previous flight lands". Stored only when the
   *  operator names somewhere else, e.g. an airport change. */
  location?: string | null;
  /** Operator override of the CALCULATED duration, in minutes. Null means
   *  "show the calculated value". The segment times stay authoritative. */
  durationMinutesOverride?: number | null;
  notes?: string | null;
}

export interface FlightConnection {
  layover?: FlightLayover | null;
}

export interface FlightJourney {
  segments: FlightSegment[];
  connections?: FlightConnection[] | null;
}

/* ------------------------------------------------------------------ *
 * Loose input shapes. Live form state is partial while the operator is
 * typing, and Mongoose documents / DTOs differ in small ways, so every
 * helper below accepts these and copes with missing pieces.
 * ------------------------------------------------------------------ */

export interface LocalDateTimeLike {
  date?: string | null;
  time?: string | null;
}

export interface FlightSegmentLike {
  origin?: string | null;
  destination?: string | null;
  departure?: LocalDateTimeLike | null;
  arrival?: LocalDateTimeLike | null;
  airline?: string | null;
  flightNumber?: string | null;
  details?: string | null;
}

export interface FlightLayoverLike {
  location?: string | null;
  durationMinutesOverride?: number | null;
  notes?: string | null;
}

export interface FlightConnectionLike {
  layover?: FlightLayoverLike | null;
}

export interface FlightJourneyLike {
  segments?: ReadonlyArray<FlightSegmentLike | null | undefined> | null;
  connections?: ReadonlyArray<FlightConnectionLike | null | undefined> | null;
}

/** Generous ceilings that keep a document bounded without getting in the
 *  way of a real itinerary (a round-the-world multi-city is ~10 flights). */
export const MAX_SEGMENTS_PER_JOURNEY = 16;
/** A week. Anything longer is a stopover the operator should split into
 *  separate flights, not a layover. */
export const MAX_LAYOVER_OVERRIDE_MINUTES = 7 * 24 * 60;

export const CONNECTION_CHRONOLOGY_MESSAGE =
  "Please check the flight times. The next flight departs before the previous flight arrives.";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `YYYY-MM-DD` that names a real calendar day (rejects 2026-02-30). */
export function isLocalDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return (
    t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
  );
}

/** 24-hour `HH:mm`. */
export function isLocalTime(value: unknown): value is string {
  return typeof value === "string" && TIME_RE.test(value);
}

/**
 * Minutes on a notional timeline that treats the wall clock as UTC.
 *
 * Only DIFFERENCES between two times at the same place are meaningful —
 * which is exactly a layover (arrive at X, depart from X). Null when the
 * date or time is missing or malformed.
 */
export function wallClockMinutes(
  value: LocalDateTimeLike | null | undefined,
): number | null {
  if (!value || !isLocalDate(value.date) || !isLocalTime(value.time)) {
    return null;
  }
  const [y, mo, d] = value.date.split("-").map(Number);
  const [h, mi] = value.time.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) / 60_000;
}

/** `to - from` in minutes, or null when either side is incomplete. */
export function minutesBetween(
  from: LocalDateTimeLike | null | undefined,
  to: LocalDateTimeLike | null | undefined,
): number | null {
  const a = wallClockMinutes(from);
  const b = wallClockMinutes(to);
  return a === null || b === null ? null : b - a;
}

/** 150 → "2h 30m", 540 → "9h", 45 → "45m", 1530 → "1d 1h 30m". */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins || parts.length === 0) parts.push(`${mins}m`);
  return parts.join(" ");
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * "2026-10-10" → "Sat, Oct 10, 2026" (or "Oct 10" with `short`). No Intl and
 * no time zone involved, so the server, the browser and an email client all
 * print the same thing. Malformed input is returned unchanged.
 */
export function formatLocalDate(
  date: string,
  opts: { short?: boolean } = {},
): string {
  if (!isLocalDate(date)) return date;
  const [y, mo, d] = date.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  if (opts.short) return `${MONTHS[mo - 1]} ${d}`;
  return `${weekday}, ${MONTHS[mo - 1]} ${d}, ${y}`;
}

/** "14:30" → "2:30 PM", "00:05" → "12:05 AM". Malformed input unchanged. */
export function formatLocalTime(time: string): string {
  if (!isLocalTime(time)) return time;
  const [h, m] = time.split(":").map(Number);
  const suffix = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** "Sat, Oct 10, 2026 · 2:30 PM". */
export function formatLocalDateTime(value: LocalDateTimeLike): string {
  const date = value.date ? formatLocalDate(value.date) : "";
  const time = value.time ? formatLocalTime(value.time) : "";
  return [date, time].filter(Boolean).join(" · ");
}

function clean(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * True when a flight carries a structured itinerary — an outbound journey
 * with at least one flight — which every flight created since itineraries
 * existed does. False for a legacy flat-field flight (origin / destination /
 * departureDate …), and for no flight at all.
 *
 * THE one test for "is this an itinerary flight": `buildFlightItinerary`
 * sets `legacy` from it, the order model picks its validation rules with
 * it, and `flightMoneyWording` (`@/lib/charges`) picks the money wording
 * with it. Deliberately loose in what it accepts — a Mongoose document, a
 * DTO, a consent snapshot or live form state.
 */
export function hasFlightItinerary(
  flight:
    | { outbound?: { segments?: ReadonlyArray<unknown> | null } | null }
    | null
    | undefined,
): boolean {
  return (flight?.outbound?.segments?.length ?? 0) > 0;
}

/** A journey as plain, serialisable data — the shape `OrderFlightJourney`
 *  (the DTO) and `PaymentConsentFlightSnapshot` (the consent record) use. */
export interface PlainFlightJourney {
  segments: {
    origin: string;
    destination: string;
    departure: LocalDateTime;
    arrival: LocalDateTime;
    airline: string | null;
    flightNumber: string | null;
    details: string | null;
  }[];
  connections: {
    layover: {
      location: string | null;
      durationMinutesOverride: number | null;
      notes: string | null;
    } | null;
  }[];
}

/**
 * One journey as plain data: every segment with its optional fields
 * normalised to null, and EXACTLY one connection per gap (connection `i` sits
 * between segment `i` and `i + 1`) whatever was stored — a short array means
 * "no layover recorded", extra entries are dropped. Null when the journey
 * has no flights.
 *
 * Mongoose documents in, plain JSON out, so the result is safe as a DTO, a
 * client prop or a frozen consent snapshot. The one mapper for both: the
 * order DTO and the consent snapshot can never shape a journey differently.
 */
export function toPlainJourney(
  journey: FlightJourneyLike | null | undefined,
): PlainFlightJourney | null {
  const segments = journey?.segments ?? [];
  if (segments.length === 0) return null;
  return {
    segments: segments.map((s) => ({
      origin: s?.origin ?? "",
      destination: s?.destination ?? "",
      departure: {
        date: s?.departure?.date ?? "",
        time: s?.departure?.time ?? "",
      },
      arrival: { date: s?.arrival?.date ?? "", time: s?.arrival?.time ?? "" },
      airline: s?.airline ?? null,
      flightNumber: s?.flightNumber ?? null,
      details: s?.details ?? null,
    })),
    connections: segments.slice(1).map((_, i) => {
      const layover = journey?.connections?.[i]?.layover;
      return {
        layover: layover
          ? {
              location: layover.location ?? null,
              durationMinutesOverride: finiteOrNull(
                layover.durationMinutesOverride,
              ),
              notes: layover.notes ?? null,
            }
          : null,
      };
    }),
  };
}

function sameAirport(a: string | null | undefined, b: string | null | undefined) {
  return clean(a).toUpperCase() === clean(b).toUpperCase();
}

function segmentsOf(journey: FlightJourneyLike | null | undefined) {
  return (journey?.segments ?? []).map((s) => s ?? {});
}

/**
 * The connection between segment `i` and segment `i + 1`, or null when the
 * journey carries none at that index. Connections are positional, so a
 * short or missing array simply means "no layover recorded".
 */
export function connectionAt(
  journey: FlightJourneyLike | null | undefined,
  index: number,
): FlightConnectionLike | null {
  return journey?.connections?.[index] ?? null;
}

export interface LayoverTiming {
  /** Previous arrival → next departure, in minutes. Null when either time
   *  is missing. Negative means the itinerary is impossible. */
  calculatedMinutes: number | null;
  /** What the operator typed over it, if anything. */
  overrideMinutes: number | null;
  /** What to SHOW: the override when set, otherwise the calculated value
   *  (never a negative one). */
  effectiveMinutes: number | null;
}

/** Timing of the connection that follows segment `index`. */
export function layoverTiming(
  journey: FlightJourneyLike | null | undefined,
  index: number,
): LayoverTiming {
  const segments = segmentsOf(journey);
  const prev = segments[index];
  const next = segments[index + 1];
  const calculated =
    prev && next ? minutesBetween(prev.arrival, next.departure) : null;
  const rawOverride = connectionAt(journey, index)?.layover
    ?.durationMinutesOverride;
  const override =
    typeof rawOverride === "number" && Number.isFinite(rawOverride)
      ? rawOverride
      : null;
  return {
    calculatedMinutes: calculated,
    overrideMinutes: override,
    effectiveMinutes:
      override ?? (calculated !== null && calculated >= 0 ? calculated : null),
  };
}

/** The place a layover is shown at: the operator's name for it, else the
 *  airport the previous flight lands at. */
export function layoverLocation(
  journey: FlightJourneyLike | null | undefined,
  index: number,
): string {
  const named = clean(connectionAt(journey, index)?.layover?.location);
  if (named) return named;
  return clean(segmentsOf(journey)[index]?.destination);
}

/* ------------------------------------------------------------------ *
 * Validation.
 *
 * ONE function decides what is wrong with an itinerary. The order schema
 * turns its errors into field errors (so a bad itinerary can never be
 * saved), and the operator form shows its errors AND warnings live, next to
 * the segments they concern.
 *
 * Errors are things that cannot be true. Warnings are things that are
 * usually typos but can be legitimate — an airport change between flights,
 * or a flight that lands "before" it took off because it crossed the
 * International Date Line — so they never block saving.
 * ------------------------------------------------------------------ */

export type ItineraryIssueSeverity = "error" | "warning";

export interface ItineraryIssue {
  severity: ItineraryIssueSeverity;
  /** Path relative to `flight`, e.g. ["outbound", "segments", 1, "departure", "date"]. */
  path: (string | number)[];
  message: string;
}

const DAY = 24 * 60;

/** Issues inside one journey. `key` is "outbound" or "return". */
export function journeyIssues(
  journey: FlightJourneyLike | null | undefined,
  key: "outbound" | "return",
): ItineraryIssue[] {
  const issues: ItineraryIssue[] = [];
  const segments = segmentsOf(journey);

  segments.forEach((segment, i) => {
    const at = [key, "segments", i];
    if (
      clean(segment.origin) &&
      clean(segment.destination) &&
      sameAirport(segment.origin, segment.destination)
    ) {
      issues.push({
        severity: "error",
        path: [...at, "destination"],
        message: "From and To can't be the same airport.",
      });
    }

    const flightMinutes = minutesBetween(segment.departure, segment.arrival);
    if (flightMinutes !== null) {
      if (flightMinutes < -DAY) {
        issues.push({
          severity: "error",
          path: [...at, "arrival", "date"],
          message:
            "Arrival can't be more than a day before departure. Please check the dates.",
        });
      } else if (flightMinutes < 0) {
        issues.push({
          severity: "warning",
          path: [...at, "arrival", "date"],
          message:
            "Arrival is earlier than departure. That only happens when a flight crosses the International Date Line — please double-check.",
        });
      } else if (flightMinutes > 2 * DAY) {
        issues.push({
          severity: "error",
          path: [...at, "arrival", "date"],
          message:
            "Arrival is more than two days after departure. Please check the dates.",
        });
      }
    }
  });

  for (let i = 0; i < segments.length - 1; i++) {
    const prev = segments[i];
    const next = segments[i + 1];
    const gap = minutesBetween(prev.arrival, next.departure);
    if (gap !== null && gap < 0) {
      issues.push({
        severity: "error",
        path: [key, "segments", i + 1, "departure", "date"],
        message: CONNECTION_CHRONOLOGY_MESSAGE,
      });
    }
    if (
      clean(prev.destination) &&
      clean(next.origin) &&
      !sameAirport(prev.destination, next.origin)
    ) {
      issues.push({
        severity: "warning",
        path: [key, "segments", i + 1, "origin"],
        message: `Flight ${i + 2} departs from ${clean(next.origin)}, but flight ${
          i + 1
        } lands at ${clean(prev.destination)}. Check the airports — this is fine if the traveller changes airport.`,
      });
    }
  }

  return issues;
}

export interface FlightItineraryInputLike {
  tripType?: string | null;
  outbound?: FlightJourneyLike | null;
  return?: FlightJourneyLike | null;
}

/** Every issue with a whole itinerary, including the rules between the
 *  outbound and return journeys of a round trip. */
export function itineraryIssues(
  flight: FlightItineraryInputLike | null | undefined,
): ItineraryIssue[] {
  if (!flight) return [];
  const issues: ItineraryIssue[] = [];
  const outbound = segmentsOf(flight.outbound);

  if (flight.tripType === FlightTripType.MULTI_CITY && outbound.length < 2) {
    issues.push({
      severity: "error",
      path: ["outbound", "segments"],
      message: "A multi-city trip needs at least two flights.",
    });
  }

  issues.push(...journeyIssues(flight.outbound, "outbound"));

  if (flight.tripType === FlightTripType.ROUND_TRIP) {
    const back = segmentsOf(flight.return);
    if (back.length === 0) {
      issues.push({
        severity: "error",
        path: ["return"],
        message: "Add the return flight.",
      });
    } else {
      issues.push(...journeyIssues(flight.return, "return"));
      const lastOut = outbound[outbound.length - 1];
      const firstBack = back[0];
      if (lastOut && firstBack) {
        const gap = minutesBetween(lastOut.arrival, firstBack.departure);
        if (gap !== null && gap < 0) {
          issues.push({
            severity: "error",
            path: ["return", "segments", 0, "departure", "date"],
            message:
              "The return flight departs before the outbound flights arrive. Please check the dates.",
          });
        }
        if (
          clean(lastOut.destination) &&
          clean(firstBack.origin) &&
          !sameAirport(lastOut.destination, firstBack.origin)
        ) {
          issues.push({
            severity: "warning",
            path: ["return", "segments", 0, "origin"],
            message: `The return departs from ${clean(
              firstBack.origin,
            )}, but the outbound journey ends at ${clean(
              lastOut.destination,
            )}. Fine for an open-jaw trip — otherwise check the airports.`,
          });
        }
      }
    }
  }

  return issues;
}

/* ------------------------------------------------------------------ *
 * Display view — what every customer and operator surface renders.
 * ------------------------------------------------------------------ */

export interface FlightSegmentView {
  /** 1-based position within its journey. */
  number: number;
  origin: string;
  destination: string;
  airline: string | null;
  flightNumber: string | null;
  details: string | null;
  departure: LocalDateTime | null;
  arrival: LocalDateTime | null;
}

export interface FlightLayoverView {
  location: string;
  calculatedMinutes: number | null;
  overrideMinutes: number | null;
  /** What to show: override, else calculated. */
  minutes: number | null;
  notes: string | null;
}

export interface FlightConnectionView {
  /** Number of the segment this connection follows (1-based). */
  after: number;
  /** Null when the operator recorded no layover for this connection. */
  layover: FlightLayoverView | null;
}

export type FlightJourneyKey = "outbound" | "return";

export interface FlightJourneyView {
  key: FlightJourneyKey;
  label: string;
  /** Every airport in order, e.g. "Delhi → Varanasi → Mumbai". */
  route: string;
  segments: FlightSegmentView[];
  connections: FlightConnectionView[];
  /** "UTC" for a legacy order, whose times are UTC instants; null when the
   *  times are airport-local. */
  timeZoneLabel: string | null;
}

export interface FlightItineraryView {
  tripType: FlightTripType;
  journeys: FlightJourneyView[];
  /** Built from the pre-itinerary flat fields. */
  legacy: boolean;
}

type DateLike = Date | string;

/** Anything carrying a flight — a Mongoose document, a DTO, a snapshot. */
export interface FlightItinerarySource extends FlightItineraryInputLike {
  // Legacy flat fields (orders created before itineraries existed).
  origin?: string | null;
  destination?: string | null;
  departureDate?: DateLike | null;
  arrivalDate?: DateLike | null;
  returnDate?: DateLike | null;
  airline?: string | null;
  flightNumber?: string | null;
}

export function normalizeTripType(value: string | null | undefined): FlightTripType {
  return value === FlightTripType.ROUND_TRIP ||
    value === FlightTripType.MULTI_CITY
    ? value
    : FlightTripType.ONE_WAY;
}

/** Heading for a journey: "Outbound" / "Return" on a round trip, otherwise
 *  the trip type itself. */
export function journeyLabel(
  tripType: FlightTripType,
  key: FlightJourneyKey,
): string {
  if (tripType === FlightTripType.ROUND_TRIP) {
    return key === "return" ? "Return" : "Outbound";
  }
  return tripType === FlightTripType.MULTI_CITY ? "Multi-city" : "One way";
}

/**
 * Every airport in order: "Delhi → Varanasi → Mumbai". When a flight leaves
 * from somewhere other than where the previous one landed (an airport
 * change, an open-jaw), both are kept — "London (LHR) / Paris (CDG)" — so
 * the summary never invents a flight that does not exist.
 */
function routeOf(segments: ReadonlyArray<{ origin: string; destination: string }>) {
  if (segments.length === 0) return "";
  let route = segments[0].origin;
  segments.forEach((segment, i) => {
    if (i > 0) {
      const landed = segments[i - 1].destination;
      if (segment.origin && landed && !sameAirport(segment.origin, landed)) {
        route = route ? `${route} / ${segment.origin}` : segment.origin;
      }
    }
    if (segment.destination) {
      route = route ? `${route} → ${segment.destination}` : segment.destination;
    }
  });
  return route;
}

function localOrNull(value: LocalDateTimeLike | null | undefined): LocalDateTime | null {
  return value && isLocalDate(value.date) && isLocalTime(value.time)
    ? { date: value.date, time: value.time }
    : null;
}

function utcParts(value: DateLike | null | undefined): LocalDateTime | null {
  if (!value) return null;
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return null;
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

function journeyView(
  journey: FlightJourneyLike,
  key: FlightJourneyKey,
  tripType: FlightTripType,
): FlightJourneyView {
  const raw = segmentsOf(journey);
  const segments: FlightSegmentView[] = raw.map((s, i) => ({
    number: i + 1,
    origin: clean(s.origin),
    destination: clean(s.destination),
    airline: clean(s.airline) || null,
    flightNumber: clean(s.flightNumber) || null,
    details: clean(s.details) || null,
    departure: localOrNull(s.departure),
    arrival: localOrNull(s.arrival),
  }));
  const connections: FlightConnectionView[] = [];
  for (let i = 0; i < segments.length - 1; i++) {
    const layover = connectionAt(journey, i)?.layover;
    if (!layover) {
      connections.push({ after: i + 1, layover: null });
      continue;
    }
    const timing = layoverTiming(journey, i);
    connections.push({
      after: i + 1,
      layover: {
        location: layoverLocation(journey, i),
        calculatedMinutes: timing.calculatedMinutes,
        overrideMinutes: timing.overrideMinutes,
        minutes: timing.effectiveMinutes,
        notes: clean(layover.notes) || null,
      },
    });
  }
  return {
    key,
    label: journeyLabel(tripType, key),
    route: routeOf(segments),
    segments,
    connections,
    timeZoneLabel: null,
  };
}

/**
 * The itinerary of any flight, old or new, as one display-ready view.
 * Null when there is nothing to show.
 */
export function buildFlightItinerary(
  flight: FlightItinerarySource | null | undefined,
): FlightItineraryView | null {
  if (!flight) return null;
  const tripType = normalizeTripType(flight.tripType);

  if (hasFlightItinerary(flight)) {
    const journeys = [journeyView(flight.outbound!, "outbound", tripType)];
    if (
      tripType === FlightTripType.ROUND_TRIP &&
      segmentsOf(flight.return).length > 0
    ) {
      journeys.push(journeyView(flight.return!, "return", tripType));
    }
    return { tripType, journeys, legacy: false };
  }

  // Legacy: one flat outbound leg, plus a return DATE on a round trip.
  const origin = clean(flight.origin);
  const destination = clean(flight.destination);
  if (!origin && !destination) return null;

  const outbound: FlightSegmentView = {
    number: 1,
    origin,
    destination,
    airline: clean(flight.airline) || null,
    flightNumber: clean(flight.flightNumber) || null,
    details: null,
    departure: utcParts(flight.departureDate),
    arrival: utcParts(flight.arrivalDate),
  };
  const journeys: FlightJourneyView[] = [
    {
      key: "outbound",
      label: journeyLabel(tripType, "outbound"),
      route: routeOf([outbound]),
      segments: [outbound],
      connections: [],
      timeZoneLabel: "UTC",
    },
  ];
  if (tripType === FlightTripType.ROUND_TRIP && flight.returnDate) {
    // The legacy form only ever asked for a return DATE on a trip from
    // origin to destination, so the return route is that trip reversed.
    const back: FlightSegmentView = {
      number: 1,
      origin: destination,
      destination: origin,
      airline: null,
      flightNumber: null,
      details: null,
      departure: utcParts(flight.returnDate),
      arrival: null,
    };
    journeys.push({
      key: "return",
      label: journeyLabel(tripType, "return"),
      route: routeOf([back]),
      segments: [back],
      connections: [],
      timeZoneLabel: "UTC",
    });
  }
  return { tripType, journeys, legacy: true };
}

/** Total number of flights across every journey. */
export function itinerarySegmentCount(view: FlightItineraryView): number {
  return view.journeys.reduce((n, j) => n + j.segments.length, 0);
}

/** The first departure of the whole itinerary. */
export function itineraryFirstDeparture(
  view: FlightItineraryView,
): LocalDateTime | null {
  return view.journeys[0]?.segments[0]?.departure ?? null;
}

/** The first departure of the return journey, if there is one. */
export function itineraryReturnDeparture(
  view: FlightItineraryView,
): LocalDateTime | null {
  return (
    view.journeys.find((j) => j.key === "return")?.segments[0]?.departure ??
    null
  );
}

/**
 * The shape of one journey: "Direct", "1 stop", "2 stops" — except on a
 * multi-city trip, whose legs are destinations in their own right rather
 * than stops, so it counts flights instead ("2 flights"), as the gateway
 * description does ("Multi-city, 2 flights"). One rule for every surface:
 * the web itinerary, the emails, the consent mailto and the evidence PDF.
 */
export function journeyStopsLabel(
  journey: { segments: readonly unknown[] },
  tripType: FlightTripType,
): string {
  const flights = journey.segments.length;
  if (tripType === FlightTripType.MULTI_CITY) {
    return `${flights} flight${flights === 1 ? "" : "s"}`;
  }
  const stops = flights - 1;
  if (stops <= 0) return "Direct";
  return `${stops} stop${stops === 1 ? "" : "s"}`;
}

/**
 * Whether a flight's arrival needs its date printed next to its time: when
 * it lands on another day — or on the same date at an EARLIER clock time,
 * which only happens across the International Date Line and would otherwise
 * read as "the next morning".
 */
export function arrivalNeedsDate(
  departure: LocalDateTimeLike | null | undefined,
  arrival: LocalDateTimeLike | null | undefined,
): boolean {
  if (!departure || !arrival) return false;
  if (arrival.date !== departure.date) return true;
  const minutes = minutesBetween(departure, arrival);
  return minutes !== null && minutes < 0;
}

/** "2:30 PM UTC" for a legacy time, "2:30 PM" for an airport-local one. */
export function formatSegmentTime(
  value: LocalDateTime,
  timeZoneLabel: string | null,
): string {
  const time = formatLocalTime(value.time);
  return timeZoneLabel ? `${time} ${timeZoneLabel}` : time;
}

/** "Air India • AI123", "Air India", "AI123" or "" — whatever is known. */
export function segmentCarrier(segment: {
  airline: string | null;
  flightNumber: string | null;
}): string {
  return [segment.airline, segment.flightNumber].filter(Boolean).join(" • ");
}

/** Cut a string to `max` characters with an ellipsis. */
export function truncateText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}
