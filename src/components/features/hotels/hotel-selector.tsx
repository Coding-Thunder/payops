"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ChevronsUpDownIcon, PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { api, ApiClientError } from "@/lib/api-client";
import type { UserRole } from "@/lib/constants/enums";
import type { HotelDTO } from "@/types";

import { CreateHotelDialog, useCanCreateHotel } from "./create-hotel-dialog";

export interface HotelSelection {
  hotelId: string;
  /** The catalog name — the form's `hotel.propertyName`. */
  propertyName: string;
  /** The catalog city — the form's `hotel.destination`. */
  destination: string;
}

interface HotelSelectorProps {
  /** Catalog id the form currently holds (`hotel.hotelId`), or null when
   *  the agent typed the property by hand. */
  value: string | null | undefined;
  onSelect: (selection: HotelSelection) => void;
  /** Property name + city the parent form already has. Drives the trigger
   *  label (so it reads "Hotel Arts — Barcelona", never a raw id) and the
   *  "Add new" dialog's pre-fill. Passed in so the selector doesn't have
   *  to re-look-up the catalog after every save. */
  initialName?: string;
  initialCity?: string;
  /** Operator role, when the caller knows it. Omit and the "Add hotel"
   *  CTA resolves `Permission.HOTEL_CREATE` from the session itself. */
  role?: UserRole;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
}

const DEBOUNCE_MS = 200;
/** Thumbnails rendered in the selected-hotel strip before the "+N" pill. */
const STRIP_LIMIT = 5;

/**
 * Searchable hotel-catalog picker — the hotel-side sibling of
 * `CarLinkSelector`. Same Command + Popover composition, so keyboard nav
 * (↑/↓/Enter/Esc) and the empty-state "Add new" CTA come for free, and the
 * same debounce so fast typing doesn't spam `/api/hotels?q=`.
 *
 * One shape difference from the car library: a hotel carries an ORDERED
 * ARRAY of images, not a single `imageUrl`. Rows use `primaryImageUrl` as
 * a thumbnail, but the selected property gets a strip of every image it
 * has — this is the only surface where an operator can see that the
 * catalog holds more than one, so it is deliberately not collapsed to the
 * primary.
 *
 * The selector FILLS the property/destination fields; it never owns them.
 * Off-catalog stays are still typed by hand, which is why the caller keeps
 * its inputs enabled.
 */
