"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { Section, SectionStack } from "@/components/common/section";
import { api, ApiClientError } from "@/lib/api-client";
import { BOOKING_TYPES, CURRENCIES } from "@/lib/constants/enums";
import { BookingTypeLabel } from "@/lib/constants/labels";
import {
  updateSettingsSchema,
  type UpdateSettingsInput,
} from "@/lib/validation";

type SettingsFormValues = UpdateSettingsInput;

interface SettingsFormProps {
  initial: SettingsFormValues;
  canEdit: boolean;
}

export function SettingsForm({ initial, canEdit }: SettingsFormProps) {
  const router = useRouter();
  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(updateSettingsSchema),
    defaultValues: initial,
    mode: "onTouched",
  });

  const isSubmitting = form.formState.isSubmitting;
  const isDirty = form.formState.isDirty;

  async function onSubmit(values: SettingsFormValues) {
    try {
      await api.patch("/api/admin/settings", values);
      toast.success("Settings updated");
      form.reset(values);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : "Could not save settings";
      toast.error(message);
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <SectionStack>
          <Section
            title="Order generation"
            description="Controls how new orders are created and how long their payment links remain valid."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="orderPrefix"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Order number prefix</FormLabel>
                    <FormControl>
                      <Input
                        maxLength={6}
                        disabled={!canEdit || isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>2–6 uppercase letters.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="paymentExpiryHours"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Payment link expiry (hours)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={720}
                        disabled={!canEdit || isSubmitting}
                        {...field}
                        onChange={(e) => field.onChange(Number(e.target.value))}
                      />
                    </FormControl>
                    <FormDescription>
                      Stripe clamps to 23.5h max.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="defaultCurrency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Default currency</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={field.onChange}
                      disabled={!canEdit || isSubmitting}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {CURRENCIES.map((c) => (
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
            </div>

            <FormField
              control={form.control}
              name="allowedBookingTypes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Allowed booking types</FormLabel>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {BOOKING_TYPES.map((t) => {
                      const checked = field.value?.includes(t) ?? false;
                      return (
                        <label
                          key={t}
                          className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-[13px] cursor-pointer transition-colors hover:bg-surface-1"
                        >
                          <Checkbox
                            checked={checked}
                            disabled={!canEdit || isSubmitting}
                            onCheckedChange={(c) => {
                              const next = new Set(field.value ?? []);
                              if (c) next.add(t);
                              else next.delete(t);
                              field.onChange(Array.from(next));
                            }}
                          />
                          <span>{BookingTypeLabel[t]}</span>
                        </label>
                      );
                    })}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          </Section>

          <Section
            title="Checkout redirects"
            description="Where Stripe sends the customer after they complete or abandon checkout. Both URLs are computed from the APP_URL deploy variable."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="successRedirectUrl"
                render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>Success redirect URL</FormLabel>
                    <FormControl>
                      <Input
                        type="url"
                        readOnly
                        disabled
                        aria-disabled="true"
                        className="font-mono text-[12.5px]"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Computed from the <code>APP_URL</code> environment
                      variable. Change the deploy config to update.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="cancelRedirectUrl"
                render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>Cancel redirect URL</FormLabel>
                    <FormControl>
                      <Input
                        type="url"
                        readOnly
                        disabled
                        aria-disabled="true"
                        className="font-mono text-[12.5px]"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Computed from the <code>APP_URL</code> environment
                      variable. Change the deploy config to update.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </Section>

          <Section
            title="Cancellation & refund policy"
            description="Shown in every confirmation email. Snapshotted onto each order at creation so disputes can attach the exact terms the customer paid against. Saving a change auto-bumps the policy version; existing orders keep pointing at the older version they were created under."
          >
            <FormField
              control={form.control}
              name="cancellationPolicy"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Policy text</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={8}
                      placeholder="One rule per line — paragraphs render with subtle spacing in the email."
                      disabled={!canEdit || isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <p className="text-[11.5px] text-muted-foreground">
                    20–4,000 characters. Use one statement per line.
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
          </Section>
        </SectionStack>

        <div className="mt-6 flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3">
          <p className="text-[12.5px] text-muted-foreground">
            {isDirty
              ? "Unsaved changes"
              : "No pending changes"}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => form.reset()}
              disabled={!isDirty || isSubmitting}
            >
              Discard
            </Button>
            <LoadingButton
              type="submit"
              size="sm"
              disabled={!canEdit}
              loading={isSubmitting}
              loadingText="Saving"
            >
              Save settings
            </LoadingButton>
          </div>
        </div>
      </form>
    </Form>
  );
}
