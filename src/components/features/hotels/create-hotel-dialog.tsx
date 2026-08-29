"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useFieldArray, useForm } from "react-hook-form";
import { useQuery } from "@tanstack/react-query";
import { PlusIcon, XIcon } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { ImageUrlPreview } from "@/components/common/image-url-preview";
import { api, ApiClientError } from "@/lib/api-client";
import type { UserRole } from "@/lib/constants/enums";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import { createHotelSchema, type CreateHotelInput } from "@/lib/validation";
import type { HotelDTO, SessionUser } from "@/types";

// Same asymmetry the car-link dialog documents: the `optionalText()` and
// `z.coerce.number()` chains give the schema different input and output
// shapes, so RHF gets both — `TFieldValues` for what lives in the form,
// `TTransformedValues` for what `handleSubmit` yields.
type CreateHotelFormValues = z.input<typeof createHotelSchema>;

/**
 * Resolves whether the signed-in operator may add to the hotel catalog.
 *
 * The order forms don't thread a `role` prop down (the car library never
 * needed one), so when the caller can't supply it we read the session from
 * `/api/auth/me` — one cached request per page, shared by every consumer
 * through the React Query key. The CTA stays hidden until the answer is
 * in, so we never flash an action the user can't take. The API enforces
 * `HOTEL_CREATE` regardless; this is presentation only.
 */
