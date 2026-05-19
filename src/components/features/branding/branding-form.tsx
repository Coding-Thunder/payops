"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

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
import { toast } from "@/components/ui/sonner";
import { Section, SectionStack } from "@/components/common/section";
import { ColorInput, LogoPickerRow } from "@/components/common/logo-picker";
import { api, ApiClientError } from "@/lib/api-client";
import {
  updateBrandingSchema,
  type UpdateBrandingInput,
} from "@/lib/validation";
import type { BrandingDTO } from "@/types";

interface BrandingFormProps {
  initial: BrandingDTO;
  canEdit: boolean;
}

export function BrandingForm({ initial, canEdit }: BrandingFormProps) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<UpdateBrandingInput>({
    resolver: zodResolver(updateBrandingSchema),
    defaultValues: {
      brandName: initial.brandName,
      supportEmail: initial.supportEmail,
      supportPhone: initial.supportPhone,
      primaryColor: initial.primaryColor,
      footerTagline: initial.footerTagline,
      logo: initial.logo,
    },
    mode: "onTouched",
  });

  const isSubmitting = form.formState.isSubmitting;
  const isDirty = form.formState.isDirty;

  async function onSubmit(values: UpdateBrandingInput) {
    try {
      // Only PATCH fields the admin actually touched. Schema is fully
      // optional so an empty PATCH is rejected by the service.
      const dirty = form.formState.dirtyFields;
      const patch: UpdateBrandingInput = {};
      if (dirty.brandName) patch.brandName = values.brandName;
      if (dirty.supportEmail) patch.supportEmail = values.supportEmail;
      if (dirty.supportPhone) patch.supportPhone = values.supportPhone;
      if (dirty.primaryColor) patch.primaryColor = values.primaryColor;
      if (dirty.footerTagline) patch.footerTagline = values.footerTagline;
      // `logo` field is reserved for a server-set value (uploads use the
      // separate /logo endpoint); it's not exposed as an editable text input.

      const hasMetadataChanges = Object.keys(patch).length > 0;
      if (hasMetadataChanges) {
        await api.patch<BrandingDTO>("/api/admin/branding", patch);
      }
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/admin/branding/logo", {
          method: "POST",
          credentials: "include",
          body: fd,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new ApiClientError(
            res.status,
            body?.error ?? {
              code: "INTERNAL_ERROR",
              message: "Logo upload failed",
            },
          );
        }
      }
      if (!hasMetadataChanges && !file) {
        toast.message("No changes to save");
        return;
      }
      toast.success("Branding updated");
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      form.reset(values);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : "Could not save branding";
      toast.error(message);
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <SectionStack>
          <Section
            title="Brand identity"
            description="What the customer sees on confirmation emails, the payment landing pages, and the Stripe checkout product description."
          >
            <LogoPickerRow
              file={file}
              currentLogoSrc={initial.logo}
              altText={form.watch("brandName") || initial.brandName}
              fileInputRef={fileInputRef}
              onPick={setFile}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="brandName"
                render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>Brand name</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="e.g. PayOps"
                        disabled={!canEdit || isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Appears in confirmation email headers, footers, and the
                      Stripe statement descriptor metadata.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="primaryColor"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Header / accent colour</FormLabel>
                    <FormControl>
                      <ColorInput
                        value={field.value ?? initial.primaryColor}
                        onChange={field.onChange}
                        disabled={!canEdit || isSubmitting}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="footerTagline"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Footer tagline (optional)</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="e.g. Premium rental payments."
                        disabled={!canEdit || isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Shown under the brand name on the /pay landing pages.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </Section>

          <Section
            title="Customer support contact"
            description="Used in confirmation emails as the reply-to + 'need help?' contact, and on the payment-cancelled page."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="supportEmail"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Support email</FormLabel>
                    <FormControl>
                      <Input
                        type="email"
                        inputMode="email"
                        placeholder="support@yourbrand.com"
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
                        inputMode="tel"
                        placeholder="+1 555 0100"
                        disabled={!canEdit || isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </Section>
        </SectionStack>

        <div className="mt-6 flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3">
          <p className="text-[12.5px] text-muted-foreground">
            {isDirty || file ? "Unsaved changes" : "No pending changes"}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                form.reset();
                setFile(null);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
              disabled={(!isDirty && !file) || isSubmitting}
            >
              Discard
            </Button>
            <LoadingButton
              type="submit"
              size="sm"
              disabled={!canEdit || (!isDirty && !file)}
              loading={isSubmitting}
              loadingText="Saving"
            >
              Save branding
            </LoadingButton>
          </div>
        </div>
      </form>
    </Form>
  );
}
