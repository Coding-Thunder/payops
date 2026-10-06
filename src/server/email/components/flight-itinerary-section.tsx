import { Heading, Section, Text } from "@react-email/components";
import * as React from "react";

import type { FlightTripType } from "@/lib/constants/enums";
import {
  arrivalNeedsDate,
  type FlightItineraryView,
  type FlightJourneyView,
  type FlightLayoverView,
  type FlightSegmentView,
  formatDuration,
  formatLocalDate,
  formatSegmentTime,
  journeyStopsLabel,
  type LocalDateTime,
  segmentCarrier,
} from "@/lib/flight-itinerary";

import { SummaryCard } from "./summary-card";
import { COLOR, RADIUS, SPACE, typeStyle } from "./tokens";

interface FlightItinerarySectionProps {
  /** Built by `buildFlightItinerary`, which also folds a legacy flat-field
   *  flight into this shape — so old orders render here too. */
  itinerary: FlightItineraryView;
  title?: string;
  topPadding?: number;
  bottomPadding?: number;
}

/**
 * Every flight of a FLIGHT order, in the order it is flown — the email twin
 * of `@/components/common/flight-itinerary`:
 *
 *   OUTBOUND
 *   Delhi → Varanasi → Mumbai · 1 stop        (multi-city: "2 flights")
 *   ┌ 1. Delhi → Varanasi
 *   │  Air India • AI123
 *   │  Sat, Oct 10, 2026
 *   └  10:30 AM → 12:00 PM
 *      ⏱ Layover: 2h 30m — Varanasi
 *   ┌ 2. Varanasi → Mumbai
 *   …
 *
 * One stacked card per flight and no side-by-side columns, so it reads the
 * same in a narrow phone client as on a desktop. Times print exactly as the
 * operator entered them (airport-local wall clock); a legacy order's times
 * keep the "UTC" label they were captured with. A layover row appears only
 * where the operator recorded one — a direct connection shows nothing.
 */
export function FlightItinerarySection({
  itinerary,
  title = "Flight itinerary",
  topPadding = SPACE.md,
  bottomPadding = SPACE.xs,
}: FlightItinerarySectionProps) {
  return (
    <SummaryCard
      title={title}
      topPadding={topPadding}
      bottomPadding={bottomPadding}
    >
      {itinerary.journeys.map((journey, idx) => (
        <JourneyBlock
          key={journey.key}
          journey={journey}
          tripType={itinerary.tripType}
          first={idx === 0}
        />
      ))}
    </SummaryCard>
  );
}

/** "10:30 AM → 12:00 PM", plus "(arrives Oct 11)" when the flight lands on
 *  another calendar day — or at an earlier clock time across the date line. */
function segmentTimes(
  departure: LocalDateTime,
  arrival: LocalDateTime | null,
  timeZoneLabel: string | null,
): string {
  const departs = formatSegmentTime(departure, timeZoneLabel);
  if (!arrival) return departs;
  const lands = formatSegmentTime(arrival, timeZoneLabel);
  const otherDay = arrivalNeedsDate(departure, arrival)
    ? ` (arrives ${formatLocalDate(arrival.date, { short: true })})`
    : "";
  return `${departs} → ${lands}${otherDay}`;
}

/** "⏱ Layover: 2h 30m — Varanasi"; no duration when neither the flight
 *  times nor the operator give one. */
function layoverHeadline(layover: FlightLayoverView): string {
  const head =
    layover.minutes !== null
      ? `⏱ Layover: ${formatDuration(layover.minutes)}`
      : "⏱ Layover";
  return layover.location ? `${head} — ${layover.location}` : head;
}

