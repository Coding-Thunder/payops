"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { PencilIcon } from "lucide-react";

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
import { FormDialog } from "@/components/common/form-dialog";
import { toast } from "@/components/ui/sonner";
import { api, ApiClientError } from "@/lib/api-client";
import {
  updateProviderSchema,
  type UpdateProviderInput,
} from "@/lib/validation";
import type { ProviderDTO } from "@/types";

import {
  ColorInput,
  LogoPickerRow,
} from "./create-provider-dialog";

interface EditProviderDialogProps {
  provider: ProviderDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditProviderDialog({
  provider,
  open,
  onOpenChange,
}: EditProviderDialogProps) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<UpdateProviderInput>({
    resolver: zodResolver(updateProviderSchema),
    defaultValues: {
      name: provider.name,
      primaryColor: provider.primaryColor,
      onPrimaryColor: provider.onPrimaryColor,
      tagline: provider.tagline,
      sortOrder: provider.sortOrder,
    },
    mode: "onTouched",
  });

  async function onSubmit(values: UpdateProviderInput) {
    try {
      // Only patch fields the admin actually touched so the audit log
      // shows real changes, not a no-op rewrite.
      const dirty = form.formState.dirtyFields;
      const patch: UpdateProviderInput = {};
      if (dirty.name) patch.name = values.name;
      if (dirty.primaryColor) patch.primaryColor = values.primaryColor;
      if (dirty.onPrimaryColor) patch.onPrimaryColor = values.onPrimaryColor;
      if (dirty.tagline) patch.tagline = values.tagline;
      if (dirty.sortOrder) patch.sortOrder = values.sortOrder;

      const hasMetadataChanges = Object.keys(patch).length > 0;
      if (hasMetadataChanges) {
        await api.patch<ProviderDTO>(
          `/api/admin/providers/${provider.id}`,
          patch,
        );
      }
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch(
          `/api/admin/providers/${provider.id}/logo`,
          { method: "POST", credentials: "include", body: fd },
        );
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
        onOpenChange(false);
        return;
      }
      toast.success("Provider updated");
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : "Could not update provider";
      toast.error(message);
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          form.reset();
          setFile(null);
        }
      }}
      title={`Edit ${provider.name}`}
      description={`Key ${provider.key} is fixed for life — historical orders rely on it. Logo, name, colours, and tagline can change freely.`}
      icon={<PencilIcon />}
      tone="info"
      submitLabel="Save changes"
      onSubmit={async (e) => {
        await form.handleSubmit(onSubmit)(e);
      }}
    >
      <Form {...form}>
        <div className="space-y-4">
          <LogoPickerRow
            file={file}
            previewName={form.watch("name") ?? provider.name}
            previewLogo={provider.logo}
            fileInputRef={fileInputRef}
            onPick={setFile}
          />

          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Display name</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="tagline"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Tagline</FormLabel>
                <FormControl>
                  <Input
                    placeholder="One-line description shown in the selector"
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  Optional. Leave blank to hide the secondary line in the
                  selector.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="primaryColor"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Primary brand colour</FormLabel>
                  <FormControl>
                    <ColorInput
                      value={field.value ?? provider.primaryColor}
                      onChange={field.onChange}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="onPrimaryColor"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Text-on-primary colour</FormLabel>
                  <FormControl>
                    <ColorInput
                      value={field.value ?? provider.onPrimaryColor}
                      onChange={field.onChange}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>
      </Form>
    </FormDialog>
  );
}
