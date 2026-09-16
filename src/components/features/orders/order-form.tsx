"use client";

import * as React from "react";
import { useFieldArray, useForm, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { LockIcon } from "lucide-react";

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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BookingTypeLabel,
  PaymentTimingLabel,
} from "@/lib/constants/labels";
import {
  type BookingType as BookingTypeT,
  type Currency,
  PAYMENT_TIMINGS,
  PaymentTiming,
  RecordState,
} from "@/lib/constants/enums";
import { createOrderSchema, type CreateOrderInput } from "@/lib/validation";
import { defaultTimingForIndex, summarizeCharges } from "@/lib/charges";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { OrderDTO, ProviderDTO } from "@/types";
import { ProviderLogo, ProviderSelector } from "@/components/features/providers";
import {
  CarLinkSelector,
  type CarLinkSelection,
} from "@/components/features/car-links";
import { ImageUrlPreview } from "@/components/common/image-url-preview";

import type { OrderFormValues } from "./order-form-model";

export type OrderFormApi = UseFormReturn<
  OrderFormValues,
  unknown,
  CreateOrderInput
>;

/**
 * The form's state, owned by the caller so create and edit can each decide
 * what a submit does.
 *
 * One schema for both modes. The zod schema has a `.transform()` on the
 * vehicle photo, so its input and output types differ; RHF takes the INPUT
 * shape for field state and the OUTPUT shape for what `handleSubmit` hands
 * back. Edit mode validates the same complete shape create does — every
 * field is present on a saved order — and only the request it sends is
 * partial.
 */
export function useOrderForm(defaultValues: OrderFormValues): OrderFormApi {
  return useForm<OrderFormValues, unknown, CreateOrderInput>({
    resolver: zodResolver(createOrderSchema),
    defaultValues,
    mode: "onTouched",
    // The form moves focus itself after a failed submit (see OrderForm),
    // in reading order. RHF's own attempt runs on a timer, lands on the
    // first field it holds a ref for — skipping the date and provider
    // pickers — and would override the correct target.
    shouldFocusError: false,
  });
}

interface OrderFormBaseProps {
  form: OrderFormApi;
  /** Active provider catalog. Empty renders a "configure providers" prompt. */
  providers: ProviderDTO[];
  serverError: string | null;
  serverErrorTitle: string;
  onSubmit: (values: CreateOrderInput) => Promise<void>;
  onCancel: () => void;
  submitLabel: string;
  submittingLabel: string;
  /** Disables submit without the loading state (nothing to save, already saved). */
  submitDisabled?: boolean;
  /** Keeps the form locked after a successful submit, while navigation runs. */
  locked?: boolean;
  /** Rendered between the last card and the actions. */
  beforeActions?: React.ReactNode;
}

interface CreateModeProps extends OrderFormBaseProps {
  mode: "create";
  allowedBookingTypes: readonly BookingTypeT[];
  defaultCurrency: Currency;
  allowedCurrencies: readonly string[];
}

interface EditModeProps extends OrderFormBaseProps {
  mode: "edit";
  /** The order being amended. Supplies the values edit mode shows read-only. */
  order: OrderDTO;
  /**
   * True once the order is paid. The money — the charge breakdown — and the
   * provider branding on the customer's receipt are then settled; everything
   * descriptive stays editable, because the archetypal change ("bring my
   * return date forward") happens mid-rental.
   */
  settled: boolean;
}

export type OrderFormProps = CreateModeProps | EditModeProps;

/**
 * The order form, shared by Create Order and Edit Order.
 *
 * Edit mode is the same cards, the same selectors and the same validation.
 * It differs in exactly three ways:
 *   - fields the change flow cannot carry (booking type, currency, internal
 *     notes) render as read-only values rather than controls;
 *   - a paid order shows its provider and charges read-only;
 *   - the caller supplies what submit does — edit never creates an order.
 *
 * Read-only values are rendered from the saved order, NOT as disabled
 * controls. A disabled Select or provider picker resolves its label from the
 * live catalog, so a booking type or provider retired since the order was
 * written would display its placeholder — showing the operator something
 * false about the booking. A disabled control also drops out of the tab
 * order, taking its explanation with it.
 */