function JourneyBlock({
  journey,
  tripType,
  first,
}: {
  journey: FlightJourneyView;
  tripType: FlightTripType;
  first: boolean;
}) {
  return (
    <Section style={{ paddingTop: first ? SPACE.xs : SPACE.xl }}>
      <Heading
        as="h3"
        style={{
          ...typeStyle("micro"),
          margin: 0,
          color: COLOR.textPrimary,
          textTransform: "uppercase",
        }}
      >
        {journey.label}
      </Heading>
      <Text
        style={{
          ...typeStyle("label"),
          margin: 0,
          marginTop: 2,
          color: COLOR.textMuted,
          wordBreak: "break-word",
        }}
      >
        {`${journey.route} · ${journeyStopsLabel(journey, tripType)}`}
      </Text>
      {journey.segments.map((segment, index) => {
        const layover = journey.connections[index]?.layover ?? null;
        return (
          <React.Fragment key={segment.number}>
            <SegmentCard
              segment={segment}
              timeZoneLabel={journey.timeZoneLabel}
            />
            {layover ? <LayoverRow layover={layover} /> : null}
          </React.Fragment>
        );
      })}
    </Section>
  );
}

function SegmentCard({
  segment,
  timeZoneLabel,
}: {
  segment: FlightSegmentView;
  timeZoneLabel: string | null;
}) {
  const carrier = segmentCarrier(segment);
  const { departure, arrival } = segment;
  return (
    <Section style={{ paddingTop: SPACE.sm }}>
      <div
        style={{
          backgroundColor: COLOR.surfaceMuted,
          border: `1px solid ${COLOR.borderSoft}`,
          borderRadius: RADIUS.md,
          padding: `${SPACE.md}px ${SPACE.lg}px`,
        }}
      >
        <Text
          style={{
            ...typeStyle("bodyStrong"),
            margin: 0,
            color: COLOR.textPrimary,
            wordBreak: "break-word",
          }}
        >
          {`${segment.number}. ${segment.origin} → ${segment.destination}`}
        </Text>
        {carrier ? (
          <Text
            style={{
              ...typeStyle("label"),
              margin: 0,
              marginTop: 2,
              color: COLOR.textSecondary,
            }}
          >
            {carrier}
          </Text>
        ) : null}
        {departure ? (
          <Text
            style={{
              ...typeStyle("label"),
              margin: 0,
              marginTop: 6,
              color: COLOR.textPrimary,
            }}
          >
            {formatLocalDate(departure.date)}
          </Text>
        ) : null}
        {departure ? (
          <Text
            style={{
              ...typeStyle("meta"),
              margin: 0,
              marginTop: 2,
              color: COLOR.textPrimary,
            }}
          >
            {segmentTimes(departure, arrival, timeZoneLabel)}
          </Text>
        ) : null}
        {segment.details ? (
          <Text
            style={{
              ...typeStyle("label"),
              margin: 0,
              marginTop: 6,
              color: COLOR.textMuted,
              fontWeight: 400,
              whiteSpace: "pre-line",
              wordBreak: "break-word",
            }}
          >
            {segment.details}
          </Text>
        ) : null}
      </div>
    </Section>
  );
}

function LayoverRow({ layover }: { layover: FlightLayoverView }) {
  return (
    <Section style={{ paddingTop: SPACE.sm, paddingLeft: SPACE.lg }}>
      <div
        style={{
          border: `1px dashed ${COLOR.border}`,
          borderRadius: RADIUS.md,
          padding: `${SPACE.sm}px ${SPACE.md}px`,
        }}
      >
        <Text
          style={{
            ...typeStyle("label"),
            margin: 0,
            color: COLOR.textSecondary,
            fontWeight: 600,
            wordBreak: "break-word",
          }}
        >
          {layoverHeadline(layover)}
        </Text>
        {layover.notes ? (
          <Text
            style={{
              ...typeStyle("legal"),
              margin: 0,
              marginTop: 2,
              color: COLOR.textMuted,
              fontSize: 11,
              lineHeight: "16px",
              whiteSpace: "pre-line",
              wordBreak: "break-word",
            }}
          >
            {layover.notes}
          </Text>
        ) : null}
      </div>
    </Section>
  );
}
