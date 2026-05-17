"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3Icon,
  CreditCardIcon,
  HomeIcon,
  ScrollTextIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Permission,
  roleHasAnyPermission,
} from "@/lib/constants/permissions";
import type { UserRole } from "@/lib/constants/enums";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  permissions?: readonly Permission[];
}

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: HomeIcon },
  {
    href: "/orders",
    label: "Orders",
    icon: CreditCardIcon,
    permissions: [Permission.ORDER_VIEW_OWN, Permission.ORDER_VIEW_ALL],
  },
  {
    href: "/admin/analytics",
    label: "Analytics",
    icon: BarChart3Icon,
    permissions: [Permission.ANALYTICS_VIEW],
  },
  {
    href: "/admin/users",
    label: "Team",
    icon: UsersIcon,
    permissions: [Permission.USER_VIEW],
  },
  {
    href: "/admin/audit",
    label: "Audit log",
    icon: ScrollTextIcon,
    permissions: [Permission.AUDIT_VIEW],
  },
  {
    href: "/admin/settings",
    label: "Settings",
    icon: SettingsIcon,
    permissions: [Permission.SETTINGS_VIEW],
  },
];

interface SidebarProps {
  role: UserRole;
  brand: string;
}

export function Sidebar({ role, brand }: SidebarProps) {
  const pathname = usePathname();
  return (
    <aside className="hidden md:flex md:w-64 md:shrink-0 md:flex-col md:border-r md:border-border md:bg-sidebar">
      <div className="flex h-14 items-center gap-2 px-5 border-b border-border">
        <div className="size-7 rounded-md bg-primary/10 grid place-items-center text-primary">
          <CreditCardIcon className="size-4" />
        </div>
        <span className="text-sm font-semibold tracking-tight">{brand}</span>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV.filter((i) =>
          !i.permissions ? true : roleHasAnyPermission(role, i.permissions),
        ).map((item) => {
          const Icon = item.icon;
          const active =
            pathname === item.href || pathname?.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="px-5 py-4 text-[11px] text-muted-foreground">
        v1.0 • Operations console
      </div>
    </aside>
  );
}
