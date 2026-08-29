"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm, type Control } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";

import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DateTimePicker } from "@/components/common/date-time-picker";
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
import { BookingTypeLabel } from "@/lib/constants/labels";
import {
  BookingType,
  type BookingType as BookingTypeT,
  type Currency,
  PaymentTiming,
} from "@/lib/constants/enums";
import { flightOrderSchema, type FlightOrderInput } from "@/lib/validation";
import type { OrderDTO, ProviderDTO } from "@/types";
import { ProviderSelector } from "@/components/features/providers";
import {
  ChargeLinesFieldset,
  type ChargeLinesFormValues,
} from "./charge-lines-fieldset";

/**
 * Flight booking REQUEST form.
 *
 * Bound to `flightOrderSchema` and nothing else. There is deliberately no
 * shared union-typed `useForm` across the three service tabs: RHF resolves
 * field paths structurally, and a `useForm<CarRental | Flight | Hotel>`
 * makes `trip.pickupDate` and `flight.origin` siblings in the same field
 * registry — which is how half-typed values leak across tabs. One schema,
 * one resolver, one form state per tab.
 *
 * Nothing here touches the car-rental path.
 */

// Same input/output split the rental form documents: `z.coerce` and
// `.default()` mean the schema's input shape is NOT its output shape, so the
// form state is typed from `z.input` and `handleSubmit` yields `z.output`.
type FlightOrderFormValues = z.input<typeof flightOrderSchema>;

/** `z.coerce.number()` widens its INPUT to `unknown` in Zod 4, so the
 *  passenger counters need a narrowing on the way into a controlled input. */
function numberFieldValue(value: unknown): string | number {
  return typeof value === "number" || typeof value === "string" ? value : "";
}

const TRIP_TYPES = [
  { value: "ONE_WAY", label: "One way" },
  { value: "ROUND_TRIP", label: "Round trip" },
] as const;

const CABIN_CLASSES = [
  { value: "ECONOMY", label: "Economy" },
  { value: "PREMIUM_ECONOMY", label: "Premium economy" },
  { value: "BUSINESS", label: "Business" },
  { value: "FIRST", label: "First" },
] as const;

/** Free text in the schema (max 40 chars); offered as a short list here so
 *  the operator sourcing the fare reads the same handful of phrases. */
