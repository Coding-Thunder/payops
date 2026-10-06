"use client";

import { Fragment } from "react";
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from "lucide-react";
import { useFieldArray, useFormContext } from "react-hook-form";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import {
  type FlightJourneyKey,
  type ItineraryIssue,
  MAX_SEGMENTS_PER_JOURNEY,
} from "@/lib/flight-itinerary";
import type { FlightOrderInput } from "@/lib/validation";

import { ConnectionRow } from "./connection-row";
import { ItineraryIssueList } from "./itinerary-issue-list";
import {
  connectionsAroundSwap,
  connectionsLostOnRemove,
  emptySegment,
  type FlightOrderFormValues,
  hasLayover,
  placeJourneyIssues,
} from "./itinerary-form";

/**
 * One direction of travel — `flight.outbound`, or a round trip's
 * `flight.return` — as an ordered list of numbered flights with the
 * connection between each adjacent pair.
 *
 * Each instance owns its own two field arrays, so the outbound and return
 * journeys never share segments, connections or layovers. The arrays move
 * in lockstep: a journey of N flights always has N - 1 connections, and
 * connection i is the gap between flight i+1 and flight i+2. Every edit
 * below keeps that true, and an edit that changes which two flights a gap
 * joins clears that gap's layover — out loud, never silently.
 */

interface JourneyEditorProps {
  journey: FlightJourneyKey;
  heading: string;
  description: string;
  /** Every live itinerary issue; this editor shows its own journey's. */
  issues: readonly ItineraryIssue[];
  disabled: boolean;
}

function announceDiscardedLayovers(count: number) {
  if (count === 0) return;
  toast.warning(
    count === 1 ? "Layover removed" : `${count} layovers removed`,
    {
      description:
        "A layover belongs to the connection between two flights, and those flights changed. Add it again where it still applies.",
    },
  );
}

export function JourneyEditor({
  journey,
  heading,
  description,
  issues,
  disabled,
}: JourneyEditorProps) {
  const { control, getValues, getFieldState, trigger, clearErrors } = useFormContext<
    FlightOrderFormValues,
    unknown,
    FlightOrderInput
  >();
  const base = `flight.${journey}` as const;
  const segments = useFieldArray({ control, name: `${base}.segments` });
  // Never rendered from directly — connection rows are positioned by the
  // segments — but its operations keep RHF's per-index field registry and
  // errors aligned with the values when connections shift.
  const connections = useFieldArray({ control, name: `${base}.connections` });

  const count = segments.fields.length;
  const slots = placeJourneyIssues(issues, journey, count);

  function addSegment() {
    const current = getValues(`${base}.segments`) ?? [];
    const previousTo = (current[current.length - 1]?.destination ?? "").trim();
    if (current.length > 0) {
      // Before the segment: each append re-targets RHF's focus, and the
      // new flight's first empty field is what should end up focused.
      connections.append({ layover: null }, { shouldFocus: false });
    }
    segments.append(emptySegment(previousTo), {
      focusName: `${base}.segments.${current.length}.${
        previousTo ? "destination" : "origin"
      }`,
    });
  }

  function removeSegment(index: number) {
    if (count <= 1) return;
    const current = getValues(`${base}.connections`) ?? [];
    const lost = connectionsLostOnRemove(count, index).filter((c) =>
      hasLayover(current[c]),
    ).length;
    segments.remove(index);
    if (index === 0) {
      connections.remove(0);
    } else if (index === count - 1) {
      connections.remove(count - 2);
    } else {
      // The two gaps around a middle flight become one new gap between its
      // neighbours, which no layover recorded so far describes.
      connections.remove(index);
      if (hasLayover(current[index - 1])) {
        connections.update(index - 1, { layover: null });
        clearErrors(`${base}.connections.${index - 1}.layover`);
      }
    }
    announceDiscardedLayovers(lost);
  }

  function moveSegment(index: number, direction: -1 | 1) {
    const upper = direction < 0 ? index - 1 : index;
    if (upper < 0 || upper + 1 >= count) return;
    const current = getValues(`${base}.connections`) ?? [];
    const reset = connectionsAroundSwap(count, upper).filter((c) =>
      hasLayover(current[c]),
    );
    segments.swap(upper, upper + 1);
    for (const c of reset) {
      connections.update(c, { layover: null });
      // A layover added back on this gap must not inherit the old one's
      // error (an invalid override that was flagged before the reset).
      clearErrors(`${base}.connections.${c}.layover`);
    }
    announceDiscardedLayovers(reset.length);
  }

  /**
   * A new flight's From is a SUGGESTION — the previous flight's To. When
   * that To is edited, the suggestion follows only while the next From is
   * still empty or still exactly the old suggestion; a From the operator
   * changed by hand is never overwritten.
   */
  function suggestNextOrigin(index: number, previousTo: string, nextTo: string) {
    if (index + 1 >= count) return;
    const path = `${base}.segments.${index + 1}.origin` as const;
    const current = getValues(path) ?? "";
    // Trimmed on both sides: the suggestion was stored trimmed when the
    // flight was added, whatever spacing the previous To had then.
    if (current.trim() !== "" && current.trim() !== previousTo.trim()) return;
    // Through the field array, NOT setValue: a setValue on a path inside a
    // field array makes react-hook-form regenerate EVERY row id, which
    // remounts every flight card — including the To input being typed in,
    // so only the first keystroke would land. update() re-keys only the
    // next (unfocused) flight.
    const hadError = !!getFieldState(path).error;
    segments.update(index + 1, {
      ...emptySegment(),
      ...getValues(`${base}.segments.${index + 1}`),
      origin: nextTo.trim(),
    });
    // Refresh an error already on screen; never raise a new one on a field
    // the operator has not reached yet.
    if (hadError) void trigger(path);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{heading}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ol className="space-y-3">
          {segments.fields.map((row, index) => (
            <Fragment key={row.id}>
              <li>
                <SegmentCard
                  journey={journey}
                  index={index}
                  count={count}
                  issues={slots.segments[index] ?? []}
                  disabled={disabled}
                  onMove={moveSegment}
                  onRemove={removeSegment}
                  onDestinationChange={suggestNextOrigin}
                />
              </li>
              {/* A direct flight has no connection, so no layover UI. */}
              {index < count - 1 ? (
                <li
                  aria-label={`Connection between flight ${index + 1} and flight ${index + 2}`}
                >
                  <ConnectionRow
                    journey={journey}
                    index={index}
                    issues={slots.connections[index] ?? []}
                    disabled={disabled}
                  />
                </li>
              ) : null}
            </Fragment>
          ))}
        </ol>

        <ItineraryIssueList issues={slots.journey} />

        <Button
          type="button"
          variant="outline"
          className="h-10 w-full sm:h-8 sm:w-auto"
          onClick={addSegment}
          disabled={disabled || count >= MAX_SEGMENTS_PER_JOURNEY}
        >
          + Add Flight Segment
        </Button>
      </CardContent>
    </Card>
  );
}

