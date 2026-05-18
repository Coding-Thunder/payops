"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CheckIcon, CloudOffIcon, Loader2Icon, TrashIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { DateTimePicker } from "@/components/common/date-time-picker";
import { FormSkeleton, PageHeaderSkeleton } from "@/components/common/skeletons";
import { ImageUrlPreview } from "@/components/common/image-url-preview";
import { PageHeader } from "@/components/common/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { ProviderSelector } from "@/components/features/providers";
import {
  CarLinkSelector,
  type CarLinkSelection,
} from "@/components/features/car-links";
import { api, ApiClientError } from "@/lib/api-client";
import { BookingTypeLabel } from "@/lib/constants/labels";
import {
  BookingType,
  type BookingType as BookingTypeT,
  type Currency,
} from "@/lib/constants/enums";
import { cn } from "@/lib/utils";
import {
  createOrderSchema,
  type CreateOrderInput,
} from "@/lib/validation";
import type {
  OrderDTO,
  OrderDraftDTO,
  ProviderDTO,
} from "@/types";

import { useAutosave } from "../hooks/use-autosave";
import { useWorkspaceStore } from "../store";
import { WorkspaceTabType } from "../types";

interface CreateOrderTabContentProps {
  tabId: string;
  /** Present iff this tab is editing an existing draft. */
  draftId?: string;
}

interface CreateConfigDTO {
  allowedBookingTypes: readonly BookingTypeT[];
  defaultCurrency: Currency;
  allowedCurrencies: readonly string[];
  providers: ProviderDTO[];
}

interface CreateOrderApiResponse {
  order: OrderDTO;
  checkoutUrl: string;
}

export function CreateOrderTabContent({
  tabId,
  draftId: initialDraftId,
}: CreateOrderTabContentProps) {
  const router = useRouter();
  const updateTabMeta = useWorkspaceStore((s) => s.updateTabMeta);
  const setDirty = useWorkspaceStore((s) => s.setDirty);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const openTab = useWorkspaceStore((s) => s.openTab);

  // The draft id can change DURING the tab lifetime — when a brand-new
  // CREATE_ORDER tab autosaves for the first time, the API mints an id.
  const [draftId, setDraftId] = React.useState<string | null>(
    initialDraftId ?? null,
  );
  const [revision, setRevision] = React.useState<number>(0);
  const [discardOpen, setDiscardOpen] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  const configQuery = useQuery({
    queryKey: ["workspace", "createOrderConfig"],
    queryFn: () => api.get<CreateConfigDTO>("/api/orders/create-config"),
    staleTime: 5 * 60 * 1000,
  });

  // Load existing draft data if we opened with a draftId.
  const draftQuery = useQuery({
    queryKey: ["workspace", "orderDraft", initialDraftId],
    queryFn: () =>
      api.get<OrderDraftDTO>(`/api/drafts/${initialDraftId}`),
    enabled: Boolean(initialDraftId),
    staleTime: Infinity,
  });

  const config = configQuery.data;
  const initialDraft = draftQuery.data;

  // Form is only mounted once we have config + (optional) draft. This way
  // defaultValues are stable for the lifetime of the form instance.
  if (configQuery.isLoading || (initialDraftId && draftQuery.isLoading)) {
    return (
      <div className="space-y-6">
        <PageHeaderSkeleton titleWidth="9rem" />
        <FormSkeleton sections={4} rows={2} />
      </div>
    );
  }

  if (configQuery.error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load form configuration</AlertTitle>
        <AlertDescription>
          {(configQuery.error as Error).message}
        </AlertDescription>
      </Alert>
    );
  }

  if (!config) return null;

  return (
    <CreateOrderTabInner
      tabId={tabId}
      config={config}
      initialDraft={initialDraft ?? null}
      draftId={draftId}
      setDraftId={setDraftId}
      revision={revision}
      setRevision={setRevision}
      discardOpen={discardOpen}
      setDiscardOpen={setDiscardOpen}
      serverError={serverError}
      setServerError={setServerError}
      onSubmitSuccess={(order) => {
        // After successful submit: open the new order's details tab,
        // close this create/draft tab, navigate.
        const tab = openTab({
          type: WorkspaceTabType.ORDER_DETAILS,
          payload: {
            orderId: order.id,
            orderNumber: order.orderNumber,
            customerName: order.customer.name,
          },
        });
        closeTab(tabId, { force: true });
        // Drop the agent straight into the payment-request composer.
        // Order details remain one click away (the page links back).
        router.push(`/orders/${order.id}/compose`);
        // Mark new tab active (openTab already does this, kept explicit).
        useWorkspaceStore.getState().switchTab(tab);
      }}
      updateTabMeta={updateTabMeta}
      setDirty={setDirty}
    />
  );
}

