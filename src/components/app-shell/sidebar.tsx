"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3Icon,
  CreditCardIcon,
  HomeIcon,
  PackageIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldAlertIcon,
  UsersIcon,
} from "lucide-react";

import { LogoLockup } from "@/components/brand/logo";
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

interface NavSection {
  label: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    label: "Workspace",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: HomeIcon },
      {
        href: "/orders",
        label: "Orders",
        icon: CreditCardIcon,
        permissions: [Permission.ORDER_VIEW_OWN, Permission.ORDER_VIEW_ALL],
      },
    ],
  },
  {
    label: "Admin",
    items: [
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
        href: "/admin/providers",
        label: "Providers",
        icon: PackageIcon,
        permissions: [Permission.PROVIDER_VIEW],
      },
      {
        href: "/admin/disputes",
        label: "Disputes",
        icon: ShieldAlertIcon,
        permissions: [Permission.ORDER_VIEW_ALL],
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
    ],
  },
];

interface SidebarProps {
  role: UserRole;
  brand: string;
  variant?: "full" | "embedded";
}

export function Sidebar({ role, brand, variant = "full" }: SidebarProps) {
  const pathname = usePathname();

  const visibleSections = SECTIONS.map((s) => ({
    ...s,
    items: s.items.filter(
      (i) => !i.permissions || roleHasAnyPermission(role, i.permissions),
    ),
  })).filter((s) => s.items.length > 0);

  return (
    <aside
      className={cn(
        "flex flex-col bg-sidebar text-sidebar-foreground",
        variant === "full"
          ? "hidden md:flex md:w-60 md:shrink-0 md:border-r md:border-sidebar-border"
          : "w-full",
      )}
    >
      {variant === "full" ? (
        <div className="flex h-14 items-center px-4 border-b border-sidebar-border">
          <Link href="/dashboard" className="flex-1 min-w-0">
            <LogoLockup brand={brand} subtitle="Ops console" size="sm" />
          </Link>
        </div>
      ) : null}

      <nav className="flex-1 overflow-y-auto px-2 py-4 space-y-5 scrollbar-thin">
        {visibleSections.map((section) => (
          <div key={section.label}>
            <div className="px-2 pb-1.5 text-[10.5px] uppercase tracking-wider text-muted-foreground/80 font-medium">
              {section.label}
            </div>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = item.icon;
                const active =
                  pathname === item.href ||
                  pathname?.startsWith(`${item.href}/`);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={cn(
                        "group relative flex items-center gap-2.5 rounded-md px-2 py-1.5",
                        "text-[13px] transition-colors",
                        active
                          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                          : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
                      )}
                    >
                      {active ? (
                        <span className="absolute -left-1 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-r-full bg-primary" />
                      ) : null}
                      <Icon
                        className={cn(
                          "size-4 transition-colors",
                          active
                            ? "text-foreground"
                            : "text-muted-foreground/70 group-hover:text-foreground",
                        )}
                      />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {variant === "full" ? (
        <div className="border-t border-sidebar-border px-4 py-3 text-[10.5px] uppercase tracking-wider text-muted-foreground/70">
          v1.0 · Operations
        </div>
      ) : null}
    </aside>
  );
}
