"use client";

import { useId } from "react";
import { Clock3Icon } from "lucide-react";
import { useFormContext, useWatch } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  type FlightJourneyKey,
  type ItineraryIssue,
  MAX_LAYOVER_OVERRIDE_MINUTES,
} from "@/lib/flight-itinerary";
import type { FlightOrderInput } from "@/lib/validation";

import { ItineraryIssueList } from "./itinerary-issue-list";
import {
  connectionView,
  durationParts,
  emptyLayover,
  type FlightOrderFormValues,
  joinDuration,
  layoverCalculatedText,
  overridePrefill,
} from "./itinerary-form";

interface ConnectionRowProps {
  journey: FlightJourneyKey;
  /** Connection index — the gap between flight `index + 1` and the next. */
  index: number;
  /** Live issues about this connection (it leaves before the previous
   *  flight lands, or from another airport). */
  issues: readonly ItineraryIssue[];
  disabled: boolean;
}

/**
 * The gap between two adjacent flights, and its optional layover.
 *
 * The layover belongs to the CONNECTION, not to either flight: its start
 * and end are the previous arrival and the next departure, so all it
 * stores is a place name (blank = where the previous flight lands), an
 * override of the calculated duration, and notes. The calculated duration
 * itself is derived here on every render and never stored.
 */
export function ConnectionRow({
  journey,
  index,
  issues,
  disabled,
}: ConnectionRowProps) {
  const { control, setValue, clearErrors } = useFormContext<
    FlightOrderFormValues,
    unknown,
    FlightOrderInput
  >();
  const id = useId();
  const base = `flight.${journey}` as const;
  const layoverPath = `${base}.connections.${index}.layover` as const;

  // Derived in render rather than in a `useWatch` compute: after a flight is
  // deleted or moved, this row's `index` and the watched journey both
  // change in the same render, and must be read together.
  const view = connectionView(useWatch({ control, name: base }), index);

  return (
    <div className="rounded-lg border border-dashed bg-muted/30 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex min-w-0 items-start gap-2 text-sm text-muted-foreground">
          <Clock3Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{view.gap}</span>
        </p>
        {view.hasLayover ? null : (
          <Button
            type="button"
            variant="outline"
            className="h-10 w-full shrink-0 sm:h-8 sm:w-auto"
            onClick={() => {
              setValue(layoverPath, emptyLayover(), { shouldDirty: true });
              // A fresh layover starts clean, whatever a layover that was
              // removed or reset on this gap had flagged.
              clearErrors(layoverPath);
            }}
            disabled={disabled}
          >
            + Add Layover
          </Button>
        )}
      </div>

      <ItineraryIssueList issues={issues} className="mt-2" />

      {view.hasLayover ? (
        <div className="mt-3 space-y-4 border-t border-dashed pt-3">
          <FormField
            control={control}
            name={`${layoverPath}.location`}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Layover location (optional)</FormLabel>
                <FormControl>
                  <Input
                    placeholder={
                      view.arrivalAirport || "Where the previous flight lands"
                    }
                    maxLength={120}
                    autoComplete="off"
                    disabled={disabled}
                    {...field}
                    value={field.value ?? ""}
                  />
                </FormControl>
                <FormDescription>
                  {`Leave blank to use ${
                    view.arrivalAirport ||
                    `the airport flight ${index + 1} lands at`
                  }. Name a place only if the traveller changes airport.`}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={control}
            name={`${layoverPath}.durationMinutesOverride`}
            render={({ field, fieldState }) => {
              const minutes =
                typeof field.value === "number" ? field.value : null;
              const overriding = minutes !== null;
              const parts = durationParts(minutes ?? 0);
              return (
                <FormItem>
                  <p className="text-sm tabular-nums">
                    {layoverCalculatedText(view.calculatedMinutes)}
                  </p>
                  {/* Checked means "show my figure instead". Ticking it
                      starts from the calculated value; unticking clears
                      the override back to null. */}
                  <div className="flex items-center gap-2.5">
                    <Checkbox
                      id={`${id}-override`}
                      checked={overriding}
                      onCheckedChange={(checked) =>
                        field.onChange(
                          checked === true
                            ? overridePrefill(view.calculatedMinutes)
                            : null,
                        )
                      }
                      disabled={disabled}
                    />
                    {/* The label spans the row, so the whole row is the
                        touch target, not just the 16px box. */}
                    <Label
                      htmlFor={`${id}-override`}
                      className="flex min-h-10 flex-1 cursor-pointer items-center sm:min-h-8"
                    >
                      Override duration
                    </Label>
                  </div>
                  {overriding ? (
                    <div className="grid max-w-xs grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label htmlFor={`${id}-hours`}>Hours</Label>
                        <Input
                          id={`${id}-hours`}
                          ref={field.ref}
                          type="number"
                          min={0}
                          max={MAX_LAYOVER_OVERRIDE_MINUTES / 60}
                          step={1}
                          inputMode="numeric"
                          aria-invalid={fieldState.invalid}
                          disabled={disabled}
                          value={parts.hours}
                          onChange={(e) =>
                            field.onChange(
                              joinDuration(e.target.value, parts.minutes),
                            )
                          }
                          onBlur={field.onBlur}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`${id}-minutes`}>Minutes</Label>
                        <Input
                          id={`${id}-minutes`}
                          type="number"
                          min={0}
                          max={59}
                          step={1}
                          inputMode="numeric"
                          aria-invalid={fieldState.invalid}
                          disabled={disabled}
                          value={parts.minutes}
                          onChange={(e) =>
                            field.onChange(
                              joinDuration(parts.hours, e.target.value),
                            )
                          }
                          onBlur={field.onBlur}
                        />
                      </div>
                    </div>
                  ) : null}
                  <FormMessage />
                </FormItem>
              );
            }}
          />

          <FormField
            control={control}
            name={`${layoverPath}.notes`}
            render={({ field }) => (
              <FormItem>
                <FormLabel>Layover notes (optional)</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder="e.g. Change terminals; collect and re-check bags"
                    rows={2}
                    maxLength={500}
                    disabled={disabled}
                    {...field}
                    value={field.value ?? ""}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <Button
            type="button"
            variant="ghost"
            className="h-10 sm:h-8"
            onClick={() => {
              setValue(layoverPath, null, { shouldDirty: true });
              clearErrors(layoverPath);
            }}
            disabled={disabled}
          >
            Remove layover
          </Button>
        </div>
      ) : null}
    </div>
  );
}