export function useCanCreateHotel(role?: UserRole): boolean {
  const meQuery = useQuery({
    queryKey: ["auth", "me"],
    enabled: role === undefined,
    queryFn: async ({ signal }) =>
      api.get<SessionUser>("/api/auth/me", { signal }),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const resolved = role ?? meQuery.data?.role;
  return resolved ? roleHasPermission(resolved, Permission.HOTEL_CREATE) : false;
}

interface CreateHotelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fill when opening from "+ Add new" with a search term. */
  initial?: { name?: string; city?: string };
  /** Operator role, when the caller already knows it. Omit to resolve it
   *  from the session — see `useCanCreateHotel`. */
  role?: UserRole;
  onCreated: (hotel: HotelDTO) => void;
}

/**
 * Inline dialog for adding a property to the shared hotel catalog, so an
 * agent taking a booking for a hotel we've never sold before doesn't have
 * to leave the order form. Hands the created row back to the caller for
 * immediate selection.
 *
 * Unlike the car library, a hotel carries an ORDERED LIST of images, so
 * the image field is a repeatable row set (add / remove) built the same
 * way `charge-lines-fieldset.tsx` builds charge lines. `sortOrder` is the
 * row's position at submit time — the operator orders the images by
 * ordering the rows.
 *
 * Layout follows the car-link dialog: DialogHeader / DialogBody /
 * DialogFooter slots, so padding and the footer divider match every other
 * dialog in the app.
 */
export function CreateHotelDialog({
  open,
  onOpenChange,
  initial,
  role,
  onCreated,
}: CreateHotelDialogProps) {
  const canCreate = useCanCreateHotel(role);

  const form = useForm<CreateHotelFormValues, unknown, CreateHotelInput>({
    resolver: zodResolver(createHotelSchema),
    defaultValues: {
      name: initial?.name ?? "",
      description: "",
      location: { city: initial?.city ?? "", country: "", address: "" },
      images: [],
      starRating: null,
      notes: "",
    },
  });

  const imageRows = useFieldArray({ control: form.control, name: "images" });

  // Amenities are a flat string list in the schema; a comma-separated
  // input beats five field-array rows for something an agent types once.
  const [amenities, setAmenities] = React.useState("");

  React.useEffect(() => {
    if (open) {
      form.reset({
        name: initial?.name ?? "",
        description: "",
        location: { city: initial?.city ?? "", country: "", address: "" },
        images: [],
        starRating: null,
        notes: "",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial?.name, initial?.city]);

  // Amenities live outside RHF, so `form.reset` can't clear them — do it
  // on the way out instead of in the open effect, which keeps the reset
  // in an event handler where it belongs.
  function handleOpenChange(next: boolean) {
    if (!next) setAmenities("");
    onOpenChange(next);
  }

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: CreateHotelInput) {
    const amenityList = amenities
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
    const payload: CreateHotelInput = {
      ...values,
      // Row order IS the display order — stamp it on the way out so the
      // catalog's `primaryImageUrl` is the first row the operator listed.
      images: (values.images ?? []).map((image, index) => ({
        ...image,
        sortOrder: index,
      })),
      ...(amenityList.length > 0 ? { amenities: amenityList } : {}),
    };
    try {
      const created = await api.post<HotelDTO>("/api/hotels", payload);
      toast.success("Saved to the hotel catalog");
      onCreated(created);
      handleOpenChange(false);
    } catch (err) {
      const msg =
        err instanceof ApiClientError ? err.message : "Could not save the hotel";
      toast.error(msg);
    }
  }

  if (!canCreate) return null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="lg">
        <Form {...form}>
          <form
            onSubmit={(event) => {
              // Portalled into document.body, but still a React child of
              // the outer order-create <form> — synthetic events bubble
              // through the React tree, so without stopPropagation() the
              // order form would submit alongside this one. Same guard the
              // car-link dialog carries.
              event.stopPropagation();
              return form.handleSubmit(onSubmit)(event);
            }}
            noValidate
            className="flex flex-col"
          >
            <DialogHeader>
              <DialogTitle>Add to hotel catalog</DialogTitle>
              <DialogDescription>
                Save a property once and everyone on the team can pick it on
                the next booking.
              </DialogDescription>
            </DialogHeader>

            <DialogBody className="space-y-5">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Property name</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Hotel Arts Barcelona"
                        autoComplete="off"
                        disabled={isSubmitting}
                        {...field}
                        value={field.value ?? ""}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="location.city"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>City</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Barcelona"
                          autoComplete="off"
                          disabled={isSubmitting}
                          {...field}
                          value={field.value ?? ""}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="location.country"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Country</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Spain"
                          autoComplete="off"
                          disabled={isSubmitting}
                          {...field}
                          value={field.value ?? ""}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_160px]">
                <FormField
                  control={form.control}
                  name="location.address"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Street address{" "}
                        <span className="text-muted-foreground">(optional)</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Carrer de la Marina 19-21"
                          autoComplete="off"
                          disabled={isSubmitting}
                          {...field}
                          value={field.value ?? ""}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="starRating"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Stars</FormLabel>
                      <Select
                        value={
                          typeof field.value === "number"
                            ? String(field.value)
                            : "none"
                        }
                        onValueChange={(v) =>
                          field.onChange(v === "none" ? null : Number(v))
                        }
                        disabled={isSubmitting}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Not rated" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="none">Not rated</SelectItem>
                          {[1, 2, 3, 4, 5].map((n) => (
                            <SelectItem key={n} value={String(n)}>
                              {"★".repeat(n)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <Label asChild>
                      <p>
                        Images{" "}
                        <span className="text-muted-foreground">(optional)</span>
                      </p>
                    </Label>
                    <p className="mt-1 text-[11.5px] text-muted-foreground">
                      Add as many as you like — the first one is used as the
                      catalog thumbnail.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isSubmitting || imageRows.fields.length >= 20}
                    onClick={() => imageRows.append({ url: "", caption: "" })}
                  >
                    <PlusIcon className="size-3.5" />
                    Add image
                  </Button>
                </div>

                {imageRows.fields.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[12.5px] text-muted-foreground">
                    No images yet.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {imageRows.fields.map((row, index) => (
                      <div
                        key={row.id}
                        className="grid gap-3 sm:grid-cols-[1fr_200px_auto] sm:items-start"
                      >
                        <FormField
                          control={form.control}
                          name={`images.${index}.url`}
                          render={({ field }) => (
                            <FormItem>
                              {index === 0 ? (
                                <FormLabel>Public link</FormLabel>
                              ) : null}
                              <FormControl>
                                <Input
                                  placeholder="https://…"
                                  autoComplete="off"
                                  disabled={isSubmitting}
                                  {...field}
                                  value={field.value ?? ""}
                                />
                              </FormControl>
                              <ImageUrlPreview
                                url={field.value}
                                size={56}
                                hideHelper
                              />
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name={`images.${index}.caption`}
                          render={({ field }) => (
                            <FormItem>
                              {index === 0 ? (
                                <FormLabel>Caption</FormLabel>
                              ) : null}
                              <FormControl>
                                <Input
                                  placeholder="Lobby"
                                  autoComplete="off"
                                  maxLength={200}
                                  disabled={isSubmitting}
                                  {...field}
                                  value={field.value ?? ""}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <div className={index === 0 ? "sm:pt-[26px]" : undefined}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove image ${index + 1}`}
                            disabled={isSubmitting}
                            onClick={() => imageRows.remove(index)}
                          >
                            <XIcon className="size-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Amenities live outside the RHF tree: they're a flat string
                  list with no per-row validation to surface, so a plain
                  controlled input merged in at submit is less machinery
                  than a registered field. */}
              <div className="space-y-1.5">
                <Label htmlFor="hotel-amenities">
                  Amenities{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="hotel-amenities"
                  placeholder="Pool, Spa, Airport shuttle"
                  autoComplete="off"
                  disabled={isSubmitting}
                  value={amenities}
                  onChange={(e) => setAmenities(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Separate with commas.
                </p>
              </div>

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Description{" "}
                      <span className="text-muted-foreground">(optional)</span>
                    </FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="How the property is described to the guest…"
                        rows={3}
                        disabled={isSubmitting}
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
                        placeholder="Internal note, e.g. contact at the property, rate agreement"
                        rows={2}
                        maxLength={500}
                        disabled={isSubmitting}
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
                onClick={() => handleOpenChange(false)}
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
