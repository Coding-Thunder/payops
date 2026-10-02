"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { LoadingButton } from "@/components/ui/loading-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ProviderSelector } from "@/components/features/providers/provider-selector";
import { api, ApiClientError } from "@/lib/api-client";
import { summarizeCharges } from "@/lib/charges";
import {
  BookingType,
  CABIN_CLASSES,
  FLIGHT_TRIP_TYPES,
  FlightTripType,
  PaymentTiming,
  ServiceType,
  type BookingType as BookingTypeT,
  type Currency,
} from "@/lib/constants/enums";
import {
  BookingTypeLabel,
  CabinClassLabel,
  FlightTripTypeLabel,
} from "@/lib/constants/labels";
import { formatCurrency } from "@/lib/format";
import { createFlightOrderSchema } from "@/lib/validation";
import type { CreateFlightOrderInput } from "@/lib/validation";
import type { OrderDTO, ProviderDTO } from "@/types";

/**
 * Create a FLIGHT order.
 *
 * A sibling of `create-order-form.tsx`, not a mode inside it. The car form
 * is left untouched by this feature, which is what guarantees the rental
 * creation flow behaves exactly as it did — there is no shared conditional
 * to get wrong, and no way for a flight field to appear on a car form.
 *
 * The cost is that the customer / charges / notes sections appear in both
 * files. That is a deliberate trade: the alternative was refactoring the
 * live car form to hoist them, and nothing in the suite covers that form's
 * rendering, so the refactor would have been unverifiable.
 *
 * Everything downstream is shared: this POSTs the same `/api/orders`, which
 * runs the same `createOrder`, which produces an order the same Stripe and
 * PayPal code paths charge. Only the payload shape differs.
 */

type FlightFormValues = z.input<typeof createFlightOrderSchema>;

interface CreateFlightOrderFormProps {
  allowedBookingTypes: readonly BookingTypeT[];
  defaultCurrency: Currency;
  allowedCurrencies: readonly string[];
  /** Providers usable for flights — already narrowed by the caller. */
  providers: ProviderDTO[];
  /** False when this form sits behind an inactive tab: hides the actions
   *  and makes submit a no-op, so a hidden panel can never create an
   *  order. */
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

