"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import type { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { ImageUrlPreview } from "@/components/common/image-url-preview";
import { api, ApiClientError } from "@/lib/api-client";
import { createCarLinkSchema, type CreateCarLinkInput } from "@/lib/validation";
import type { CarLinkDTO } from "@/types";

// Zod's `.optional().nullable().transform()` chain on `notes` makes the
// schema's input and output shapes asymmetric (`string|null|undefined`
// vs `string|null`). RHF v7 separates `TFieldValues` (the in-form shape)
// from `TTransformedValues` (what `handleSubmit` yields) — we feed both
// so the resolver and submit handler line up at the type level.
type CreateCarLinkFormValues = z.input<typeof createCarLinkSchema>;

interface CreateCarLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fill the form when opening from "+ Add new" with a search term. */
  initial?: { carMake?: string; carType?: string };
  onCreated: (carLink: CarLinkDTO) => void;
}

/**
 * Inline dialog for adding a new entry to the workspace car library.
 * Hands the freshly-created row back to the caller so the selector can
 * activate it immediately.
 *
 * Layout note: uses the DialogHeader / DialogBody / DialogFooter slots
 * from the Dialog primitive so the horizontal rhythm (px-5 sm:px-6),
 * footer divider, and surface tone match every other dialog in the app.
 * Putting a `<form>` directly inside DialogContent skips the body
 * padding and the content reads as edge-glued.
 */
export function CreateCarLinkDialog({
  open,
  onOpenChange,
  initial,
  onCreated,
}: CreateCarLinkDialogProps) {
  const form = useForm<CreateCarLinkFormValues, unknown, CreateCarLinkInput>({
    resolver: zodResolver(createCarLinkSchema),
    defaultValues: {
      carMake: initial?.carMake ?? "",
      carType: initial?.carType ?? "",
      imageUrl: "",
      notes: "",
    },
  });

  React.useEffect(() => {
    if (open) {
      form.reset({
        carMake: initial?.carMake ?? "",
        carType: initial?.carType ?? "",
        imageUrl: "",
        notes: "",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial?.carMake, initial?.carType]);

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: CreateCarLinkInput) {
    try {
      const created = await api.post<CarLinkDTO>("/api/car-links", values);
      toast.success("Saved to the car library");
      onCreated(created);
      onOpenChange(false);
    } catch (err) {
      const msg =
        err instanceof ApiClientError
          ? err.message
          : "Could not save the car link";
      toast.error(msg);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <Form {...form}>
          <form
            onSubmit={(event) => {
              // The dialog is rendered via Radix Portal, so its DOM is in
              // document.body — but the React tree still descends from the
              // outer order-create <form>. React synthetic events bubble
              // through the React tree, not the DOM tree, so without
              // stopPropagation() the outer form would also submit and
              // every untouched field would suddenly show its required
              // validation error.
              event.stopPropagation();
              return form.handleSubmit(onSubmit)(event);
            }}
            noValidate
            className="flex flex-col"
          >
            <DialogHeader>
              <DialogTitle>Add to car library</DialogTitle>
              <DialogDescription>
                Save a reusable car listing. Everyone on the team can pick
                it next time.
              </DialogDescription>
            </DialogHeader>

            <DialogBody className="space-y-5">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="carMake"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Make</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Toyota"
                          autoComplete="off"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="carType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Model</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Camry SE"
                          autoComplete="off"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="imageUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Public link</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="https://…"
                        autoComplete="off"
                        {...field}
                      />
                    </FormControl>
                    <ImageUrlPreview url={field.value} size={84} />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Notes{" "}
                      <span className="text-muted-foreground">(optional)</span>
                    </FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Internal note, e.g. interior color, license plate"
                        rows={3}
                        maxLength={500}
                        value={field.value ?? ""}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </DialogBody>

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Saving…" : "Save & select"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
