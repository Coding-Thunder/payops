"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useForm, type Control, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { api, ApiClientError } from "@/lib/api-client";
import {
  BookingTypeLabel,
  CabinClassLabel,
  FLIGHT_PROVIDER_LABEL,
  FlightTripTypeLabel,
} from "@/lib/constants/labels";
import {
  BookingType,
  type BookingType as BookingTypeT,
  CABIN_CLASSES,
  CabinClass,
  type Currency,
  FLIGHT_TRIP_TYPES,
  FlightTripType,
  PaymentTiming,
} from "@/lib/constants/enums";
import { normalizeTripType } from "@/lib/flight-itinerary";
import { flightOrderSchema, type FlightOrderInput } from "@/lib/validation";
import type { OrderDTO, ProviderDTO } from "@/types";
import { ProviderSelector } from "@/components/features/providers";
import {
  ChargeLinesFieldset,
  type ChargeLinesFormValues,
} from "./charge-lines-fieldset";
import { FlightAmountsSummary } from "./flight/flight-amounts-summary";
import { ItineraryEditor } from "./flight/itinerary-editor";
import {
  emptySegment,
  flagItineraryErrors,
  type FlightJourneyFormValue,
  type FlightOrderFormValues,
  initialReturnJourney,
  normalizeJourneyArrayErrors,
} from "./flight/itinerary-form";

/**
 * Flight booking form — the itinerary the operator sourced, and the money.
 *
 * Bound to `flightOrderSchema` and nothing else. There is deliberately no
 * shared union-typed `useForm` across the three service tabs: RHF resolves
 * field paths structurally, and a `useForm<CarRental | Flight | Hotel>`
 * makes `trip.pickupDate` and `flight.outbound` siblings in the same field
 * registry — which is how half-typed values leak across tabs. One schema,
 * one resolver, one form state per tab.
 *
 * The itinerary itself — journeys, numbered flights, connections, layovers
 * and their live validation — lives in `./flight/`. The money is PREPAID
 * only: the charge lines are the operator's service charge, the one amount
 * the payment link collects, and the airline fare sits beside them as part
 * of the booking value the customer is shown, never sent to the gateway.
 *
 * Nothing here touches the car-rental path.
 */

/** `z.coerce.number()` widens its INPUT to `unknown` in Zod 4, so the
 *  passenger counters need a narrowing on the way into a controlled input. */
function numberFieldValue(value: unknown): string | number {
  return typeof value === "number" || typeof value === "string" ? value : "";
}

/** No due-at-counter for a flight — nothing is paid at an airport desk. */
const FLIGHT_CHARGE_TIMINGS = [PaymentTiming.PREPAID] as const;

const zodFlightResolver = zodResolver(flightOrderSchema);

/**
 * The schema's resolver, with each cross-flight itinerary error kept — it
 * still blocks the submit and flags the field — but not printed under the
 * field as well: the itinerary editor already explains it in the
 * connection row or under the flight. See `flagItineraryErrors`.
 */
const flightOrderResolver: Resolver<
  FlightOrderFormValues,
  unknown,
  FlightOrderInput
> = async (values, context, options) =>
  normalizeJourneyArrayErrors(
    flagItineraryErrors(
      await zodFlightResolver(values, context, options),
      values.flight,
    ),
  );

interface CreateFlightOrderFormProps {
  allowedBookingTypes: readonly BookingTypeT[];
  defaultCurrency: Currency;
  allowedCurrencies: readonly string[];
  /** Already narrowed to FLIGHT suppliers by the caller. */
  providers: ProviderDTO[];
  /** `false` while this tab is not the visible one — hides the actions row
   *  and refuses the submit handler. */
  active?: boolean;
}

interface CreateOrderApiResponse {
  order: OrderDTO;
  checkoutUrl: string;
}

