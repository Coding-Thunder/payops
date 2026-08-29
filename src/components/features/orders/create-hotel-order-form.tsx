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
import { hotelOrderSchema, type HotelOrderInput } from "@/lib/validation";
import type { OrderDTO, ProviderDTO } from "@/types";
import { ProviderSelector } from "@/components/features/providers";
import {
  ChargeLinesFieldset,
  type ChargeLinesFormValues,
} from "./charge-lines-fieldset";

/**
 * Hotel booking REQUEST form.
 *
 * Bound to `hotelOrderSchema` alone — see the note in the flight form for
 * why the three service tabs never share one union-typed `useForm`.
 *
 * Nothing here touches the car-rental path.
 */

type HotelOrderFormValues = z.input<typeof hotelOrderSchema>;

/** `z.coerce.number()` widens its INPUT to `unknown` in Zod 4, so rooms and
 *  guest counters need a narrowing on the way into a controlled input. */
function numberFieldValue(value: unknown): string | number {
  return typeof value === "number" || typeof value === "string" ? value : "";
}

interface CreateHotelOrderFormProps {
  allowedBookingTypes: readonly BookingTypeT[];
  defaultCurrency: Currency;
  allowedCurrencies: readonly string[];
  /** Already narrowed to HOTEL suppliers by the caller. */
  providers: ProviderDTO[];
  /** `false` while this tab is not the visible one — hides the actions row
   *  and refuses the submit handler. */
  active?: boolean;
}

interface CreateOrderApiResponse {
  order: OrderDTO;
  checkoutUrl: string;
}

export function CreateHotelOrderForm({
  allowedBookingTypes,
  defaultCurrency,
  allowedCurrencies,
  providers,
  active = true,
}: CreateHotelOrderFormProps) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<HotelOrderFormValues, unknown, HotelOrderInput>({
    resolver: zodResolver(hotelOrderSchema),
    defaultValues: {
      serviceType: "HOTEL",
      bookingType: allowedBookingTypes[0] ?? BookingType.NEW_BOOKING,
      provider: providers[0]?.key ?? "",
      customer: { name: "", email: "", phone: "" },
      hotel: {
        destination: "",
        propertyName: "",
        checkInDate: "",
        checkOutDate: "",
        rooms: 1,
        guests: { adults: 2, children: 0 },
        roomPreference: "",
        guestNotes: "",
      },
      currency: defaultCurrency,
      charges: [
        { name: "Room charge", amount: 0, timing: PaymentTiming.PREPAID },
      ],
      notes: "",
    },
    mode: "onTouched",
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: HotelOrderInput) {
    // Only the visible tab may post — same rule as the flight tab.
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
            <CardTitle>Stay</CardTitle>
            <CardDescription>
              Where and when. The property can stay blank until your team has
              sourced it.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="bookingType"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
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
              name="hotel.destination"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Destination</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Barcelona, Spain"
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
              name="hotel.propertyName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Hotel name (optional)</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Hotel Arts Barcelona"
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
              name="hotel.checkInDate"
              render={({ field, fieldState }) => (
                <FormItem>
                  <FormLabel>Check-in</FormLabel>
                  <FormControl>
                    <DateTimePicker
                      id="hotel-check-in"
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      disabled={isSubmitting}
                      placeholder="Select check-in"
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
              name="hotel.checkOutDate"
              render={({ field, fieldState }) => {
                const checkIn = form.watch("hotel.checkInDate");
                const min = checkIn ? new Date(checkIn) : new Date();
                return (
                  <FormItem>
                    <FormLabel>Check-out</FormLabel>
                    <FormControl>
                      <DateTimePicker
                        id="hotel-check-out"
                        value={field.value ?? ""}
                        onChange={field.onChange}
                        disabled={isSubmitting}
                        placeholder="Select check-out"
                        ariaInvalid={!!fieldState.error}
                        minDate={min}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                );
              }}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Rooms & guests</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <FormField
              control={form.control}
              name="hotel.rooms"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Rooms</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={1}
                      max={20}
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
              name="hotel.guests.adults"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Adults</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={1}
                      max={20}
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
                  <FormDescription>Across all rooms.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="hotel.guests.children"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Children</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      max={20}
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
              name="hotel.roomPreference"
              render={({ field }) => (
                <FormItem className="sm:col-span-3">
                  <FormLabel>Room preferences (optional)</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Two double beds, high floor, sea view"
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
              name="hotel.guestNotes"
              render={({ field }) => (
                <FormItem className="sm:col-span-3">
                  <FormLabel>Guest notes (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Late arrival, accessibility needs, occasion, loyalty numbers…"
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
            <CardTitle>Hotel supplier</CardTitle>
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
                      id="hotel-order-provider"
                      providers={providers}
                      value={field.value ?? null}
                      onChange={field.onChange}
                      disabled={isSubmitting || providers.length === 0}
                      invalid={!!fieldState.error}
                      placeholder={
                        providers.length === 0
                          ? "Configure a provider in Admin → Providers"
                          : "Select a hotel group or travel supplier"
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Charge details</CardTitle>
            <CardDescription>
              Prepaid charges are collected online via the payment link.
              Anything marked due later is shown to the customer for
              transparency but is collected at the property.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ChargeLinesFieldset
              control={form.control as unknown as Control<ChargeLinesFormValues>}
              allowedCurrencies={allowedCurrencies}
              defaultCurrency={defaultCurrency}
              disabled={isSubmitting}
              dueLaterLabel="Amount due at the property"
              totalLabel="Total stay cost"
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