const TIME_PREFERENCES = [
  "Any time",
  "Early morning",
  "Morning",
  "Afternoon",
  "Evening",
  "Red-eye",
] as const;

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

  const form = useForm<FlightOrderFormValues, unknown, FlightOrderInput>({
    resolver: zodResolver(flightOrderSchema),
    defaultValues: {
      serviceType: "FLIGHT",
      bookingType: allowedBookingTypes[0] ?? BookingType.NEW_BOOKING,
      provider: providers[0]?.key ?? "",
      customer: { name: "", email: "", phone: "" },
      flight: {
        tripType: "ONE_WAY",
        airline: "",
        flightNumber: "",
        origin: "",
        destination: "",
        departureDate: "",
        departureTimePreference: "Any time",
        arrivalDate: "",
        returnDate: "",
        returnTimePreference: "Any time",
        cabinClass: "ECONOMY",
        passengers: { adults: 1, children: 0, infants: 0 },
        passengerNotes: "",
        pnr: "",
      },
      currency: defaultCurrency,
      charges: [{ name: "Airfare", amount: 0, timing: PaymentTiming.PREPAID }],
      notes: "",
    },
    mode: "onTouched",
  });

  const isSubmitting = form.formState.isSubmitting;
  const tripType = form.watch("flight.tripType");
  const isRoundTrip = tripType === "ROUND_TRIP";

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
            <CardTitle>Flight request</CardTitle>
            <CardDescription>
              What the traveller is asking for. No fare is held — this is the
              brief your team sources against.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
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
                    onValueChange={(next) => {
                      field.onChange(next);
                      // Drop the return leg on the way to one-way, so a
                      // one-way request can never ship a stale return date
                      // the operator can no longer see or edit.
                      if (next === "ONE_WAY") {
                        form.setValue("flight.returnDate", "", {
                          shouldDirty: true,
                        });
                        form.setValue(
                          "flight.returnTimePreference",
                          TIME_PREFERENCES[0],
                          { shouldDirty: true },
                        );
                        form.clearErrors("flight.returnDate");
                      }
                    }}
                    disabled={isSubmitting}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select trip type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {TRIP_TYPES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
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
              name="flight.origin"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>From</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. LHR — London Heathrow"
                      disabled={isSubmitting}
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="flight.destination"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>To</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. JFK — New York"
                      disabled={isSubmitting}
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="flight.departureDate"
              render={({ field, fieldState }) => (
                <FormItem>
                  <FormLabel>Departure date</FormLabel>
                  <FormControl>
                    <DateTimePicker
                      id="flight-departure-date"
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      disabled={isSubmitting}
                      placeholder="Select departure"
                      ariaInvalid={!!fieldState.error}
                      minDate={new Date(new Date().setHours(0, 0, 0, 0))}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="flight.departureTimePreference"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Departure time preference</FormLabel>
                  <Select
                    value={field.value ?? TIME_PREFERENCES[0]}
                    onValueChange={field.onChange}
                    disabled={isSubmitting}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="No preference" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {TIME_PREFERENCES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Outbound arrival. Optional, because a request is often quoted
                before a specific itinerary is chosen — and chained off the
                departure the same way the return leg is, so an arrival can
                never be picked before the flight leaves. */}
            <FormField
              control={form.control}
              name="flight.arrivalDate"
              render={({ field, fieldState }) => {
                const departure = form.watch("flight.departureDate");
                const min = departure ? new Date(departure) : new Date();
                return (
                  <FormItem>
                    <FormLabel>Arrival date (optional)</FormLabel>
                    <FormControl>
                      <DateTimePicker
                        id="flight-arrival-date"
                        value={field.value ?? ""}
                        onChange={field.onChange}
                        disabled={isSubmitting}
                        placeholder="Select arrival"
                        ariaInvalid={!!fieldState.error}
                        minDate={min}
                      />
                    </FormControl>
                    <FormDescription>
                      Outbound arrival. Fill in once the itinerary is set.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                );
              }}
            />

            {/* Return leg only exists on a round trip — and the schema only
                requires it there, so hiding it keeps the form and the
                validation telling the same story. */}
            {isRoundTrip ? (
              <>
                <FormField
                  control={form.control}
                  name="flight.returnDate"
                  render={({ field, fieldState }) => {
                    const departure = form.watch("flight.departureDate");
                    const min = departure ? new Date(departure) : new Date();
                    return (
                      <FormItem>
                        <FormLabel>Return date</FormLabel>
                        <FormControl>
                          <DateTimePicker
                            id="flight-return-date"
                            value={field.value ?? ""}
                            onChange={field.onChange}
                            disabled={isSubmitting}
                            placeholder="Select return"
                            ariaInvalid={!!fieldState.error}
                            minDate={min}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    );
                  }}
                />

                <FormField
                  control={form.control}
                  name="flight.returnTimePreference"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Return time preference</FormLabel>
                      <Select
                        value={field.value ?? TIME_PREFERENCES[0]}
                        onValueChange={field.onChange}
                        disabled={isSubmitting}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="No preference" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {TIME_PREFERENCES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {t}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            ) : null}

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
                        <SelectItem key={c.value} value={c.value}>
                          {c.label}
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
            <CardTitle>Airline & supplier</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="provider"
              render={({ field, fieldState }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Supplier</FormLabel>
                  <FormControl>
                    <ProviderSelector
                      id="flight-order-provider"
                      providers={providers}
                      value={field.value ?? null}
                      onChange={field.onChange}
                      disabled={isSubmitting || providers.length === 0}
                      invalid={!!fieldState.error}
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
              name="flight.airline"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Operating airline (optional)</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. British Airways"
                      disabled={isSubmitting}
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="flight.flightNumber"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Flight number (optional)</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. BA117"
                      disabled={isSubmitting}
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormDescription>
                    Fill in once the fare has been sourced.
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
            <CardTitle>Charge details</CardTitle>
            <CardDescription>
              Prepaid charges are collected online via the payment link.
              Anything marked due later is shown to the customer for
              transparency but is never charged by the link.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ChargeLinesFieldset
              control={form.control as unknown as Control<ChargeLinesFormValues>}
              allowedCurrencies={allowedCurrencies}
              defaultCurrency={defaultCurrency}
              disabled={isSubmitting}
              dueLaterLabel="Amount due later"
              totalLabel="Total fare"
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
