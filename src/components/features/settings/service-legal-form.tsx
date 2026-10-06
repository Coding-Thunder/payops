"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { Section } from "@/components/common/section";
import { api, ApiClientError } from "@/lib/api-client";
import { ServiceType } from "@/lib/constants/enums";
import {
  type ServiceWithOwnLegal,
  updateServiceLegalSchema,
  type UpdateServiceLegalInput,
} from "@/lib/validation";

/** How the editor names each service with a legal slot of its own. */
const SERVICE_COPY: Record<
  ServiceWithOwnLegal,
  { label: string; noun: string; writtenFor: string }
> = {
  [ServiceType.FLIGHT]: { label: "Flight", noun: "flight", writtenFor: "flights" },
  [ServiceType.HOTEL]: { label: "Hotel", noun: "hotel", writtenFor: "hotel stays" },
};

interface ServiceLegalFormProps {
  /** Which service's text this edits. Only rendered for a service the
   *  selected organization sells. */
  serviceType: ServiceWithOwnLegal;
  /** What new orders of that service freeze today: the organization's own
   *  text, or the built-in default where `termsIsDefault` /
   *  `policyIsDefault`. */
  initial: {
    organizationId: string;
    brandName: string;
    termsAndConditions: string;
    termsVersion: string;
    termsIsDefault: boolean;
    cancellationPolicy: string;
    cancellationPolicyVersion: string;
    policyIsDefault: boolean;
    /** The brand has organization-wide (car rental) legal text, which
     *  flight and hotel orders never use. */
    hasOrganizationWideText: boolean;
  };
  canEdit: boolean;
}

/**
 * The selected organization's terms and cancellation policy for one
 * service — flight or hotel.
 *
 * Kept out of SettingsForm on purpose: that form saves the deployment-wide
 * settings in a single PATCH, while this text belongs to ONE brand and is
 * saved — and audited — on its own.
 */
export function ServiceLegalForm({
  serviceType,
  initial,
  canEdit,
}: ServiceLegalFormProps) {
  const router = useRouter();
  const { label, noun, writtenFor } = SERVICE_COPY[serviceType];
  const form = useForm<UpdateServiceLegalInput>({
    resolver: zodResolver(updateServiceLegalSchema),
    defaultValues: {
      serviceType,
      termsAndConditions: initial.termsAndConditions,
      cancellationPolicy: initial.cancellationPolicy,
    },
    mode: "onTouched",
  });

  const isSubmitting = form.formState.isSubmitting;
  const isDirty = form.formState.isDirty;
  const brand = initial.brandName;

  // What this tab is showing. Sent with every save so the server refuses a
  // stale one; advanced from each save's response, so saving twice in a row
  // from the same tab is not mistaken for a conflict.
  const [expected, setExpected] = useState({
    expectedOrganizationId: initial.organizationId,
    expectedTermsVersion: initial.termsVersion,
    expectedCancellationPolicyVersion: initial.cancellationPolicyVersion,
  });

  async function onSubmit(values: UpdateServiceLegalInput) {
    try {
      const saved = await api.patch<{
        termsVersion: string;
        cancellationPolicyVersion: string;
      }>("/api/admin/settings/legal", { ...values, ...expected });
      setExpected({
        ...expected,
        expectedTermsVersion: saved.termsVersion,
        expectedCancellationPolicyVersion: saved.cancellationPolicyVersion,
      });
      toast.success(`${label} terms updated`);
      form.reset(values);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : `Could not save ${noun} terms`;
      toast.error(message);
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <Section
          title={`${label} terms & cancellation policy — ${brand}`}
          description={`Applies only to ${brand}'s ${noun} orders — no other service and no other brand. Each new ${noun} order freezes this text and its version at creation; existing orders keep the snapshot they were created with. Saving a change auto-bumps that text's version.`}
        >
          {initial.hasOrganizationWideText ? (
            <p className="rounded-md border border-border bg-surface-1 px-3 py-2 text-[12px] text-muted-foreground">
              {`${brand} also has organization-wide terms, which only car rental orders use. ${label} orders never use them — if that text was written for ${writtenFor}, paste it here.`}
            </p>
          ) : null}
          <FormField
            control={form.control}
            name="termsAndConditions"
            render={({ field }) => (
              <FormItem>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <FormLabel>Terms & Conditions</FormLabel>
                  <LegalTextStatus
                    version={initial.termsVersion}
                    isDefault={initial.termsIsDefault}
                    noun={noun}
                  />
                </div>
                <FormControl>
                  <Textarea
                    rows={10}
                    placeholder="One clause per line — paragraphs render with subtle spacing in the email."
                    disabled={!canEdit || isSubmitting}
                    {...field}
                  />
                </FormControl>
                {initial.termsIsDefault ? (
                  <p className="text-[11.5px] text-muted-foreground">
                    {`${brand} has no ${noun} terms of its own yet, so new ${noun} orders freeze this built-in default. Edit it and save to replace it.`}
                  </p>
                ) : null}
                <p className="text-[11.5px] text-muted-foreground">
                  20–8,000 characters. Use one clause per line.
                </p>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="cancellationPolicy"
            render={({ field }) => (
              <FormItem>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <FormLabel>Cancellation & refund policy</FormLabel>
                  <LegalTextStatus
                    version={initial.cancellationPolicyVersion}
                    isDefault={initial.policyIsDefault}
                    noun={noun}
                  />
                </div>
                <FormControl>
                  <Textarea
                    rows={8}
                    placeholder="One rule per line — paragraphs render with subtle spacing in the email."
                    disabled={!canEdit || isSubmitting}
                    {...field}
                  />
                </FormControl>
                {initial.policyIsDefault ? (
                  <p className="text-[11.5px] text-muted-foreground">
                    {`${brand} has no ${noun} cancellation policy of its own yet, so new ${noun} orders freeze this built-in default. Edit it and save to replace it.`}
                  </p>
                ) : null}
                <p className="text-[11.5px] text-muted-foreground">
                  20–4,000 characters. Use one statement per line.
                </p>
                <FormMessage />
              </FormItem>
            )}
          />
        </Section>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3">
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
              {`Save ${noun} terms`}
            </LoadingButton>
          </div>
        </div>
      </form>
    </Form>
  );
}

/** The version new orders freeze, flagged while it is the built-in default. */
function LegalTextStatus({
  version,
  isDefault,
  noun,
}: {
  version: string;
  isDefault: boolean;
  noun: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {isDefault ? (
        <Badge variant="warning">{`Built-in ${noun} default in use`}</Badge>
      ) : null}
      <Badge variant="secondary">{`Version ${version}`}</Badge>
    </div>
  );
}
