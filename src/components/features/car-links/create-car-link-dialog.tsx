"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import {
  Dialog,
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
 */
export function CreateCarLinkDialog({
  open,
  onOpenChange,
  initial,
  onCreated,
}: CreateCarLinkDialogProps) {
  const form = useForm<CreateCarLinkInput>({
    resolver: zodResolver(createCarLinkSchema),
    defaultValues: {
      carMake: initial?.carMake ?? "",
      carType: initial?.carType ?? "",
      imageUrl: "",
      notes: "",
    },
  });

  // Reset the form when the dialog re-opens with new initial values.
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add to car library</DialogTitle>
          <DialogDescription>
            Save a reusable car listing. Everyone on the team can pick it
            next time.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="space-y-5 pt-2"
            onSubmit={form.handleSubmit(onSubmit)}
            noValidate
          >
            <div className="grid grid-cols-2 gap-4">
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
                    Notes <span className="text-muted-foreground">(optional)</span>
                  </FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Internal note, e.g. interior color, license plate"
                      rows={2}
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
            <DialogFooter className="gap-2 pt-2">
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
