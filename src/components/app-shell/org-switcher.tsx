"use client";

import { useRouter } from "next/navigation";
import { BuildingIcon, CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import { api } from "@/lib/api-client";
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
 * written in the "action" phase, which a render cannot enter. `router.refresh()`
 * then re-runs the server tree so every page re-resolves against the new
 * selection.
 */
export function OrgSwitcher({ organizations, selectedId }: OrgSwitcherProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

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
    startTransition(async () => {
      try {
        await api.post("/api/organizations/switch", {
          organizationId: org.id,
        });
        setOpen(false);
        toast.success(`Switched to ${org.brandName}`);
        // Re-render the server tree so every page picks up the new
        // organization. A push would keep the current route, which may not
        // exist (or may not be permitted) in the organization just chosen.
        router.replace("/app/dashboard");
        router.refresh();
      } catch {
        toast.error("Could not switch organization");
      }
    });
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
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
