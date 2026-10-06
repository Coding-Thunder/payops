"use client";

import { useEffect } from "react";
import {
  useFormContext,
  useFormState,
  useWatch,
  type FieldPath,
} from "react-hook-form";

import { FlightTripType } from "@/lib/constants/enums";
import { itineraryIssues, normalizeTripType } from "@/lib/flight-itinerary";
import type { FlightOrderInput } from "@/lib/validation";

import { JourneyEditor } from "./journey-editor";
import {
  type FlightOrderFormValues,
  outboundHeading,
  staleItineraryFlags,
} from "./itinerary-form";

const LOCAL_TIMES_NOTE =
  "Times are local to each airport, exactly as printed on the ticket.";

const OUTBOUND_DESCRIPTION: Record<FlightTripType, string> = {
  ONE_WAY: `Each flight in order — a connecting trip is several flights. ${LOCAL_TIMES_NOTE}`,
  ROUND_TRIP: `The flights out, in order. ${LOCAL_TIMES_NOTE}`,
  MULTI_CITY: `Every leg in order — at least two flights. ${LOCAL_TIMES_NOTE}`,
};

const RETURN_DESCRIPTION = `The flights back, in order. ${LOCAL_TIMES_NOTE}`;

/**
 * The itinerary half of the flight form: the outbound (or only) journey,
 * plus an independent return journey on a round trip.
 *
 * Owns the live validation. `itineraryIssues` is the same function the
 * schema's superRefine runs, so the errors shown here as the operator types
 * are exactly the ones that will block the submit — and the warnings, which
 * never block, are shown beside them.
 */
export function ItineraryEditor({ disabled }: { disabled: boolean }) {
  const { control, clearErrors } = useFormContext<
    FlightOrderFormValues,
    unknown,
    FlightOrderInput
  >();
  const tripType = normalizeTripType(
    useWatch({ control, name: "flight.tripType" }),
  );
  const hasReturn = useWatch({
    control,
    name: "flight.return",
    compute: (value) => value != null,
  });
  // Recomputed on every itinerary change; `useWatch` compares computed
  // results deeply, so this only re-renders when the issues change.
  const issues = useWatch({
    control,
    name: "flight",
    compute: (flight) => itineraryIssues(flight),
  });

  // Clear red field flags whose itinerary error has since been fixed (see
  // `flagItineraryErrors`). A key string keeps the effect from re-running
  // on every errors object RHF hands back.
  const { errors } = useFormState({ control, name: "flight" });
  const staleFlags = staleItineraryFlags(errors.flight, issues).join("|");
  useEffect(() => {
    if (!staleFlags) return;
    clearErrors(staleFlags.split("|") as FieldPath<FlightOrderFormValues>[]);
  }, [staleFlags, clearErrors]);

  return (
    <>
      <JourneyEditor
        journey="outbound"
        heading={outboundHeading(tripType)}
        description={OUTBOUND_DESCRIPTION[tripType]}
        issues={issues}
        disabled={disabled}
      />
      {tripType === FlightTripType.ROUND_TRIP && hasReturn ? (
        <JourneyEditor
          journey="return"
          heading="Return"
          description={RETURN_DESCRIPTION}
          issues={issues}
          disabled={disabled}
        />
      ) : null}
    </>
  );
}
