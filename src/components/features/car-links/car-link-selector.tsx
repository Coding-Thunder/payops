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
import type { CarLinkDTO } from "@/types";

import { CreateCarLinkDialog } from "./create-car-link-dialog";

export interface CarLinkSelection {
  imageUrl: string;
  carMake: string;
  carType: string;
}

interface CarLinkSelectorProps {
  /** Current image-URL value the form holds. Used to highlight the
   *  matching library entry in the popover. */
  value: string | null | undefined;
  onSelect: (selection: CarLinkSelection) => void;
  /** Make + type the parent form already has. Drives BOTH the trigger
   *  button display (so it always reads "Toyota Corolla SE", never the
   *  raw URL) and the "Add new" dialog's pre-fill. Passed in so the
   *  selector doesn't have to do its own lookup after every save. */
  initialMake?: string;
  initialType?: string;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
}

const DEBOUNCE_MS = 200;

/**
 * Searchable car-library picker. Composes shadcn Command + Popover so
 * keyboard nav (↑/↓/Enter/Esc) and the empty-state "Add new" CTA come
 * for free. Debounces the network query so fast typing doesn't spam
 * `/api/car-links?q=`.
 */
export function CarLinkSelector({
  value,
  onSelect,
  initialMake,
  initialType,
  disabled,
  invalid,
  id,
}: CarLinkSelectorProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [createOpen, setCreateOpen] = React.useState(false);
  const queryClient = useQueryClient();

  // Debounce the search query.
  React.useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query]);

  // React Query handles loading, error, dedup, and cancellation. Only
  // fires while the popover is open (`enabled: open`) so we don't burn
  // requests for components that are mounted but never opened.
  const carLinksQuery = useQuery({
    queryKey: ["car-links", debounced],
    enabled: open,
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      if (debounced.length > 0) params.set("q", debounced);
      params.set("limit", "20");
      const data = await api.get<{ items: CarLinkDTO[] }>(
        `/api/car-links?${params.toString()}`,
        { signal },
      );
      return data.items;
    },
    staleTime: 30_000,
  });

  const results = carLinksQuery.data ?? [];
  const loading = carLinksQuery.isFetching;
  const error =
    carLinksQuery.error instanceof ApiClientError
      ? carLinksQuery.error.message
      : carLinksQuery.error
        ? "Couldn't load library"
        : null;

  // Trigger label resolution order:
  //  1. The parent's make + type (always in sync with the form, doesn't
  //     depend on the popover ever opening to fetch the catalog).
  //  2. The matching row in `results` (covers the rare case where the
  //     form value exists but make/type are blank — e.g. legacy drafts).
  //  3. Nothing — the trigger falls back to the placeholder.
  const triggerLabel = React.useMemo(() => {
    const fromForm = `${initialMake ?? ""} ${initialType ?? ""}`.trim();
    if (fromForm) return fromForm;
    if (!value) return null;
    return results.find((r) => r.imageUrl === value)?.label ?? null;
  }, [value, results, initialMake, initialType]);

  function handleSelect(link: CarLinkDTO) {
    onSelect({
      imageUrl: link.imageUrl,
      carMake: link.carMake,
      carType: link.carType,
    });
    setOpen(false);
  }

  function handleAddNew() {
    setOpen(false);
    setCreateOpen(true);
  }

  function handleCreated(link: CarLinkDTO) {
    // Invalidate so the next popover open shows the new row; meanwhile
    // optimistically select it immediately.
    queryClient.invalidateQueries({ queryKey: ["car-links"] });
    handleSelect(link);
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
              !value && "text-muted-foreground",
              invalid && "ring-1 ring-destructive/40",
            )}
          >
            <span className="truncate text-[13px]">
              {triggerLabel ?? (value ? "Selected car" : "Search the car library…")}
            </span>
            <ChevronsUpDownIcon className="ml-2 size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          className="w-[--radix-popover-trigger-width] min-w-[320px] p-0"
        >
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search by make, model, or note…"
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
                    Type to search the library
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={handleAddNew}
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[13px] text-foreground hover:bg-accent"
                  >
                    <PlusIcon className="size-3.5" />
                    Add &quot;{query.trim()}&quot; as a new car
                  </button>
                )}
              </CommandEmpty>
              {!loading && results.length > 0 ? (
                <CommandGroup heading="Library">
                  {results.map((link) => {
                    const active = link.imageUrl === value;
                    return (
                      <CommandItem
                        key={link.id}
                        value={`${link.label} ${link.imageUrl}`}
                        onSelect={() => handleSelect(link)}
                        className="flex items-start gap-3 py-2.5"
                      >
                        <div className="flex min-w-0 flex-1 flex-col leading-tight">
                          <span className="truncate text-[13.5px] font-medium text-foreground">
                            {link.label}
                          </span>
                          <span className="truncate text-[11.5px] text-muted-foreground">
                            {link.notes ?? link.imageUrl}
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
              {!loading && (results.length > 0 || query.trim().length > 0) ? (
                <div className="border-t border-border">
                  <button
                    type="button"
                    onClick={handleAddNew}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] font-medium text-foreground hover:bg-accent"
                  >
                    <PlusIcon className="size-3.5" />
                    Add new to library
                  </button>
                </div>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <CreateCarLinkDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initial={{
          carMake: initialMake ?? splitFirstWord(query).first,
          carType: initialType ?? splitFirstWord(query).rest,
        }}
        onCreated={handleCreated}
      />
    </>
  );
}

function splitFirstWord(s: string): { first: string; rest: string } {
  const trimmed = s.trim();
  if (!trimmed) return { first: "", rest: "" };
  const idx = trimmed.indexOf(" ");
  if (idx === -1) return { first: trimmed, rest: "" };
  return {
    first: trimmed.slice(0, idx),
    rest: trimmed.slice(idx + 1).trim(),
  };
}
