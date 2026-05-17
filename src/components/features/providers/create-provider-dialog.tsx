"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import { ColorInput, LogoPickerRow } from "@/components/common/logo-picker";
import { toast } from "@/components/ui/sonner";
import { api, ApiClientError } from "@/lib/api-client";
import {
  createProviderSchema,
  type CreateProviderInput,
} from "@/lib/validation";
import type { ProviderDTO } from "@/types";

const PLACEHOLDER_LOGO = "/providers/_placeholder.svg";

export function CreateProviderDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<CreateProviderInput>({
    resolver: zodResolver(createProviderSchema),
    defaultValues: {
      key: "",
      name: "",
      logo: PLACEHOLDER_LOGO,
      primaryColor: "#1E3A8A",
      onPrimaryColor: "#FFFFFF",
      tagline: "",
      sortOrder: 0,
    },
    mode: "onTouched",
  });

  function reset() {
    form.reset();
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function onSubmit(values: CreateProviderInput) {
    try {
      // Two-phase: create the catalog row first (with a placeholder logo)
      // so we have an id to upload against. If the file upload fails the
      // provider still exists and the admin can retry from the edit dialog.
      const created = await api.post<ProviderDTO>("/api/admin/providers", {
        ...values,
        logo: PLACEHOLDER_LOGO,
      });
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch(`/api/admin/providers/${created.id}/logo`, {
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
      toast.success("Provider added");
      reset();
      setOpen(false);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : "Could not create provider";
      toast.error(message);
    }
  }

  function handleNameChange(value: string) {
    form.setValue("name", value, { shouldTouch: true });
    // Auto-derive the key on first edit if the user hasn't typed one yet.
    const currentKey = form.getValues("key");
    if (!currentKey) {
      const derived = value
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 32);
      if (derived) form.setValue("key", derived, { shouldTouch: true });
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <PlusIcon className="size-3.5" />
        Add provider
      </Button>

      <FormDialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
        title="Add rental provider"
        description="The brand mark renders on orders, dashboards, and customer receipts. Use the provider's official logo when going live."
        submitLabel="Create provider"
        size="md"
        onSubmit={async (e) => {
          await form.handleSubmit(onSubmit)(e);
        }}
      >
        <Form {...form}>
          <div className="space-y-4">
            <LogoPickerRow
              file={file}
              currentLogoSrc={PLACEHOLDER_LOGO}
              altText={form.watch("name") || "Provider"}
              fileInputRef={fileInputRef}
              onPick={(f) => setFile(f)}
            />

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Display name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Sixt"
                      {...field}
                      onChange={(e) => handleNameChange(e.target.value)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="key"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Stable key</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="SIXT"
                      autoCapitalize="characters"
                      {...field}
                      onChange={(e) =>
                        field.onChange(e.target.value.toUpperCase())
                      }
                    />
                  </FormControl>
                  <FormDescription>
                    Uppercase identifier persisted on every order. 2–32
                    letters / digits / underscore — never reused once set.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="tagline"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tagline (optional)</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="One-line description shown in the selector"
                      {...field}
                    />
                  </FormControl>
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
                        value={field.value ?? "#1E3A8A"}
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
                        value={field.value ?? "#FFFFFF"}
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
    </>
  );
}

