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
import {
  BookingTypeLabel,
  CruiseCabinCategoryLabel,
  ServiceDueLabel,
  ServiceTotalLabel,
} from "@/lib/constants/labels";
import {
  BookingType,
  CRUISE_CABIN_CATEGORIES,
  CruiseCabinCategory,
  PaymentTiming,
  ServiceType,
  type BookingType as BookingTypeT,
  type Currency,
} from "@/lib/constants/enums";
import { cruiseOrderSchema, type CruiseOrderInput } from "@/lib/validation";
import type { OrderDTO, ProviderDTO } from "@/types";
import { ProviderSelector } from "@/components/features/providers";
import {
  ChargeLinesFieldset,
  type ChargeLinesFormValues,
} from "./charge-lines-fieldset";

/**
 * Cruise booking REQUEST form.
 *
 * Bound to `cruiseOrderSchema` and nothing else — see the note on the
 * flight form for why each service tab owns its own `useForm` rather than
 * sharing a union-typed one.
 *
 * The one structural difference from the flight form: there is no trip-type
 * toggle. A cruise always comes back, so the return date is unconditional
 * and the DISEMBARKATION PORT is the optional field instead — left blank it
 * means "returns to the departure port", which is what the overwhelming
 * majority of sailings do, and every downstream surface renders that as
 * "Round trip from Miami" rather than repeating the port twice.
 */

type CruiseOrderFormValues = z.input<typeof cruiseOrderSchema>;

/** `z.coerce.number()` widens its INPUT to `unknown` in Zod 4, so the guest
 *  counters need a narrowing on the way into a controlled input. */
function numberFieldValue(value: unknown): string | number {
  return typeof value === "number" || typeof value === "string" ? value : "";
}

interface CreateCruiseOrderFormProps {
  allowedBookingTypes: readonly BookingTypeT[];
  defaultCurrency: Currency;
  allowedCurrencies: readonly string[];
  /** Already narrowed to CRUISE suppliers by the caller. */
  providers: ProviderDTO[];
  /** `false` while this tab is not the visible one — hides the actions row
   *  and refuses the submit handler. */
  active?: boolean;
}

interface CreateOrderApiResponse {
  order: OrderDTO;
  checkoutUrl: string;
}

