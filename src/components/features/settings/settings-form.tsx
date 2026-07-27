"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronRightIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
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
import {
  CONSENT_MODES,
  CURRENCIES,
} from "@/lib/constants/enums";
import { ConsentModeLabel } from "@/lib/constants/labels";
import {
  updateSettingsSchema,
  type UpdateSettingsInput,
} from "@/lib/validation";

type SettingsFormValues = UpdateSettingsInput;

/** Which owner-only config pages the viewer may reach, so each cross-link
 *  is gated by that page's own permission (not a blanket owner check). */
export interface SettingsCrossLinks {
  emailTemplates?: boolean;
  emailPreviews?: boolean;
  workflow?: boolean;
  gateways?: boolean;
}

interface SettingsFormProps {
  initial: SettingsFormValues;
  canEdit: boolean;
  /** Current policy version (read-only; auto-bumped on save). */
  policyVersion: string;
  crossLinks?: SettingsCrossLinks;
}

function CrossLink({
  href,
  label,
  hint,
}: {
  href: string;
  label: string;
  hint: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-1 px-3 py-2 text-[13px] transition-colors hover:bg-surface-2"
    >
      <span className="min-w-0">
        <span className="font-medium text-foreground">{label}</span>{" "}
        <span className="text-muted-foreground">— {hint}</span>
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  );
}

export function SettingsForm({
  initial,
  canEdit,
  policyVersion,
  crossLinks = {},
}: SettingsFormProps) {
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
            title="Invoices"
            description="How order and invoice numbers and currency are generated."
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

            {(crossLinks.emailTemplates ||
              crossLinks.emailPreviews ||
              crossLinks.workflow) && (
              <div className="mt-4 space-y-2">
                {crossLinks.emailTemplates ? (
                  <CrossLink
                    href="/app/admin/email-templates"
                    label="Email templates"
                    hint="Edit the invoice, receipt & payment-request emails"
                  />
                ) : null}
                {crossLinks.emailPreviews ? (
                  <CrossLink
                    href="/app/admin/emails"
                    label="Email previews"
                    hint="See exactly what customers receive"
                  />
                ) : null}
                {crossLinks.workflow ? (
                  <CrossLink
                    href="/app/admin/workflow"
                    label="Order workflow"
                    hint="The statuses an order moves through"
                  />
                ) : null}
              </div>
            )}
          </Section>

          <Section
            title="Payments"
            description="Payment-link lifetime and the Stripe checkout redirects."
          >
            <div className="grid gap-4 sm:grid-cols-2">
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

            {crossLinks.gateways ? (
              <div className="mt-4">
                <CrossLink
                  href="/app/admin/gateways"
                  label="Payment gateway"
                  hint="Connect Stripe & manage the webhook"
                />
              </div>
            ) : null}
          </Section>

          <Section
            title="Consent"
            description="Pre-payment acknowledgement shown in emails and on the hosted consent page. Mode controls whether the block is advisory, recommended, or required."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="consentMode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Consent mode</FormLabel>
                    <Select
                      value={field.value ?? "ADVISORY"}
                      onValueChange={field.onChange}
                      disabled={!canEdit || isSubmitting}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {CONSENT_MODES.map((m) => (
                          <SelectItem key={m} value={m}>
                            {ConsentModeLabel[m]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      Advisory records consent but never blocks payment.
                      Required tightens the customer-facing copy, payment
                      itself remains driven by Stripe.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="consentMessage"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Acknowledgement statement</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={3}
                      placeholder="I confirm that I understand and agree to proceed with this payment."
                      disabled={!canEdit || isSubmitting}
                      {...field}
                      value={field.value ?? ""}
                    />
                  </FormControl>
                  <p className="text-[11.5px] text-muted-foreground">
                    Keep it short, calm, and free of legalese. 20–1,000
                    characters.
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
          </Section>

          <Section
            title="Policy"
            description="Cancellation & refund terms shown in every confirmation email and snapshotted onto each order at creation for dispute evidence. Saving a change auto-bumps the version; existing orders keep the version they were created under."
            action={
              <Badge variant="muted" className="font-mono">
                {policyVersion}
              </Badge>
            }
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
                      placeholder="One rule per line, paragraphs render with subtle spacing in the email."
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
            {isDirty ? "Unsaved changes" : "No pending changes"}
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
