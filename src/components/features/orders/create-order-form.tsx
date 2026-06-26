"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
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
  PaymentTimingLabel,
} from "@/lib/constants/labels";
import {
  BookingType,
  type BookingType as BookingTypeT,
  type Currency,
  PAYMENT_TIMINGS,
  PaymentTiming,
} from "@/lib/constants/enums";
import {
  createOrderSchema,
  type CreateOrderInput,
} from "@/lib/validation";
import { summarizeCharges } from "@/lib/charges";
import { formatCurrency } from "@/lib/format";
import type { OrderDTO, ProviderDTO } from "@/types";
import { ProviderSelector } from "@/components/features/providers";
import {
  CarLinkSelector,
  type CarLinkSelection,
} from "@/components/features/car-links";
import { ImageUrlPreview } from "@/components/common/image-url-preview";

// See note in create-car-link-dialog: the zod schema for vehicle.imageUrl
// is `.optional().nullable().transform()`, so input ≠ output. We type
// `useForm` with the schema's *input* shape for the field state and the
// *output* shape for what `handleSubmit` produces — matching the
// resolver's signature in RHF v7.
type CreateOrderFormValues = z.input<typeof createOrderSchema>;

interface CreateOrderFormProps {
  allowedBookingTypes: readonly BookingTypeT[];
  defaultCurrency: Currency;
  allowedCurrencies: readonly string[];
  /** Active provider catalog. Empty array renders the selector with a
   *  "configure providers first" prompt. */
  providers: ProviderDTO[];
}

interface CreateOrderApiResponse {
  order: OrderDTO;
  checkoutUrl: string;
}