export function CreateCruiseOrderForm({
  allowedBookingTypes,
  defaultCurrency,
  allowedCurrencies,
  providers,
  active = true,
}: CreateCruiseOrderFormProps) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<CruiseOrderFormValues, unknown, CruiseOrderInput>({
    resolver: zodResolver(cruiseOrderSchema),
    defaultValues: {
      serviceType: ServiceType.CRUISE,
      bookingType: allowedBookingTypes[0] ?? BookingType.NEW_BOOKING,
      provider: providers[0]?.key ?? "",
      customer: { name: "", email: "", phone: "" },
      cruise: {
        cruiseLine: "",
        shipName: "",
        itinerary: "",
        departurePort: "",
        arrivalPort: "",
        departureDate: "",
        returnDate: "",
        cabinCategory: CruiseCabinCategory.INTERIOR,
        cabinNumber: "",
        guests: { adults: 2, children: 0 },
        guestNotes: "",
        bookingReference: "",
      },
      currency: defaultCurrency,
      charges: [
        { name: "Cruise fare", amount: 0, timing: PaymentTiming.PREPAID },
      ],
      notes: "",
    },
    mode: "onTouched",
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: CruiseOrderInput) {
    // Only the visible tab may post — see the flight form's note.
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
            <CardTitle>Sailing</CardTitle>
            <CardDescription>
              The voyage the guest is booking. No cabin is held here — this is
              the brief your team confirms with the cruise line.
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
              name="cruise.itinerary"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Itinerary (optional)</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Western Caribbean"
                      disabled={isSubmitting}
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormDescription>
                    The route name the cruise line markets.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="cruise.departurePort"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Departure port</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Miami, FL"
                      disabled={isSubmitting}
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Optional because most sailings are round trips. Blank means
                "returns to the departure port", and every receipt renders
                that as "Round trip from …" rather than naming it twice. */}
            <FormField
              control={form.control}
              name="cruise.arrivalPort"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Disembarkation port (optional)</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Leave blank for a round trip"
                      disabled={isSubmitting}
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormDescription>
                    Only for a one-way or repositioning sailing.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="cruise.departureDate"
              render={({ field, fieldState }) => (
                <FormItem>
                  <FormLabel>Sailing date</FormLabel>
                  <FormControl>
                    <DateTimePicker
                      id="cruise-departure-date"
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      disabled={isSubmitting}
                      placeholder="Select sailing date"
                      ariaInvalid={!!fieldState.error}
                      minDate={new Date(new Date().setHours(0, 0, 0, 0))}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Chained off the sailing date so a return can never be picked
                before the ship leaves. The schema additionally rejects an
                EQUAL date — a zero-night cruise is a typo, not a product. */}
            <FormField
              control={form.control}
              name="cruise.returnDate"
              render={({ field, fieldState }) => {
                const departure = form.watch("cruise.departureDate");
                const min = departure ? new Date(departure) : new Date();
                return (
                  <FormItem>
                    <FormLabel>Return date</FormLabel>
                    <FormControl>
                      <DateTimePicker
                        id="cruise-return-date"
                        value={field.value ?? ""}
                        onChange={field.onChange}
                        disabled={isSubmitting}
                        placeholder="Select return date"
                        ariaInvalid={!!fieldState.error}
                        minDate={min}
                      />
                    </FormControl>
                    <FormDescription>
                      When the ship docks and guests disembark.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                );
              }}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Stateroom &amp; guests</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="cruise.cabinCategory"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Cabin category</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={isSubmitting}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a cabin category" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {CRUISE_CABIN_CATEGORIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {CruiseCabinCategoryLabel[c]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    What the fare is quoted against.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="cruise.cabinNumber"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Stateroom number (optional)</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. 9204"
                      maxLength={16}
                      disabled={isSubmitting}
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormDescription>
                    Assigned by the line once the cabin is held.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="cruise.guests.adults"
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
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="cruise.guests.children"
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
                  <FormDescription>Under 18 at sailing.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="cruise.guestNotes"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Special requirements (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Dining seating, accessibility, celebrations, adjoining staterooms…"
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
            <CardTitle>Cruise line &amp; supplier</CardTitle>
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
                      id="cruise-order-provider"
                      providers={providers}
                      value={field.value ?? null}
                      onChange={field.onChange}
                      disabled={isSubmitting || providers.length === 0}
                      invalid={!!fieldState.error}
                      placeholder={
                        providers.length === 0
                          ? "Configure a provider in Admin → Providers"
                          : "Select a cruise line or travel supplier"
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

            {/* Free text alongside the supplier: the SUPPLIER may be a
                consolidator while the LINE operating the ship is someone
                else, and the guest recognises the latter. */}
            <FormField
              control={form.control}
              name="cruise.cruiseLine"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Operating cruise line (optional)</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Royal Caribbean"
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
              name="cruise.shipName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Ship (optional)</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Wonder of the Seas"
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
              name="cruise.bookingReference"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Booking reference (optional)</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. 8842317"
                      maxLength={32}
                      autoCapitalize="characters"
                      spellCheck={false}
                      disabled={isSubmitting}
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <FormDescription>
                    The cruise line&rsquo;s confirmation, added once held.
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
              Gratuities, port fees and onboard credit marked due later are
              shown for transparency but are never charged by the link.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ChargeLinesFieldset
              control={
                form.control as unknown as Control<ChargeLinesFormValues>
              }
              allowedCurrencies={allowedCurrencies}
              defaultCurrency={defaultCurrency}
              disabled={isSubmitting}
              namePlaceholder="e.g. Cruise fare"
              dueLaterLabel={ServiceDueLabel[ServiceType.CRUISE]}
              totalLabel={ServiceTotalLabel[ServiceType.CRUISE]}
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
              Create order &amp; generate link
            </LoadingButton>
          </div>
        ) : null}
      </form>
    </Form>
  );
}
