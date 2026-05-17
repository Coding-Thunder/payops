"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { toast } from "@/components/ui/sonner";
import { api, ApiClientError } from "@/lib/api-client";
import {
  BOOKING_TYPES,
  CURRENCIES,
} from "@/lib/constants/enums";
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

  async function onSubmit(values: SettingsFormValues) {
    try {
      await api.patch("/api/admin/settings", values);
      toast.success("Settings updated");
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : "Could not save settings";
      toast.error(message);
    }
  }

  return (
    <Form {...form}>
      <form className="space-y-6" onSubmit={form.handleSubmit(onSubmit)}>
        <Card>
          <CardHeader>
            <CardTitle>Order generation</CardTitle>
            <CardDescription>
              Controls how new orders are created and how long their payment
              links remain valid.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
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
                    Stripe clamps to 23.5h max; longer values are stored for the
                    record.
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

            <FormField
              control={form.control}
              name="allowedBookingTypes"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Allowed booking types</FormLabel>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {BOOKING_TYPES.map((t) => {
                      const checked = field.value?.includes(t) ?? false;
                      return (
                        <label
                          key={t}
                          className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm cursor-pointer hover:bg-muted/40"
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
                          {BookingTypeLabel[t]}
                        </label>
                      );
                    })}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Customer-facing details</CardTitle>
            <CardDescription>
              Used in confirmation emails and redirect URLs after Stripe
              checkout.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="supportEmail"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Support email</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      disabled={!canEdit || isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="supportPhone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Support phone</FormLabel>
                  <FormControl>
                    <Input
                      type="tel"
                      disabled={!canEdit || isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="successRedirectUrl"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Success redirect URL</FormLabel>
                  <FormControl>
                    <Input
                      type="url"
                      disabled={!canEdit || isSubmitting}
                      {...field}
                    />
                  </FormControl>
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
                      disabled={!canEdit || isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" disabled={!canEdit || isSubmitting}>
            {isSubmitting ? (
              <LoaderIcon className="size-4 animate-spin" />
            ) : null}
            Save settings
          </Button>
        </div>
      </form>
    </Form>
  );
}
