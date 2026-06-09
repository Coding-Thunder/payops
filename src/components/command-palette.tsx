"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import {
  BarChart3Icon,
  CreditCardIcon,
  HomeIcon,
  LogOutIcon,
  PlusIcon,
  ScrollTextIcon,
  SettingsIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import {
  Permission,
  roleHasAnyPermission,
} from "@/lib/constants/permissions";
import { api } from "@/lib/api-client";
import type { UserRole } from "@/lib/constants/enums";
import { cn } from "@/lib/utils";

interface CommandPaletteProps {
  role: UserRole;
}

interface CommandAction {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  keywords?: string;
  shortcut?: string;
  permissions?: readonly Permission[];
  perform: (router: ReturnType<typeof useRouter>) => void | Promise<void>;
}

const NAV_ACTIONS: CommandAction[] = [
  {
    id: "go:dashboard",
    label: "Go to dashboard",
    keywords: "home overview",
    icon: HomeIcon,
    perform: (r) => r.push("/app/dashboard"),
  },
  {
    id: "go:orders",
    label: "View all orders",
    keywords: "payments bookings",
    icon: CreditCardIcon,
    permissions: [Permission.ORDER_VIEW_OWN],
    perform: (r) => r.push("/app/orders"),
  },
  {
    id: "create:order",
    label: "Create a new order",
    keywords: "new booking payment link",
    icon: PlusIcon,
    permissions: [Permission.ORDER_CREATE],
    shortcut: "C",
    perform: (r) => r.push("/app/orders/create"),
  },
  {
    id: "go:analytics",
    label: "Open analytics",
    keywords: "revenue stats metrics",
    icon: BarChart3Icon,
    permissions: [Permission.ANALYTICS_VIEW],
    perform: (r) => r.push("/app/admin/analytics"),
  },
  {
    id: "go:team",
    label: "Manage team members",
    keywords: "users staff admins",
    icon: UsersIcon,
    permissions: [Permission.USER_VIEW],
    perform: (r) => r.push("/app/admin/users"),
  },
  {
    id: "create:user",
    label: "Invite a new team member",
    keywords: "user admin staff add",
    icon: UserPlusIcon,
    permissions: [Permission.USER_CREATE],
    perform: (r) => r.push("/app/admin/users"),
  },
  {
    id: "go:audit",
    label: "Open audit log",
    keywords: "activity history events",
    icon: ScrollTextIcon,
    permissions: [Permission.AUDIT_VIEW],
    perform: (r) => r.push("/app/admin/audit"),
  },
  {
    id: "go:settings",
    label: "Operational settings",
    keywords: "configuration defaults",
    icon: SettingsIcon,
    permissions: [Permission.SETTINGS_VIEW],
    perform: (r) => r.push("/app/admin/settings"),
  },
];

const ACCOUNT_ACTIONS: CommandAction[] = [
  {
    id: "logout",
    label: "Sign out",
    keywords: "exit log out leave",
    icon: LogOutIcon,
    perform: async (r) => {
      try {
        await api.post("/api/auth/logout");
        r.push("/login");
        r.refresh();
      } catch {
        toast.error("Could not log out");
      }
    },
  },
];

export function CommandPalette({ role }: CommandPaletteProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const filteredNav = React.useMemo(
    () =>
      NAV_ACTIONS.filter(
        (a) => !a.permissions || roleHasAnyPermission(role, a.permissions),
      ),
    [role],
  );

  async function run(action: CommandAction) {
    setOpen(false);
    await action.perform(router);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        size="lg"
        showCloseButton={false}
        className={cn("max-w-[560px] p-0")}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command shouldFilter>
          <CommandInput placeholder="Search or run a command…" />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>

            <CommandGroup heading="Navigate">
              {filteredNav.map((action) => (
                <CommandItem
                  key={action.id}
                  value={`${action.label} ${action.keywords ?? ""}`}
                  onSelect={() => run(action)}
                >
                  <action.icon />
                  <span>{action.label}</span>
                  {action.shortcut ? (
                    <CommandShortcut>{action.shortcut}</CommandShortcut>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>

            <CommandSeparator />

            <CommandGroup heading="Account">
              {ACCOUNT_ACTIONS.map((action) => (
                <CommandItem
                  key={action.id}
                  value={`${action.label} ${action.keywords ?? ""}`}
                  onSelect={() => run(action)}
                >
                  <action.icon />
                  <span>{action.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
            <span>
              Press{" "}
              <kbd className="rounded border border-border bg-surface-1 px-1 py-0.5 text-[10px] font-medium text-foreground">
                ↵
              </kbd>{" "}
              to select
            </span>
            <span>
              <kbd className="rounded border border-border bg-surface-1 px-1 py-0.5 text-[10px] font-medium text-foreground">
                Esc
              </kbd>{" "}
              to close
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