interface InnerProps {
  tabId: string;
  config: CreateConfigDTO;
  initialDraft: OrderDraftDTO | null;
  draftId: string | null;
  setDraftId: (id: string | null) => void;
  revision: number;
  setRevision: (n: number) => void;
  discardOpen: boolean;
  setDiscardOpen: (open: boolean) => void;
  serverError: string | null;
  setServerError: (s: string | null) => void;
  onSubmitSuccess: (order: OrderDTO) => void;
  updateTabMeta: ReturnType<typeof useWorkspaceStore.getState>["updateTabMeta"];
  setDirty: ReturnType<typeof useWorkspaceStore.getState>["setDirty"];
}

function CreateOrderTabInner({
  tabId,
  config,
  initialDraft,
  draftId,
  setDraftId,
  revision,
  setRevision,
  discardOpen,
  setDiscardOpen,
  serverError,
  setServerError,
  onSubmitSuccess,
  updateTabMeta,
  setDirty,
}: InnerProps) {
  // Defaults: from draft if present, else config defaults.
  const defaults = React.useMemo<CreateOrderInput>(() => {
    const fromDraft = (initialDraft?.data ?? {}) as Partial<CreateOrderInput>;
    return {
      bookingType:
        (fromDraft.bookingType as BookingTypeT) ??
        config.allowedBookingTypes[0] ??
        BookingType.NEW_BOOKING,
      provider:
        (fromDraft.provider as string) ?? config.providers[0]?.key ?? "",
      customer: {
        name: fromDraft.customer?.name ?? "",
        email: fromDraft.customer?.email ?? "",
        phone: fromDraft.customer?.phone ?? "",
      },
      vehicle: {
        company: fromDraft.vehicle?.company ?? "",
        type: fromDraft.vehicle?.type ?? "",
        imageUrl: fromDraft.vehicle?.imageUrl ?? "",
      },
      trip: {
        pickupDate: fromDraft.trip?.pickupDate ?? "",
        dropoffDate: fromDraft.trip?.dropoffDate ?? "",
      },
      pricing: {
        amount:
          typeof fromDraft.pricing?.amount === "number"
            ? fromDraft.pricing.amount
            : 0,
        currency:
          (fromDraft.pricing?.currency as Currency) ?? config.defaultCurrency,
      },
      notes: fromDraft.notes ?? "",
    };
  }, [config, initialDraft]);

  const form = useForm<CreateOrderInput>({
    resolver: zodResolver(createOrderSchema),
    defaultValues: defaults,
    mode: "onTouched",
  });

  React.useEffect(() => {
    if (initialDraft) setRevision(initialDraft.revision);
  }, [initialDraft, setRevision]);

  // Subscribe to all values so autosave snapshots the latest form state.
  const liveValues = form.watch();
  const isSubmitting = form.formState.isSubmitting;
  const isDirty = form.formState.isDirty;

  // Reflect dirty state into the tab strip so users see the "● unsaved" dot.
  React.useEffect(() => {
    setDirty(tabId, isDirty);
  }, [isDirty, tabId, setDirty]);

  // Update tab label as the customer name appears.
  React.useEffect(() => {
    if (initialDraft || draftId) {
      const summary =
        liveValues.customer?.name?.trim() ||
        initialDraft?.summary.customerName ||
        "Draft order";
      updateTabMeta(tabId, {
        label: summary,
        subtitle: liveValues.customer?.email
          ? `${summary} · ${liveValues.customer.email}`
          : undefined,
      });
    }
  }, [
    liveValues.customer?.name,
    liveValues.customer?.email,
    initialDraft,
    draftId,
    tabId,
    updateTabMeta,
  ]);

  // ---- autosave ---------------------------------------------------------
  const autosave = useAutosave({
    value: liveValues,
    debounceMs: 1200,
    enabled: isDirty && !isSubmitting,
    save: async (snapshot) => {
      if (!draftId) {
        // First save → mint a draft id.
        const created = await api.post<OrderDraftDTO>("/api/drafts", {
          data: snapshot,
        });
        setDraftId(created.id);
        setRevision(created.revision);
        return;
      }
      const updated = await api.put<OrderDraftDTO>(`/api/drafts/${draftId}`, {
        data: snapshot,
        expectedRevision: revision,
      });
      setRevision(updated.revision);
    },
  });

  // ---- submit -----------------------------------------------------------
  async function onSubmit(values: CreateOrderInput) {
    setServerError(null);
    // Flush any pending autosave so we don't race the create call.
    try {
      await autosave.flush();
    } catch {
      // Ignore — autosave errors don't block the user from submitting.
    }
    try {
      const result = await api.post<CreateOrderApiResponse>(
        "/api/orders",
        values,
      );
      // Best-effort: delete the draft now that the order exists.
      if (draftId) {
        api.del(`/api/drafts/${draftId}`).catch(() => undefined);
      }
      toast.success("Order created. Payment link is ready to share.");
      onSubmitSuccess(result.order);
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : "Something went wrong. Please try again.";
      setServerError(message);
      toast.error(message);
    }
  }

  // ---- discard ----------------------------------------------------------
  async function discardDraft() {
    if (draftId) {
      try {
        await api.del(`/api/drafts/${draftId}`);
      } catch {
        // Already gone is fine.
      }
    }
    form.reset(defaults);
    setDirty(tabId, false);
    setDiscardOpen(false);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={draftId ? "Continue draft" : "New order"}
        description="Capture booking details and generate a secure Stripe payment link to share with the customer."
        actions={<AutosaveBadge state={autosave} hasDraft={!!draftId} />}
      />

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
                        {config.allowedBookingTypes.map((t) => (
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
                        providers={config.providers}
                        value={field.value ?? null}
                        onChange={field.onChange}
                        disabled={isSubmitting || config.providers.length === 0}
                        invalid={!!fieldState.error}
                        placeholder={
                          config.providers.length === 0
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

              {/* Car listing comes first — picking it pre-fills make +
                  model. Make / model fields stay hidden until there's
                  something to fill so the agent isn't asked to type
                  data the library is about to supply. */}
              <FormField
                control={form.control}
                name="vehicle.imageUrl"
                render={({ field }) => {
                  const handlePick = (sel: CarLinkSelection) => {
                    field.onChange(sel.imageUrl);
                    // Overwrite make + type so the agent doesn't have to
                    // re-type after picking. The selector itself surfaces
                    // an "Add new" path when the library is missing the
                    // car they need.
                    form.setValue("vehicle.company", sel.carMake, {
                      shouldDirty: true,
                      shouldValidate: true,
                    });
                    form.setValue("vehicle.type", sel.carType, {
                      shouldDirty: true,
                      shouldValidate: true,
                    });
                  };
                  return (
                    <FormItem className="sm:col-span-2">
                      <FormLabel>Car listing</FormLabel>
                      <FormControl>
                        <CarLinkSelector
                          id="car-link"
                          value={field.value ?? null}
                          onSelect={handlePick}
                          // `form.watch` (not getValues) so the trigger
                          // label refreshes whenever the agent edits
                          // make/type directly after picking. getValues
                          // is a snapshot and would stay stale until the
                          // imageUrl field itself changed again.
                          initialMake={form.watch("vehicle.company")}
                          initialType={form.watch("vehicle.type")}
                          disabled={isSubmitting}
                        />
                      </FormControl>
                      <FormDescription>
                        Pick from the team library, or add a new entry inline.
                        Selecting fills the make, model, and public link.
                      </FormDescription>
                      <VehicleImagePreview url={field.value} />
                      <FormMessage />
                    </FormItem>
                  );
                }}
              />

              {/* Make + Model: rendered only once a car is selected so
                  Zod's "required" still triggers via the imageUrl field
                  and we don't show empty inputs the agent hasn't earned
                  yet. They're pre-filled but fully editable for the
                  rare "rename after picking" case. */}
              {(form.watch("vehicle.imageUrl") ?? "").trim().length > 0 ? (
                <>
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
                </>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Charge details</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-3">
              <FormField
                control={form.control}
                name="pricing.amount"
                render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>Amount</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        step="0.01"
                        inputMode="decimal"
                        placeholder="0.00"
                        disabled={isSubmitting}
                        {...field}
                        onChange={(e) =>
                          field.onChange(
                            e.target.value === ""
                              ? ""
                              : Number(e.target.value),
                          )
                        }
                      />
                    </FormControl>
                    <FormDescription>
                      Major units (e.g. 199.50). Stripe sees this in minor
                      units.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="pricing.currency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Currency</FormLabel>
                    <Select
                      value={field.value ?? config.defaultCurrency}
                      onValueChange={field.onChange}
                      disabled={isSubmitting}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Currency" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {config.allowedCurrencies.map((c) => (
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

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem className="sm:col-span-3">
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

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDiscardOpen(true)}
              disabled={!isDirty && !draftId}
            >
              <TrashIcon className="size-3.5" />
              Discard draft
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

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        tone="destructive"
        icon={<TrashIcon />}
        title="Discard this draft?"
        description="Unsaved form data and any autosaved draft will be removed. This can't be undone."
        confirmLabel="Discard draft"
        onConfirm={discardDraft}
      />
    </div>
  );
}

function AutosaveBadge({
  state,
  hasDraft,
}: {
  state: ReturnType<typeof useAutosave<unknown>>;
  hasDraft: boolean;
}) {
  if (!hasDraft && state.status === "idle") return null;
  const tone =
    state.status === "error"
      ? "text-destructive"
      : state.status === "saving" || state.status === "scheduled"
        ? "text-muted-foreground"
        : "text-success";
  const icon =
    state.status === "saving" || state.status === "scheduled" ? (
      <Spinner size="xs" tone="current" />
    ) : state.status === "error" ? (
      <CloudOffIcon className="size-3.5" />
    ) : state.status === "saved" ? (
      <CheckIcon className="size-3.5" />
    ) : (
      <Loader2Icon className="size-3.5" />
    );
  const label =
    state.status === "saving"
      ? "Saving draft…"
      : state.status === "scheduled"
        ? "Pending changes…"
        : state.status === "error"
          ? `Autosave failed${state.error ? ` — ${state.error}` : ""}`
          : state.status === "saved"
            ? `Draft saved${
                state.lastSavedAt
                  ? ` · ${new Date(state.lastSavedAt).toLocaleTimeString()}`
                  : ""
              }`
            : "Draft restored";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[11.5px] tabular-nums",
        tone,
      )}
      aria-live="polite"
    >
      {icon}
      <span>{label}</span>
    </span>
  );
}

/** Thin wrapper so existing call sites keep working with the shared
 *  ImageUrlPreview component. */
function VehicleImagePreview({ url }: { url: string | null | undefined }) {
  return <ImageUrlPreview url={url} size={64} />;
}
