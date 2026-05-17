"use client";

import { useState } from "react";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";

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
import type { ProviderDTO } from "@/types";

import { ProviderLogo } from "./provider-logo";

interface ProviderSelectorProps {
  /** Catalog of selectable providers (typically the ACTIVE list from the
   *  admin catalog). Order is preserved as-given. */
  providers: ProviderDTO[];
  value: string | null | undefined;
  onChange: (next: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  placeholder?: string;
  /** Optional id wired up by `<FormControl>` / `<Label htmlFor>`. */
  id?: string;
}

/**
 * Searchable, keyboard-navigable provider picker. Mirrors the visual
 * language of shadcn's combobox pattern (Popover + Command) so it slots
 * into the existing form without bespoke styling.
 */
export function ProviderSelector({
  providers,
  value,
  onChange,
  disabled,
  invalid,
  placeholder = "Select a rental provider",
  id,
}: ProviderSelectorProps) {
  const [open, setOpen] = useState(false);
  const selected = value ? providers.find((p) => p.key === value) ?? null : null;

  return (
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
            "h-12 w-full justify-between px-3 font-normal",
            !selected && "text-muted-foreground",
            invalid && "ring-1 ring-destructive/40",
          )}
        >
          <span className="flex min-w-0 items-center gap-3">
            {selected ? (
              <>
                <ProviderLogo
                  provider={{
                    id: selected.key,
                    name: selected.name,
                    logo: selected.logo,
                  }}
                  size="md"
                  framed
                />
                <span className="truncate text-[14px] font-medium text-foreground">
                  {selected.name}
                </span>
              </>
            ) : (
              <span className="truncate text-[13px]">{placeholder}</span>
            )}
          </span>
          <ChevronsUpDownIcon className="ml-2 size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[--radix-popover-trigger-width] min-w-[280px] p-0"
      >
        <Command>
          <CommandInput placeholder="Search providers…" />
          <CommandList>
            <CommandEmpty>
              {providers.length === 0
                ? "No providers configured yet."
                : "No provider matches that search."}
            </CommandEmpty>
            <CommandGroup heading="Rental providers">
              {providers.map((p) => {
                const active = p.key === value;
                return (
                  <CommandItem
                    key={p.id}
                    value={`${p.name} ${p.key}`}
                    onSelect={() => {
                      onChange(p.key);
                      setOpen(false);
                    }}
                    className="flex items-center gap-3 py-2.5"
                  >
                    <ProviderLogo
                      provider={{ id: p.key, name: p.name, logo: p.logo }}
                      size="md"
                      framed
                    />
                    <span className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="truncate text-[13.5px] font-medium text-foreground">
                        {p.name}
                      </span>
                      <span className="truncate text-[11.5px] text-muted-foreground">
                        {p.tagline || p.key}
                      </span>
                    </span>
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
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