export function CreateOrderForm({
  allowedBookingTypes,
  defaultCurrency,
  allowedCurrencies,
  providers,
}: CreateOrderFormProps) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<CreateOrderFormValues, unknown, CreateOrderInput>({
    resolver: zodResolver(createOrderSchema),
    defaultValues: {
      bookingType: allowedBookingTypes[0] ?? BookingType.NEW_BOOKING,
      provider: providers[0]?.key ?? "",
      customer: { name: "", email: "", phone: "" },
      vehicle: { company: "", type: "", imageUrl: "" },
      trip: {
        pickupDate: "",
        dropoffDate: "",
        pickupLocation: "",
        dropoffLocation: "",
      },
      currency: defaultCurrency,
      charges: [{ name: "Rental cost", amount: 0, timing: PaymentTiming.PREPAID }],
      notes: "",
    },
    mode: "onTouched",
  });

  const chargeFields = useFieldArray({ control: form.control, name: "charges" });

  // Live breakdown for the summary box — recomputed from the same helper the
  // server uses, so what the agent sees here is exactly what gets charged.
  const watchedCharges = form.watch("charges");
  const watchedCurrency = form.watch("currency") ?? defaultCurrency;
  const chargeSummary = summarizeCharges(
    (watchedCharges ?? []).map((c) => ({
      name: c?.name ?? "",
      amount: typeof c?.amount === "number" ? c.amount : Number(c?.amount) || 0,
      timing: (c?.timing as PaymentTiming) ?? PaymentTiming.PREPAID,
    })),
  );

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: CreateOrderInput) {
    setServerError(null);
    try {
      const result = await api.post<CreateOrderApiResponse>(
        "/api/orders",
        values,
      );
      toast.success("Order created. Send the payment request next.");
      // Sequential workflow: step 2 is sending the request email.
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
            <CardTitle>Booking</CardTitle>
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
              name="trip.pickupDate"
              render={({ field, fieldState }) => (
                <FormItem>
                  <FormLabel>Pick-up date & time</FormLabel>
                  <FormControl>
                    <DateTimePicker
                      id="pickup-date"
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      disabled={isSubmitting}
                      placeholder="Select pick-up"
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
              name="trip.dropoffDate"
              render={({ field, fieldState }) => {
                const pickup = form.watch("trip.pickupDate");
                const min = pickup ? new Date(pickup) : new Date();
                return (
                  <FormItem>
                    <FormLabel>Drop-off date & time</FormLabel>
                    <FormControl>
                      <DateTimePicker
                        id="dropoff-date"
                        value={field.value ?? ""}
                        onChange={field.onChange}
                        disabled={isSubmitting}
                        placeholder="Select drop-off"
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
              name="trip.pickupLocation"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Pick-up location</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. LAX Airport — Terminal 1"
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
              name="trip.dropoffLocation"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Drop-off location</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. San Diego Downtown"
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
            <CardTitle>Rental provider & vehicle</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="provider"
              render={({ field, fieldState }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Rental provider</FormLabel>
                  <FormControl>
                    <ProviderSelector
                      id="order-provider"
                      providers={providers}
                      value={field.value ?? null}
                      onChange={field.onChange}
                      disabled={isSubmitting || providers.length === 0}
                      invalid={!!fieldState.error}
                      placeholder={
                        providers.length === 0
                          ? "Configure a provider in Admin → Providers"
                          : "Select a rental provider"
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

            {/* Car library picker — populates make + model + imageUrl in
                one shot. The make/model inputs below remain editable so
                the agent can tweak after picking or skip the library
                entirely and type manually. */}
            <FormField
              control={form.control}
              name="vehicle.imageUrl"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Car library</FormLabel>
                  <FormControl>
                    <CarLinkSelector
                      id="order-car-link"
                      value={field.value ?? null}
                      initialMake={form.watch("vehicle.company")}
                      initialType={form.watch("vehicle.type")}
                      disabled={isSubmitting}
                      onSelect={(selection: CarLinkSelection) => {
                        form.setValue("vehicle.company", selection.carMake, {
                          shouldDirty: true,
                          shouldValidate: true,
                        });
                        form.setValue("vehicle.type", selection.carType, {
                          shouldDirty: true,
                          shouldValidate: true,
                        });
                        form.setValue("vehicle.imageUrl", selection.imageUrl, {
                          shouldDirty: true,
                          shouldValidate: true,
                        });
                      }}
                    />
                  </FormControl>
                  <FormDescription>
                    Pick a saved vehicle from the library to pre-fill make,
                    model, and the photo shown to the customer. Edits to
                    the inputs below override the library values.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="vehicle.company"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Car make</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Toyota"
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
              name="vehicle.type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Car model</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Corolla SE"
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Image preview — only renders when the form holds a URL.
                Probes the image off-DOM so a broken URL surfaces as a
                "404" pill instead of a broken-image icon in the form. */}
            {form.watch("vehicle.imageUrl") ? (
              <div className="sm:col-span-2">
                <ImageUrlPreview
                  url={form.watch("vehicle.imageUrl")}
                  size={72}
                  label={{
                    ok: "Image looks good — this is what the customer sees in the email and on checkout.",
                  }}
                />
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Charge details</CardTitle>
            <CardDescription>
              Prepaid charges are collected online via the payment link.
              Due-at-counter charges are shown to the customer for transparency
              but are collected by the rental counter at pick-up.
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
                  className="grid gap-3 sm:grid-cols-[1fr_140px_170px_auto] sm:items-end"
                >
                  <FormField
                    control={form.control}
                    name={`charges.${index}.name`}
                    render={({ field }) => (
                      <FormItem>
                        {index === 0 ? <FormLabel>Charge name</FormLabel> : null}
                        <FormControl>
                          <Input
                            placeholder="e.g. Rental cost"
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

                  <FormField
                    control={form.control}
                    name={`charges.${index}.timing`}
                    render={({ field }) => (
                      <FormItem>
                        {index === 0 ? <FormLabel>Payment timing</FormLabel> : null}
                        <Select
                          value={field.value ?? PaymentTiming.PREPAID}
                          onValueChange={field.onChange}
                          disabled={isSubmitting}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Timing" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {PAYMENT_TIMINGS.map((t) => (
                              <SelectItem key={t} value={t}>
                                {PaymentTimingLabel[t]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => chargeFields.remove(index)}
                    disabled={isSubmitting || chargeFields.fields.length <= 1}
                    aria-label="Remove charge"
                  >
                    Remove
                  </Button>
                </div>
              ))}

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  chargeFields.append({
                    name: "",
                    amount: 0,
                    timing: PaymentTiming.PREPAID,
                  })
                }
                disabled={isSubmitting}
              >
                + Add charge
              </Button>
            </div>

            {/* Live breakdown — uses the same helper the server uses, so the
                agent sees exactly what will be charged online. */}
            <div className="space-y-1.5 rounded-md border bg-muted/30 p-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  Amount paid online (today)
                </span>
                <span className="font-medium tabular-nums">
                  {formatCurrency(chargeSummary.prepaid, watchedCurrency)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Amount due at counter</span>
                <span className="font-medium tabular-nums">
                  {formatCurrency(chargeSummary.dueAtCounter, watchedCurrency)}
                </span>
              </div>
              <div className="flex items-center justify-between border-t pt-1.5">
                <span className="font-medium">Total rental cost</span>
                <span className="font-semibold tabular-nums">
                  {formatCurrency(chargeSummary.total, watchedCurrency)}
                </span>
              </div>
              <p className="pt-1 text-xs text-muted-foreground">
                The payment link charges only the {" "}
                <strong>{formatCurrency(chargeSummary.prepaid, watchedCurrency)}</strong>{" "}
                prepaid amount.
              </p>
            </div>

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
      </form>
    </Form>
  );
}
