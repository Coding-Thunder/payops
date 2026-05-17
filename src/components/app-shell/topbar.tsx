"use client";

import { useRouter } from "next/navigation";
import { LogOutIcon, MenuIcon, UserCircleIcon } from "lucide-react";
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

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-4 md:px-6">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="md:hidden">
            <MenuIcon className="size-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="p-0 w-72">
          <SheetHeader className="px-5 py-4 border-b border-border">
            <SheetTitle>{brand}</SheetTitle>
          </SheetHeader>
          <div className="flex md:hidden">
            <Sidebar role={user.role} brand={brand} />
          </div>
        </SheetContent>
      </Sheet>

      <div className="hidden md:block text-sm text-muted-foreground">
        Operations console
      </div>

      <div className="ml-auto flex items-center gap-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="flex items-center gap-2 h-9 px-2"
            >
              <Avatar className="size-7">
                <AvatarFallback>{initialsFromName(user.name)}</AvatarFallback>
              </Avatar>
              <div className="hidden text-left sm:block">
                <div className="text-xs font-medium leading-tight">
                  {user.name}
                </div>
                <div className="text-[11px] text-muted-foreground leading-tight">
                  {UserRoleLabel[user.role]}
                </div>
              </div>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <div className="font-medium">{user.name}</div>
              <div className="text-xs text-muted-foreground">{user.email}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>
              <UserCircleIcon className="size-4" /> {UserRoleLabel[user.role]}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onLogout}>
              <LogOutIcon className="size-4" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