  const form = useForm<FlightFormValues, unknown, CreateFlightOrderInput>({
    resolver: zodResolver(createFlightOrderSchema),
    defaultValues: {
      serviceType: ServiceType.FLIGHT,
      bookingType: allowedBookingTypes[0] ?? BookingType.NEW_BOOKING,
      provider: providers[0]?.key ?? "",
      customer: { name: "", email: "", phone: "" },
      flight: {
        tripType: FlightTripType.ONE_WAY,
        airline: "",
        flightNumber: "",
        origin: "",
        destination: "",
        departureDate: "",
        departureTimePreference: "",
        arrivalDate: "",
        returnDate: "",
        returnTimePreference: "",
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

  const chargeFields = useFieldArray({ control: form.control, name: "charges" });

  const watchedCharges = form.watch("charges");
  const watchedCurrency = form.watch("currency") ?? defaultCurrency;
  const tripType = form.watch("flight.tripType");
  const isRoundTrip = tripType === FlightTripType.ROUND_TRIP;

  const chargeSummary = summarizeCharges(
    (watchedCharges ?? []).map((c) => ({
      name: c?.name ?? "",
      amount: typeof c?.amount === "number" ? c.amount : Number(c?.amount) || 0,
      timing: (c?.timing as PaymentTiming) ?? PaymentTiming.PREPAID,
    })),
  );

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: CreateFlightOrderInput) {
    // Belt and braces with the hidden-panel guard above: an inactive tab
    // must not be able to create an order even if something submits it.
    if (!active) return;
    setServerError(null);
    try {
      const result = await api.post<CreateOrderApiResponse>(
        "/api/orders",
        values,
      );
      toast.success("Flight order created. Send the payment request next.");
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
      <form
        className="space-y-6"
        onSubmit={form.handleSubmit(onSubmit)}
        noValidate
      >
        {serverError ? (
          <Alert variant="destructive">
            <AlertTitle>Could not create order</AlertTitle>
            <AlertDescription>{serverError}</AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Booking</CardTitle>
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
                        <SelectValue placeholder="Booking type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {allowedBookingTypes.map((b) => (
                        <SelectItem key={b} value={b}>
                          {BookingTypeLabel[b]}
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
                    onValueChange={field.onChange}
                    disabled={isSubmitting}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Trip type" />
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
              name="provider"
              render={({ field, fieldState }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Airline / supplier</FormLabel>
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
                          ? "Add a flight supplier in Admin → Providers"
                          : "Select a supplier"
                      }
                    />
                  </FormControl>
                  <FormDescription>
                    Only suppliers enabled for flights are listed.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Itinerary</CardTitle>
            <CardDescription>
              This is a booking request — the fare is sourced manually. Capture
              what the customer asked for; add the airline, flight number and
              PNR once ticketed.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="flight.origin"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>From</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. London Heathrow (LHR)"
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
                      placeholder="e.g. New York JFK"
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
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Departure</FormLabel>
                  <FormControl>
                    <DateTimePicker
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      disabled={isSubmitting}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="flight.returnDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Return{isRoundTrip ? "" : " (one way — not required)"}
                  </FormLabel>
                  <FormControl>
                    <DateTimePicker
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      disabled={isSubmitting || !isRoundTrip}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="flight.cabinClass"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Cabin</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={isSubmitting}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Cabin" />
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

            <div className="grid grid-cols-3 gap-3">
              {(["adults", "children", "infants"] as const).map((who) => (
                <FormField
                  key={who}
                  control={form.control}
                  name={`flight.passengers.${who}`}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="capitalize">{who}</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={who === "adults" ? 1 : 0}
                          max={9}
                          inputMode="numeric"
                          disabled={isSubmitting}
                          {...field}
                          value={
                            typeof field.value === "number" ||
                            typeof field.value === "string"
                              ? field.value
                              : 0
                          }
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ))}
            </div>

            <FormField
              control={form.control}
              name="flight.airline"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Airline (optional)</FormLabel>
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
                      placeholder="Added once ticketed"
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
              name="flight.passengerNotes"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Passenger notes (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={2}
                      placeholder="Seat preferences, baggage, assistance…"
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
                <FormItem>
                  <FormLabel>Full name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Jane Traveller"
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
              name="customer.email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      placeholder="jane@example.com"
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
              name="customer.phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="+1 555 000 0000"
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
            <CardTitle>Charge details</CardTitle>
            <CardDescription>
              Prepaid charges are collected online via the payment link.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="currency"
              render={({ field }) => (
                <FormItem className="max-w-[200px]">
                  <FormLabel>Currency</FormLabel>
                  <Select
                    value={field.value ?? defaultCurrency}
                    onValueChange={field.onChange}
                    disabled={isSubmitting}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Currency" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {allowedCurrencies.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="space-y-3">
              {chargeFields.fields.map((row, index) => (
                <div
                  key={row.id}
                  className="grid gap-3 sm:grid-cols-[1fr_140px_auto] sm:items-end"
                >
                  <FormField
                    control={form.control}
                    name={`charges.${index}.name`}
                    render={({ field }) => (
                      <FormItem>
                        {index === 0 ? <FormLabel>Charge name</FormLabel> : null}
                        <FormControl>
                          <Input
                            placeholder="e.g. Airfare"
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
                    name={`charges.${index}.amount`}
                    render={({ field }) => (
                      <FormItem>
                        {index === 0 ? <FormLabel>Amount</FormLabel> : null}
                        <FormControl>
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            inputMode="decimal"
                            placeholder="0.00"
                            disabled={isSubmitting}
                            {...field}
                            value={field.value ?? ""}
                            // `chargeInputSchema.amount` is a strict
                            // `z.number()`, and a number input hands RHF a
                            // STRING. Without this conversion the form fails
                            // its own validation with "Enter a valid amount"
                            // and never reaches the API. Identical to the
                            // rental form's handler — the schema is shared,
                            // so the conversion has to be too.
                            onChange={(e) =>
                              field.onChange(
                                e.target.value === ""
                                  ? ""
                                  : Number(e.target.value),
                              )
                            }
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isSubmitting || chargeFields.fields.length === 1}
                    onClick={() => chargeFields.remove(index)}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                disabled={isSubmitting}
                onClick={() =>
                  chargeFields.append({
                    name: "",
                    amount: 0,
                    timing: PaymentTiming.PREPAID,
                  })
                }
              >
                + Add charge
              </Button>
            </div>

            <div className="rounded-md border border-border bg-surface-1 px-4 py-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Charged online</span>
                <strong>
                  {formatCurrency(chargeSummary.prepaid, watchedCurrency)}
                </strong>
              </div>
              <div className="mt-1 flex justify-between">
                <span className="text-muted-foreground">Total</span>
                <strong>
                  {formatCurrency(chargeSummary.total, watchedCurrency)}
                </strong>
              </div>
            </div>

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Internal notes (optional)</FormLabel>
                  <FormControl>
                    <Textarea
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
              Create order &amp; generate link
            </LoadingButton>
          </div>
        ) : null}
      </form>
    </Form>
  );
}
