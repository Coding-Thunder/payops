"use client";

import { BuildingIcon, CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useOrgTransition } from "@/components/app-shell/org-transition";
import type { OrganizationSummary } from "@/types";

interface OrgSwitcherProps {
  organizations: OrganizationSummary[];
  selectedId: string | null;
}

/**
 * Organization switcher for the topbar.
 *
 * Renders nothing when the deployment has no organizations, which keeps the
 * chrome identical to today for an unmigrated install. With exactly one
 * organization it renders a static label rather than a dropdown — a menu
 * with a single item is just noise.
 *
 * Switching is a POST to a Route Handler rather than a Server Action: the
 * repo uses no Server Actions, and since Next 16 a cookie can only be
 * written in the "action" phase, which a render cannot enter.
 *
 * The switch ITSELF lives in `OrgTransitionProvider`, not here. It has to:
 * the overlay that covers the outgoing organization's data must be mounted
 * above `<main>` in the shell, and it must outlive this dropdown, which
 * unmounts the moment the menu closes.
 */
export function OrgSwitcher({ organizations, selectedId }: OrgSwitcherProps) {
  const [open, setOpen] = useState(false);
  const { switchTo: beginSwitch, isSwitching } = useOrgTransition();

  if (organizations.length === 0) return null;

  const selected = organizations.find((o) => o.id === selectedId) ?? null;

  if (organizations.length === 1) {
    return (
      <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex">
        <BuildingIcon className="size-3.5" />
        {organizations[0]!.brandName}
      </span>
    );
  }

  function switchTo(org: OrganizationSummary) {
    if (org.id === selectedId) {
      setOpen(false);
      return;
    }
    // Close the menu FIRST so the overlay is not competing with a Radix
    // exit animation, then hand off. No success toast: the transition names
    // the destination brand, and a toast on top of that is one confirmation
    // too many.
    setOpen(false);
    beginSwitch(org);
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={isSwitching}
          className="h-7 gap-1.5 px-2 text-xs font-medium"
        >
          <BuildingIcon className="size-3.5" />
          <span className="max-w-[10rem] truncate">
            {selected?.brandName ?? "Select organization"}
          </span>
          <ChevronsUpDownIcon className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-xs">Organization</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {organizations.map((org) => (
          <DropdownMenuItem
            key={org.id}
            onSelect={(e) => {
              e.preventDefault();
              switchTo(org);
            }}
            className="gap-2"
          >
            <CheckIcon
              className={
                org.id === selectedId ? "size-3.5" : "size-3.5 opacity-0"
              }
            />
            <span className="truncate">{org.brandName}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