interface SegmentCardProps {
  journey: FlightJourneyKey;
  index: number;
  count: number;
  /** Live issues about this flight itself. */
  issues: readonly ItineraryIssue[];
  disabled: boolean;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove: (index: number) => void;
  onDestinationChange: (index: number, previous: string, next: string) => void;
}

/** One flight. Numbered by position, so reordering renumbers it. */
function SegmentCard({
  journey,
  index,
  count,
  issues,
  disabled,
  onMove,
  onRemove,
  onDestinationChange,
}: SegmentCardProps) {
  const { control, getValues } = useFormContext<
    FlightOrderFormValues,
    unknown,
    FlightOrderInput
  >();
  const at = `flight.${journey}.segments.${index}` as const;
  const number = index + 1;

  return (
    <div className="rounded-lg border bg-card p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <span
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs tabular-nums"
            aria-hidden
          >
            {number}
          </span>
          {`Flight ${number}`}
        </h4>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10 sm:size-8"
            onClick={() => onMove(index, -1)}
            disabled={disabled || index === 0}
            aria-label={`Move flight ${number} up`}
            title="Move up"
          >
            <ArrowUpIcon className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10 sm:size-8"
            onClick={() => onMove(index, 1)}
            disabled={disabled || index === count - 1}
            aria-label={`Move flight ${number} down`}
            title="Move down"
          >
            <ArrowDownIcon className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10 text-muted-foreground hover:text-destructive sm:size-8"
            onClick={() => onRemove(index)}
            disabled={disabled || count <= 1}
            aria-label={`Delete flight ${number}`}
            title="Delete"
          >
            <Trash2Icon className="size-4" />
          </Button>
        </div>
      </div>

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <FormField
          control={control}
          name={`${at}.origin`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>From</FormLabel>
              <FormControl>
                <Input
                  placeholder="e.g. LHR — London Heathrow"
                  maxLength={120}
                  autoComplete="off"
                  disabled={disabled}
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name={`${at}.destination`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>To</FormLabel>
              <FormControl>
                <Input
                  placeholder="e.g. JFK — New York"
                  maxLength={120}
                  autoComplete="off"
                  disabled={disabled}
                  {...field}
                  value={field.value ?? ""}
                  onChange={(e) => {
                    const previous = getValues(`${at}.destination`) ?? "";
                    field.onChange(e);
                    onDestinationChange(index, previous, e.target.value);
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name={`${at}.departure.date`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Departure date</FormLabel>
              <FormControl>
                <Input
                  type="date"
                  disabled={disabled}
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name={`${at}.departure.time`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Departure time</FormLabel>
              <FormControl>
                <Input
                  type="time"
                  disabled={disabled}
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name={`${at}.arrival.date`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Arrival date</FormLabel>
              <FormControl>
                <Input
                  type="date"
                  disabled={disabled}
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name={`${at}.arrival.time`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Arrival time</FormLabel>
              <FormControl>
                <Input
                  type="time"
                  disabled={disabled}
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name={`${at}.airline`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Airline (optional)</FormLabel>
              <FormControl>
                <Input
                  placeholder="e.g. British Airways"
                  maxLength={80}
                  disabled={disabled}
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name={`${at}.flightNumber`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Flight number (optional)</FormLabel>
              <FormControl>
                <Input
                  placeholder="e.g. BA117"
                  maxLength={16}
                  autoCapitalize="characters"
                  spellCheck={false}
                  disabled={disabled}
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={control}
          name={`${at}.details`}
          render={({ field }) => (
            <FormItem className="sm:col-span-2">
              <FormLabel>Flight details (optional)</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="Terminal, aircraft, baggage allowance, fare notes…"
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
      </div>

      <ItineraryIssueList issues={issues} className="mt-3" />
    </div>
  );
}
