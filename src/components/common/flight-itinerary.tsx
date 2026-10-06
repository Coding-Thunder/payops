import { Fragment } from "react";
import { Clock3 } from "lucide-react";

import { FlightTripType } from "@/lib/constants/enums";
import {
  arrivalNeedsDate,
  type FlightItineraryView,
  type FlightJourneyView,
  type FlightSegmentView,
  formatDuration,
  formatLocalDate,
  formatSegmentTime,
  journeyStopsLabel,
  segmentCarrier,
} from "@/lib/flight-itinerary";
import { cn } from "@/lib/utils";

/**
 * A flight itinerary as the customer and the operator read it:
 *
 *   OUTBOUND
 *   1  Delhi → Varanasi
 *      Air India • AI123
 *      Sat, Oct 10, 2026
 *      10:30 AM → 12:00 PM
 *      ⏱ Layover: 2h 30m — Varanasi
 *   2  Varanasi → Mumbai
 *      …
 *
 * Stacked cards, no tables, so it reads the same on a phone. Pure
 * presentation (no hooks, no state): renders in server components such as
 * /pay/success and in client components such as the consent page alike.
 * Build the `itinerary` with `buildFlightItinerary` — it also folds legacy
 * flat-field flights into this shape, so old orders render here too.
 */
export function FlightItinerary({
  itinerary,
  showOverrideHint = false,
  className,
}: {
  itinerary: FlightItineraryView;
  /** Operator surfaces mark a layover whose duration was typed over. */
  showOverrideHint?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("space-y-5", className)}>
      {itinerary.journeys.map((journey) => (
        <JourneyBlock
          key={journey.key}
          journey={journey}
          tripType={itinerary.tripType}
          showOverrideHint={showOverrideHint}
        />
      ))}
    </div>
  );
}

function JourneyBlock({
  journey,
  tripType,
  showOverrideHint,
}: {
  journey: FlightJourneyView;
  tripType: FlightTripType;
  showOverrideHint: boolean;
}) {
  return (
    <section aria-label={journey.label} className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {journey.label}
        </h3>
        <span className="text-xs text-muted-foreground">
          {/* "Direct" / "1 stop" — or "2 flights" on a multi-city trip,
              whose legs are destinations rather than stops. */}
          {`${journey.route} · ${journeyStopsLabel(journey, tripType)}`}
        </span>
      </div>
      <ol className="space-y-2">
        {journey.segments.map((segment, index) => {
          const connection = journey.connections[index];
          const layover = connection?.layover ?? null;
          return (
            <Fragment key={segment.number}>
              <li className="rounded-lg border bg-card p-3">
                <SegmentCard
                  segment={segment}
                  timeZoneLabel={journey.timeZoneLabel}
                />
              </li>
              {layover ? (
                <li
                  className="flex flex-wrap items-start gap-x-2 gap-y-0.5 rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm"
                  aria-label={`Layover after flight ${segment.number}`}
                >
                  <Clock3
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="min-w-0 break-words font-medium">
                    {layover.minutes !== null
                      ? `Layover: ${formatDuration(layover.minutes)}`
                      : "Layover"}
                    {layover.location ? ` — ${layover.location}` : ""}
                  </span>
                  {showOverrideHint && layover.overrideMinutes !== null ? (
                    <span className="text-xs text-muted-foreground">
                      (adjusted
                      {layover.calculatedMinutes !== null &&
                      layover.calculatedMinutes >= 0
                        ? `; flight times give ${formatDuration(layover.calculatedMinutes)}`
                        : ""}
                      )
                    </span>
                  ) : null}
                  {layover.notes ? (
                    <span className="min-w-0 basis-full pl-6 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {layover.notes}
                    </span>
                  ) : null}
                </li>
              ) : null}
            </Fragment>
          );
        })}
      </ol>
    </section>
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
  const departure = segment.departure;
  const arrival = segment.arrival;
  const arrivesOtherDay = arrivalNeedsDate(departure, arrival);

  return (
    <div className="flex gap-3">
      <span
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums"
        aria-label={`Flight ${segment.number}`}
      >
        {segment.number}
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-medium leading-snug [overflow-wrap:anywhere]">
          {`${segment.origin} → ${segment.destination}`}
        </p>
        {carrier ? (
          <p className="break-words text-sm text-muted-foreground">{carrier}</p>
        ) : null}
        {departure ? (
          <p className="text-sm">{formatLocalDate(departure.date)}</p>
        ) : null}
        {departure ? (
          <p className="text-sm tabular-nums">
            {formatSegmentTime(departure, timeZoneLabel)}
            {arrival ? (
              <>
                {" → "}
                {formatSegmentTime(arrival, timeZoneLabel)}
                {arrivesOtherDay
                  ? ` (arrives ${formatLocalDate(arrival.date, { short: true })})`
                  : ""}
              </>
            ) : null}
          </p>
        ) : null}
        {segment.details ? (
          <p className="whitespace-pre-line text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {segment.details}
          </p>
        ) : null}
      </div>
    </div>
  );
}