export function OrderForm(props: OrderFormProps) {
  const {
    form,
    providers,
    serverError,
    serverErrorTitle,
    onSubmit,
    onCancel,
    submitLabel,
    submittingLabel,
    submitDisabled,
    locked,
  } = props;
  const isEdit = props.mode === "edit";
  const order = isEdit ? props.order : null;
  const settled = isEdit ? props.settled : false;

  const chargeFields = useFieldArray({ control: form.control, name: "charges" });

  const currency: string = order
    ? order.pricing.currency
    : (form.watch("currency") ?? (props.mode === "create" ? props.defaultCurrency : ""));

  // Live breakdown — the same helper the server uses, so what the operator
  // sees here is exactly what gets charged.
  const watchedCharges = form.watch("charges");
  const chargeSummary = summarizeCharges(
    (watchedCharges ?? []).map((c) => ({
      name: c?.name ?? "",
      amount: typeof c?.amount === "number" ? c.amount : Number(c?.amount) || 0,
      timing: (c?.timing as PaymentTiming) ?? PaymentTiming.PREPAID,
    })),
  );

  // Which car the current photo belongs to. The library picker writes make,
  // model and photo together, but the make/model inputs stay editable, and
  // typing a different car used to keep the previous car's photo — the
  // customer was shown one vehicle with another vehicle's name beside it.
  const [photoSource, setPhotoSource] = React.useState(() => {
    const v = form.getValues("vehicle");
    return v?.imageUrl
      ? { make: v.company ?? "", type: v.type ?? "", imageUrl: v.imageUrl }
      : null;
  });
  const watchedVehicle = form.watch("vehicle");
  const norm = (x: unknown) => String(x ?? "").trim().toLowerCase();
  const photoMismatch = Boolean(
    photoSource &&
      watchedVehicle?.imageUrl &&
      watchedVehicle.imageUrl === photoSource.imageUrl &&
      (norm(watchedVehicle.company) !== norm(photoSource.make) ||
        norm(watchedVehicle.type) !== norm(photoSource.type)),
  );

  // On a paid order the breakdown is settled: show what was SAVED, not an
  // amount the operator had typed before the payment landed (which the page
  // used to present as the settled figure).
  const shownSummary =
    settled && order
      ? summarizeCharges(order.charges, order.pricing.amount)
      : chargeSummary;

  // A rule on the charge list as a whole ("at least one prepaid line",
  // "prepaid total at least 0.50") has no single field to attach to, and was
  // never rendered: Save appeared to do nothing and focus fell to the page.
  const chargesErrors = form.formState.errors.charges as
    | { message?: string; root?: { message?: string } }
    | undefined;
  const chargesError =
    chargesErrors?.root?.message ?? chargesErrors?.message ?? null;

  const isSubmitting = form.formState.isSubmitting;
  const busy = isSubmitting || Boolean(locked);

  // Move focus to the first invalid control when a submit fails validation.
  //
  // RHF tries to do this itself, but it does so while `isSubmitting` is still
  // true — and every control here is disabled during submission, and a
  // disabled element cannot take focus. So focus stayed on the submit button
  // and a keyboard or screen-reader user was never taken to the error.
  //
  // The failed submit only records a request; the effect acts on it once the
  // submission has finished and the controls are enabled again. It focuses
  // the first invalid control in reading order, which also covers the date
  // and provider pickers RHF holds no ref for.
  const formRef = React.useRef<HTMLFormElement>(null);
  const [focusRequest, setFocusRequest] = React.useState(0);
  const handledFocusRequest = React.useRef(0);
  React.useEffect(() => {
    if (isSubmitting || focusRequest === handledFocusRequest.current) return;
    handledFocusRequest.current = focusRequest;
    formRef.current
      ?.querySelector<HTMLElement>(
        '[aria-invalid="true"]:not([disabled]), [data-form-error]',
      )
      ?.focus();
  }, [focusRequest, isSubmitting]);

  // Edit mode must still be able to show the order's CURRENT provider when it
  // has since been disabled: the picker resolves its label from this list and
  // would otherwise show the empty placeholder. Resubmitting the same key is
  // a no-op server-side, so listing it cannot re-pin a retired brand.
  const selectableProviders = React.useMemo(() => {
    if (!order || providers.some((p) => p.key === order.provider.id)) {
      return providers;
    }
    const current: ProviderDTO = {
      id: `current-${order.provider.id}`,
      key: order.provider.id,
      name: order.provider.name,
      logo: order.provider.logo,
      primaryColor: order.provider.primaryColor ?? "",
      onPrimaryColor: order.provider.onPrimaryColor ?? "",
      tagline: "Current provider (no longer offered for new orders)",
      status: RecordState.DISABLED,
      sortOrder: -1,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
    return [current, ...providers];
  }, [order, providers]);

  return (
    <Form {...form}>
      <form
        ref={formRef}
        className="space-y-6"
        onSubmit={form.handleSubmit(onSubmit, () =>
          setFocusRequest((n) => n + 1),
        )}
        noValidate
        aria-busy={busy || undefined}
      >
        {serverError ? (
          <Alert variant="destructive">
            <AlertTitle>{serverErrorTitle}</AlertTitle>
            <AlertDescription>{serverError}</AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Booking</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {props.mode === "create" ? (
              <FormField
                control={form.control}
                name="bookingType"
                render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>Booking type</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={busy}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select booking type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {props.allowedBookingTypes.map((t) => (
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
            ) : (
              <ReadOnlyField
                className="sm:col-span-2"
                label="Booking type"
                value={BookingTypeLabel[props.order.bookingType]}
                hint="Set when the order was created."
              />
            )}

            <FormField
              control={form.control}
              name="trip.pickupDate"
              render={({ field, fieldState }) => (
                <FormItem>
                  <FormLabel>Pick-up date & time</FormLabel>
                  <FormControl>
                    <DateTimePicker
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      disabled={busy}
                      placeholder="Select pick-up"
                      ariaInvalid={!!fieldState.error}
                      // A new booking cannot start in the past. A change to an
                      // existing one may well be correcting a pick-up that has
                      // already happened, so edit mode sets no floor.
                      minDate={
                        isEdit
                          ? undefined
                          : new Date(new Date().setHours(0, 0, 0, 0))
                      }
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
                        value={field.value ?? ""}
                        onChange={field.onChange}
                        disabled={busy}
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
                      disabled={busy}
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
                      disabled={busy}
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
                      disabled={busy}
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
                      disabled={busy}
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
                      disabled={busy}
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
            {order && settled ? (
              <SettledProvider order={order} />
            ) : (
              <FormField
                control={form.control}
                name="provider"
                render={({ field, fieldState }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>Rental provider</FormLabel>
                    <FormControl>
                      <ProviderSelector
                        providers={selectableProviders}
                        value={field.value ?? null}
                        onChange={field.onChange}
                        disabled={busy || selectableProviders.length === 0}
                        invalid={!!fieldState.error}
                        placeholder={
                          selectableProviders.length === 0
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
            )}

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
                      value={field.value ?? null}
                      initialMake={form.watch("vehicle.company")}
                      initialType={form.watch("vehicle.type")}
                      disabled={busy}
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
                        setPhotoSource({
                          make: selection.carMake,
                          type: selection.carType,
                          imageUrl: selection.imageUrl,
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
                      disabled={busy}
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
                      disabled={busy}
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
              <div className="space-y-2 sm:col-span-2">
                <ImageUrlPreview
                  url={form.watch("vehicle.imageUrl")}
                  size={72}
                  label={{
                    ok: photoMismatch
                      ? "This photo does not match the car entered above."
                      : "Image looks good — this is what the customer sees in the email and on checkout.",
                  }}
                />
                {photoMismatch && photoSource ? (
                  <div
                    role="status"
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900"
                  >
                    <span>
                      The photo is of the {photoSource.make} {photoSource.type}{" "}
                      from the car library. Pick the right car from the
                      library, or remove the photo so the customer is not
                      shown the wrong vehicle.
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        form.setValue("vehicle.imageUrl", "", {
                          shouldDirty: true,
                          shouldValidate: true,
                        });
                        setPhotoSource(null);
                      }}
                    >
                      Remove photo
                    </Button>
                  </div>
                ) : null}
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
            {props.mode === "create" ? (
              <FormField
                control={form.control}
                name="currency"
                render={({ field }) => (
                  <FormItem className="max-w-[200px]">
                    <FormLabel>Currency</FormLabel>
                    <Select
                      value={field.value ?? props.defaultCurrency}
                      onValueChange={field.onChange}
                      disabled={busy}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Currency" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {props.allowedCurrencies.map((c) => (
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
            ) : (
              <ReadOnlyField
                className="max-w-[280px]"
                label="Currency"
                value={props.order.pricing.currency}
                hint="Fixed at creation — a payment link is issued in this currency."
              />
            )}

            {settled ? (
              <SettledCharges
                lines={shownSummary.charges}
                currency={currency}
              />
            ) : (
              <div className="space-y-3">
                {chargeFields.fields.map((row, index) => (
                  <div
                    key={row.id}
                    // Four columns only once there is room for them. From
                    // `sm` the fixed amount/timing columns left the charge
                    // name a few characters wide beside the sidebar at
                    // tablet widths; in between, the name takes its own row.
                    className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_140px_170px_auto] lg:items-end"
                  >
                    {/* Only the first row shows its labels visually — the
                        rows beneath read as a table. Later rows keep a
                        screen-reader label so every field is still named,
                        which matters most in edit mode, where a multi-line
                        breakdown is on screen from the moment it loads. */}
                    <FormField
                      control={form.control}
                      name={`charges.${index}.name`}
                      render={({ field }) => (
                        <FormItem className="sm:col-span-2 lg:col-span-1">
                          <FormLabel className={cn(index > 0 && "sr-only")}>
                            {index === 0 ? "Charge name" : `Charge ${index + 1} name`}
                          </FormLabel>
                          <FormControl>
                            <Input
                              placeholder="e.g. Rental cost"
                              disabled={busy}
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
                          <FormLabel className={cn(index > 0 && "sr-only")}>
                            {index === 0 ? "Amount" : `Charge ${index + 1} amount`}
                          </FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              min={0}
                              step="0.01"
                              inputMode="decimal"
                              placeholder="0.00"
                              disabled={busy}
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
                          <FormLabel className={cn(index > 0 && "sr-only")}>
                            {index === 0
                              ? "Payment timing"
                              : `Charge ${index + 1} payment timing`}
                          </FormLabel>
                          <Select
                            value={field.value ?? PaymentTiming.PREPAID}
                            onValueChange={field.onChange}
                            disabled={busy}
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
                      className="sm:col-span-2 sm:justify-self-end lg:col-span-1 lg:justify-self-auto"
                      onClick={() => chargeFields.remove(index)}
                      disabled={busy || chargeFields.fields.length <= 1}
                      aria-label={`Remove charge ${index + 1}`}
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
                      // Position decides the default, matching what the server
                      // resolves for an omitted timing. The operator can change
                      // it on the row; this only sets where the row starts.
                      timing: defaultTimingForIndex(chargeFields.fields.length),
                    })
                  }
                  disabled={busy}
                >
                  + Add charge
                </Button>
                {chargesError ? (
                  <p
                    role="alert"
                    tabIndex={-1}
                    data-form-error
                    className="text-xs font-medium text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    {chargesError}
                  </p>
                ) : null}
              </div>
            )}

            {/* Live breakdown — uses the same helper the server uses, so the
                agent sees exactly what will be charged online. */}
            <div className="space-y-1.5 rounded-md border bg-muted/30 p-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  Amount paid online (today)
                </span>
                <span className="font-medium tabular-nums">
                  {formatCurrency(shownSummary.prepaid, currency)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Amount due at counter</span>
                <span className="font-medium tabular-nums">
                  {formatCurrency(shownSummary.dueAtCounter, currency)}
                </span>
              </div>
              <div className="flex items-center justify-between border-t pt-1.5">
                <span className="font-medium">Total rental cost</span>
                <span className="font-semibold tabular-nums">
                  {formatCurrency(shownSummary.total, currency)}
                </span>
              </div>
              <p className="pt-1 text-xs text-muted-foreground">
                The payment link charges only the {" "}
                <strong>{formatCurrency(shownSummary.prepaid, currency)}</strong>{" "}
                prepaid amount.
              </p>
            </div>

            {props.mode === "create" ? (
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
                        disabled={busy}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : props.order.notes ? (
              <ReadOnlyField
                label="Internal notes"
                value={props.order.notes}
                hint="Recorded at creation. Use the change note below for this edit."
                multiline
              />
            ) : null}
          </CardContent>
        </Card>

        {props.beforeActions ?? null}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </Button>
          <LoadingButton
            type="submit"
            loading={isSubmitting}
            loadingText={submittingLabel}
            disabled={Boolean(submitDisabled) || Boolean(locked)}
            // Keep the focused field from blurring on press. Validation runs
            // on blur, and the error message it inserts pushes this button
            // down between mousedown and mouseup — so the release lands off
            // the button and the click is lost: pressing Save from an
            // invalid field did nothing at all. Submit still validates
            // everything and moves focus to the first problem. Keyboard
            // activation is unaffected.
            onMouseDown={(event) => event.preventDefault()}
          >
            {submitLabel}
          </LoadingButton>
        </div>
      </form>
    </Form>
  );
}

/**
 * A value this form shows but cannot change.
 *
 * A read-only input rather than plain text: it keeps a real label, stays in
 * the tab order, and is announced as read-only — so a keyboard or
 * screen-reader user learns both the value and that it is fixed, along with
 * the reason in `hint`.
 */
function ReadOnlyField({
  label,
  value,
  hint,
  className,
  multiline,
}: {
  label: string;
  value: string;
  hint?: string;
  className?: string;
  multiline?: boolean;
}) {
  const id = React.useId();
  const hintId = `${id}-hint`;
  const shared = cn(
    "cursor-default bg-muted/50 text-foreground/80",
    "focus-visible:border-foreground/25",
  );
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id} className="flex items-center gap-1.5">
        {label}
        <LockIcon aria-hidden className="size-3 text-muted-foreground" />
      </Label>
      {multiline ? (
        <Textarea
          id={id}
          readOnly
          value={value}
          rows={2}
          aria-describedby={hint ? hintId : undefined}
          className={shared}
        />
      ) : (
        <Input
          id={id}
          readOnly
          value={value}
          aria-describedby={hint ? hintId : undefined}
          className={shared}
        />
      )}
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** The provider on a paid order: shown with its brand mark, not editable. */
function SettledProvider({ order }: { order: OrderDTO }) {
  const labelId = React.useId();
  const hintId = `${labelId}-hint`;
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={hintId}
      className="space-y-1.5 sm:col-span-2"
    >
      <p
        id={labelId}
        className="flex items-center gap-1.5 text-[12.5px] font-medium leading-none tracking-tight"
      >
        Rental provider
        <LockIcon aria-hidden className="size-3 text-muted-foreground" />
      </p>
      <div className="flex h-12 items-center gap-3 rounded-md border border-input bg-muted/50 px-3">
        <ProviderLogo provider={order.provider} size="md" framed />
        <span className="truncate text-[14px] font-medium">
          {order.provider.name}
        </span>
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        This order is paid. The provider on the customer&apos;s receipt is
        settled and can no longer be changed.
      </p>
    </div>
  );
}

/** The charge breakdown on a paid order: listed, not editable. */
function SettledCharges({
  lines,
  currency,
}: {
  lines: Array<{ name: string; amount: number; timing: PaymentTiming }>;
  currency: string;
}) {
  return (
    <div className="space-y-2">
      <table className="w-full text-sm">
        <caption className="sr-only">Charge breakdown (settled)</caption>
        <thead>
          <tr className="text-left text-[12.5px] text-muted-foreground">
            <th scope="col" className="pb-1.5 font-medium">Charge</th>
            <th scope="col" className="pb-1.5 font-medium">Timing</th>
            <th scope="col" className="pb-1.5 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={`${l.name}-${i}`} className="border-t border-border/60">
              <td className="py-1.5 pr-3">{l.name}</td>
              <td className="py-1.5 pr-3 text-muted-foreground">
                {PaymentTimingLabel[l.timing]}
              </td>
              <td className="py-1.5 text-right tabular-nums">
                {formatCurrency(l.amount, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <LockIcon aria-hidden className="size-3" />
        This order is paid. The charges are settled and can no longer be
        changed; other details remain editable.
      </p>
    </div>
  );
}