export function CreateFlightOrderForm({
  allowedBookingTypes,
  defaultCurrency,
  allowedCurrencies,
  providers,
  active = true,
}: CreateFlightOrderFormProps) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  /** The return journey while the trip is NOT a round trip, so switching
   *  back restores what the operator had entered instead of a blank one. */
  const stashedReturn = useRef<FlightJourneyFormValue | null>(null);

  const form = useForm<FlightOrderFormValues, unknown, FlightOrderInput>({
    resolver: flightOrderResolver,
    defaultValues: {
      serviceType: "FLIGHT",
      bookingType: allowedBookingTypes[0] ?? BookingType.NEW_BOOKING,
      provider: providers[0]?.key ?? "",
      customer: { name: "", email: "", phone: "" },
      flight: {
        tripType: FlightTripType.ONE_WAY,
        outbound: { segments: [emptySegment()], connections: [] },
        return: null,
        cabinClass: CabinClass.ECONOMY,
        passengers: { adults: 1, children: 0, infants: 0 },
        passengerNotes: "",
        pnr: "",
        airlineFare: null,
      },
      currency: defaultCurrency,
      charges: [
        { name: "Service charge", amount: 0, timing: PaymentTiming.PREPAID },
      ],
      notes: "",
    },
    mode: "onTouched",
  });

  const isSubmitting = form.formState.isSubmitting;

  /**
   * The trip type decides which journeys exist. Becoming a round trip
   * brings back the return journey the operator had, or starts one flight
   * home from where the outbound ends. Leaving a round trip stashes the
   * return and nulls it in the form, so a one-way or multi-city order can
   * never carry a return the operator can no longer see. One way and
   * multi-city share the outbound flights as they are.
   */
  function changeTripType(next: FlightTripType, previous: FlightTripType) {
    if (next === previous) return;
    if (next === FlightTripType.ROUND_TRIP) {
      form.setValue(
        "flight.return",
        stashedReturn.current ??
          initialReturnJourney(form.getValues("flight.outbound.segments")),
        { shouldDirty: true },
      );
      stashedReturn.current = null;
    } else if (previous === FlightTripType.ROUND_TRIP) {
      stashedReturn.current = form.getValues("flight.return") ?? null;
      form.setValue("flight.return", null, { shouldDirty: true });
      form.clearErrors("flight.return");
    }
  }

  async function onSubmit(values: FlightOrderInput) {
    // Only the visible tab may post. Each tab owns its own <form>, so the
    // browser already scopes a submit to one of them; this guard makes the
    // rule explicit rather than emergent.
    if (!active) return;
    setServerError(null);
    try {
      const result = await api.post<CreateOrderApiResponse>(
        "/api/orders",
        values,
      );
      toast.success("Order created. Send the payment request next.");
      router.replace(`/app/orders/${result.order.id}/email`);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : "Something went wrong. Please try again.";
      setServerError(message);
      toast.error(message);
    }
  }

  return (
    <Form {...form}>
      <form className="space-y-6" onSubmit={form.handleSubmit(onSubmit)} noValidate>
        {serverError ? (
          <Alert variant="destructive">
            <AlertTitle>Could not create order</AlertTitle>
            <AlertDescription>{serverError}</AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Trip</CardTitle>
            <CardDescription>
              Trip type and cabin class apply to the whole itinerary.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <FormField
              control={form.control}
              name="bookingType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Booking type</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={isSubmitting}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select booking type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {allowedBookingTypes.map((t) => (
                        <SelectItem key={t} value={t}>
                          {BookingTypeLabel[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="flight.tripType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Trip type</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(value) => {
                      const next = normalizeTripType(value);
                      changeTripType(next, normalizeTripType(field.value));
                      field.onChange(next);
                    }}
                    disabled={isSubmitting}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select trip type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {FLIGHT_TRIP_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {FlightTripTypeLabel[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="flight.cabinClass"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Cabin class</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={isSubmitting}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select cabin class" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {CABIN_CLASSES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {CabinClassLabel[c]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <ItineraryEditor disabled={isSubmitting} />

        <Card>
          <CardHeader>
            <CardTitle>Passengers</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <FormField
              control={form.control}
              name="flight.passengers.adults"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Adults</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={1}
                      max={9}
                      step={1}
                      inputMode="numeric"
                      disabled={isSubmitting}
                      {...field}
                      value={numberFieldValue(field.value)}
                      onChange={(e) =>
                        field.onChange(
                          e.target.value === "" ? "" : Number(e.target.value),
                        )
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="flight.passengers.children"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Children</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      max={9}
                      step={1}
                      inputMode="numeric"
                      disabled={isSubmitting}
                      {...field}
                      value={numberFieldValue(field.value)}
                      onChange={(e) =>
                        field.onChange(
                          e.target.value === "" ? "" : Number(e.target.value),
                        )
                      }
                    />
                  </FormControl>
                  <FormDescription>2–11 years at travel.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="flight.passengers.infants"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Infants</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      max={9}
                      step={1}
                      inputMode="numeric"
                      disabled={isSubmitting}
                      {...field}
                      value={numberFieldValue(field.value)}
                      onChange={(e) =>
                        field.onChange(
                          e.target.value === "" ? "" : Number(e.target.value),
                        )
                      }
                    />
                  </FormControl>
                  <FormDescription>Each must travel with an adult.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="flight.passengerNotes"
              render={({ field }) => (
                <FormItem className="sm:col-span-3">
                  <FormLabel>Special requirements (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Seating, meals, mobility assistance, frequent-flyer numbers…"
                      rows={3}
                      disabled={isSubmitting}
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Customer</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="customer.name"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Full name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Jane Smith"
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="customer.email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      inputMode="email"
                      placeholder="jane@example.com"
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Confirmation email is sent here after payment.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="customer.phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone</FormLabel>
                  <FormControl>
                    <Input
                      type="tel"
                      inputMode="tel"
                      placeholder="+1 555 0100"
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{FLIGHT_PROVIDER_LABEL}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="provider"
              render={({ field, fieldState }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>{FLIGHT_PROVIDER_LABEL}</FormLabel>
                  <FormControl>
                    <ProviderSelector
                      id="flight-order-provider"
                      providers={providers}
                      value={field.value ?? null}
                      onChange={field.onChange}
                      disabled={isSubmitting || providers.length === 0}
                      invalid={!!fieldState.error}
                      heading="Airlines & suppliers"
                      placeholder={
                        providers.length === 0
                          ? "Configure a provider in Admin → Providers"
                          : "Select an airline or travel supplier"
                      }
                    />
                  </FormControl>
                  <FormDescription>
                    Branding on the customer receipt is pulled from this
                    selection.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="flight.pnr"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>PNR / record locator (optional)</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. X4T9KP"
                      maxLength={32}
                      autoCapitalize="characters"
                      spellCheck={false}
                      disabled={isSubmitting}
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormDescription>
                    The airline booking reference, added once ticketed.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Fare & service charge</CardTitle>
            <CardDescription>
              The payment link collects only the service charge. The airline
              fare is shown to the customer as part of the total booking
              value, but is never part of this payment.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Prepaid-only mode: no timing column and no counter wording,
                and the rental breakdown swapped for fare + service charge =
                total booking value. */}
            <ChargeLinesFieldset
              control={form.control as unknown as Control<ChargeLinesFormValues>}
              allowedCurrencies={allowedCurrencies}
              defaultCurrency={defaultCurrency}
              disabled={isSubmitting}
              timings={FLIGHT_CHARGE_TIMINGS}
              namePlaceholder="e.g. Service charge"
              afterCurrency={
                <FormField
                  control={form.control}
                  name="flight.airlineFare"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Airline fare (optional)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
                          step="0.01"
                          inputMode="decimal"
                          placeholder="0.00"
                          className="sm:max-w-[200px]"
                          disabled={isSubmitting}
                          {...field}
                          value={field.value ?? ""}
                          onChange={(e) =>
                            field.onChange(
                              e.target.value === ""
                                ? null
                                : Number(e.target.value),
                            )
                          }
                        />
                      </FormControl>
                      <FormDescription>
                        Shown to the customer as part of the total booking
                        value — never charged by the payment link.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              }
              renderSummary={(live) => <FlightAmountsSummary {...live} />}
            />

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Internal notes (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Anything the team should know about this booking…"
                      rows={3}
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {active ? (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => router.back()}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <LoadingButton
              type="submit"
              loading={isSubmitting}
              loadingText="Creating order"
            >
              Create order & generate link
            </LoadingButton>
          </div>
        ) : null}
      </form>
    </Form>
  );
}
