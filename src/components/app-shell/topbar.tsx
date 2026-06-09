"use client";

import { useRouter } from "next/navigation";
import { LogOutIcon, MenuIcon } from "lucide-react";
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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { LogoLockup } from "@/components/brand/logo";
import { RealtimeIndicator } from "@/components/common/realtime-indicator";
import { initialsFromName } from "@/lib/format";
import { UserRoleLabel } from "@/lib/constants/labels";
import { toast } from "@/components/ui/sonner";
import { api } from "@/lib/api-client";
import type { SessionUser } from "@/types";

import { Sidebar } from "./sidebar";

interface TopbarProps {
  user: SessionUser;
  brand: string;
}

export function Topbar({ user, brand }: TopbarProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  async function onLogout() {
    try {
      await api.post("/api/auth/logout");
      router.push("/login");
      router.refresh();
    } catch {
      toast.error("Could not log out");
    }
  }

  // Slim 48px chrome that defers to the telemetry strip above.
  // SSE indicator removed (lives in the strip now); search + user
  // menu are the only chrome surfaces here, plus the page-context
  // label on the left.
  return (
    <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background/85 backdrop-blur-md px-4 md:px-6">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="md:hidden">
            <MenuIcon className="size-4" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="p-0 w-72 bg-sidebar">
          <SheetHeader className="px-4 h-14 flex-row items-center border-b border-sidebar-border">
            <SheetTitle asChild>
              <LogoLockup brand={brand} subtitle="Ops console" size="sm" />
            </SheetTitle>
          </SheetHeader>
          <Sidebar role={user.role} brand={brand} variant="embedded" />
        </SheetContent>
      </Sheet>

      {/* Topbar left side is intentionally bare, page context lives
          inside each page's own header. The telemetry strip above
          carries workspace + environment chrome; the topbar carries
          only utility actions (search + account). */}
      <div className="hidden md:block" aria-hidden />

      <div className="ml-auto flex items-center gap-2">
        <RealtimeIndicator className="md:hidden" withLabel={false} />
        <button
          type="button"
          onClick={() => {
            document.dispatchEvent(
              new KeyboardEvent("keydown", { key: "k", metaKey: true }),
            );
          }}
          className="hidden md:inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <span>Search</span>
          <kbd className="rounded bg-background px-1 text-[10px] font-semibold text-foreground tabular-nums shadow-xs">
            ⌘K
          </kbd>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="h-8 gap-2 pr-2 pl-1.5"
            >
              <Avatar className="size-6">
                <AvatarFallback className="text-[10.5px]">
                  {initialsFromName(user.name)}
                </AvatarFallback>
              </Avatar>
              <div className="hidden text-left sm:block leading-tight">
                <div className="text-[12.5px] font-medium">{user.name}</div>
                <div className="text-[10.5px] text-muted-foreground">
                  {UserRoleLabel[user.role]}
                </div>
              </div>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="flex flex-col gap-0.5 py-2">
              <span className="text-[12.5px] font-medium text-foreground">
                {user.name}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {user.email}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onLogout}>
              <LogOutIcon className="size-3.5" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