export function HotelSelector({
  value,
  onSelect,
  initialName,
  initialCity,
  role,
  disabled,
  invalid,
  id,
}: HotelSelectorProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [picked, setPicked] = React.useState<HotelDTO | null>(null);
  const queryClient = useQueryClient();
  const canCreate = useCanCreateHotel(role);

  // Debounce the search query.
  React.useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query]);

  // React Query handles loading, error, dedup, and cancellation. Only
  // fires while the popover is open (`enabled: open`) so we don't burn
  // requests for components that are mounted but never opened.
  const hotelsQuery = useQuery({
    queryKey: ["hotels", debounced],
    enabled: open,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      if (debounced.length > 0) params.set("q", debounced);
      params.set("limit", "20");
      const data = await api.get<{ items: HotelDTO[] }>(
        `/api/hotels?${params.toString()}`,
        { signal },
      );
      return data.items;
    },
    staleTime: 30_000,
  });

  // The form can arrive already carrying a `hotelId` (a restored draft, or
  // a second visit to the tab) with no row in memory to render the image
  // strip from. Fetch that one row so the strip survives a reload.
  const selectedQuery = useQuery({
    queryKey: ["hotel", value],
    enabled: Boolean(value) && picked?.id !== value,
    queryFn: async ({ signal }) =>
      api.get<HotelDTO>(`/api/hotels/${value}`, { signal }),
    staleTime: 60_000,
    retry: false,
  });

  const results = hotelsQuery.data ?? [];
  const loading = hotelsQuery.isFetching;
  const error =
    hotelsQuery.error instanceof ApiClientError
      ? hotelsQuery.error.message
      : hotelsQuery.error
        ? "Couldn't load the hotel catalog"
        : null;

  const selectedHotel: HotelDTO | null = value
    ? picked?.id === value
      ? picked
      : (selectedQuery.data ?? null)
    : null;

  // Trigger label resolution order:
  //  1. The parent's property name + city (always in sync with the form,
  //     and works before the popover has ever fetched anything).
  //  2. The selected catalog row (covers a form that holds only the id).
  //  3. Nothing — the trigger falls back to the placeholder.
  const triggerLabel = React.useMemo(() => {
    const fromForm = [initialName, initialCity].filter(Boolean).join(" — ");
    if (fromForm) return fromForm;
    return selectedHotel?.label ?? null;
  }, [initialName, initialCity, selectedHotel]);

  function handleSelect(hotel: HotelDTO) {
    setPicked(hotel);
    onSelect({
      hotelId: hotel.id,
      propertyName: hotel.name,
      destination: hotel.location.city,
    });
    setOpen(false);
  }

  function handleAddNew() {
    setOpen(false);
    setCreateOpen(true);
  }

  function handleCreated(hotel: HotelDTO) {
    // Invalidate so the next popover open shows the new row; meanwhile
    // optimistically select it immediately.
    queryClient.invalidateQueries({ queryKey: ["hotels"] });
    handleSelect(hotel);
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-invalid={invalid || undefined}
            disabled={disabled}
            className={cn(
              "h-10 w-full justify-between px-3 font-normal",
              !triggerLabel && "text-muted-foreground",
              invalid && "ring-1 ring-destructive/40",
            )}
          >
            <span className="truncate text-[13px]">
              {triggerLabel ?? "Search the hotel catalog…"}
            </span>
            <ChevronsUpDownIcon className="ml-2 size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          className="w-[--radix-popover-trigger-width] min-w-[340px] p-0"
        >
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search by property or city…"
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              <CommandEmpty>
                {loading ? (
                  <span className="text-muted-foreground">Searching…</span>
                ) : error ? (
                  <span className="text-destructive">{error}</span>
                ) : query.trim().length === 0 ? (
                  <span className="text-muted-foreground">
                    Type to search the catalog
                  </span>
                ) : canCreate ? (
                  <button
                    type="button"
                    onClick={handleAddNew}
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[13px] text-foreground hover:bg-accent"
                  >
                    <PlusIcon className="size-3.5" />
                    Add &quot;{query.trim()}&quot; as a new hotel
                  </button>
                ) : (
                  <span className="text-muted-foreground">
                    No matching property
                  </span>
                )}
              </CommandEmpty>
              {!loading && results.length > 0 ? (
                <CommandGroup heading="Catalog">
                  {results.map((hotel) => {
                    const active = hotel.id === value;
                    return (
                      <CommandItem
                        key={hotel.id}
                        value={`${hotel.label} ${hotel.id}`}
                        onSelect={() => handleSelect(hotel)}
                        className="flex items-start gap-3 py-2.5"
                      >
                        <HotelThumb
                          url={hotel.primaryImageUrl}
                          alt={hotel.name}
                          size={34}
                        />
                        <div className="flex min-w-0 flex-1 flex-col leading-tight">
                          <span className="truncate text-[13.5px] font-medium text-foreground">
                            {hotel.name}
                          </span>
                          <span className="truncate text-[11.5px] text-muted-foreground">
                            {hotel.location.city}, {hotel.location.country}
                            {hotel.starRating
                              ? ` · ${"★".repeat(hotel.starRating)}`
                              : ""}
                            {hotel.images.length > 1
                              ? ` · ${hotel.images.length} images`
                              : ""}
                          </span>
                        </div>
                        <CheckIcon
                          className={cn(
                            "size-3.5 shrink-0 text-foreground",
                            active ? "opacity-100" : "opacity-0",
                          )}
                        />
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ) : null}
              {canCreate &&
              !loading &&
              (results.length > 0 || query.trim().length > 0) ? (
                <div className="border-t border-border">
                  <button
                    type="button"
                    onClick={handleAddNew}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] font-medium text-foreground hover:bg-accent"
                  >
                    <PlusIcon className="size-3.5" />
                    Add new to catalog
                  </button>
                </div>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {selectedHotel ? (
        <SelectedHotelStrip hotel={selectedHotel} />
      ) : null}

      <CreateHotelDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initial={{ name: initialName || query.trim(), city: initialCity }}
        role={role}
        onCreated={handleCreated}
      />
    </>
  );
}

/**
 * Every image the selected property carries, in catalog order. The array
 * is the whole point of the hotel catalog — an operator who can only see
 * the primary image has no way to tell a one-photo stub from a fully
 * documented property.
 */
function SelectedHotelStrip({ hotel }: { hotel: HotelDTO }) {
  const shown = hotel.images.slice(0, STRIP_LIMIT);
  const overflow = hotel.images.length - shown.length;

  return (
    <div className="mt-2 rounded-md border border-border bg-surface-1 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {shown.length > 0 ? (
          <>
            {shown.map((image, index) => (
              <HotelThumb
                key={`${image.url}-${index}`}
                url={image.url}
                alt={image.caption ?? `${hotel.name} image ${index + 1}`}
                title={image.caption ?? undefined}
                size={40}
              />
            ))}
            {overflow > 0 ? (
              <span className="grid h-10 min-w-10 place-items-center rounded-md border border-border px-1.5 text-[11px] font-medium text-muted-foreground">
                +{overflow}
              </span>
            ) : null}
          </>
        ) : null}
        <p className="ml-1 text-[11.5px] text-muted-foreground">
          {hotel.images.length === 0
            ? "No images in the catalog for this property."
            : `${hotel.images.length} ${
                hotel.images.length === 1 ? "image" : "images"
              } in the catalog · first one is the thumbnail.`}
        </p>
      </div>
    </div>
  );
}

function HotelThumb({
  url,
  alt,
  title,
  size,
}: {
  url: string | null;
  alt: string;
  title?: string;
  size: number;
}) {
  return (
    <span
      className="grid shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-surface-2"
      style={{ width: size, height: size }}
      title={title}
    >
      {url ? (
        // Catalog images are operator-pasted links from the wider web;
        // next/image would proxy them and mask the ones that no longer
        // resolve.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={alt} className="size-full object-cover" />
      ) : (
        <span className="text-[9px] font-medium uppercase text-muted-foreground">
          No img
        </span>
      )}
    </span>
  );
}
