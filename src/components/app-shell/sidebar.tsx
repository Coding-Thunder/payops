"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3Icon,
  CreditCardIcon,
  GitBranchIcon,
  HomeIcon,
  KeyIcon,
  LayersIcon,
  MailIcon,
  PackageIcon,
  PaletteIcon,
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

/**
 * Sidebar information architecture, operational, not marketing.
 *
 *   OPERATIONS   the daily-use surfaces (dashboard, orders, disputes)
 *   CATALOG      the merchant's product world (item types, items)
 *   SETTINGS     team + integrations + brand + emails + audit + config
 *
 * Active selection is a 2px emerald rail on the left edge, the brand
 * accent. No pulse animations, no decorative dots; this is an ops
 * console and a steady left-edge rail is enough.
 */
const SECTIONS: NavSection[] = [
  {
    label: "Operations",
    items: [
      { href: "/app/dashboard", label: "Dashboard", icon: HomeIcon },
      {
        href: "/app/orders",
        label: "Orders",
        icon: CreditCardIcon,
        permissions: [Permission.ORDER_VIEW_OWN, Permission.ORDER_VIEW_ALL],
      },
      {
        href: "/app/admin/disputes",
        label: "Disputes",
        icon: ShieldAlertIcon,
        permissions: [Permission.ORDER_VIEW_ALL],
      },
      {
        href: "/app/admin/analytics",
        label: "Analytics",
        icon: BarChart3Icon,
        permissions: [Permission.ANALYTICS_VIEW],
      },
    ],
  },
  {
    label: "Catalog",
    items: [
      {
        href: "/app/admin/item-types",
        label: "Item types",
        icon: LayersIcon,
        permissions: [Permission.ITEM_TYPE_MANAGE],
      },
      {
        href: "/app/admin/items",
        label: "Catalog",
        icon: PackageIcon,
        permissions: [Permission.ITEM_MANAGE],
      },
    ],
  },
  {
    label: "Settings",
    items: [
      {
        href: "/app/admin/users",
        label: "Team",
        icon: UsersIcon,
        permissions: [Permission.USER_VIEW],
      },
      {
        href: "/app/admin/gateways",
        label: "Gateways",
        icon: KeyIcon,
        permissions: [Permission.GATEWAY_VIEW],
      },
      {
        href: "/app/admin/workflow",
        label: "Order workflow",
        icon: GitBranchIcon,
        permissions: [Permission.WORKFLOW_VIEW],
      },
      {
        href: "/app/admin/branding",
        label: "Branding",
        icon: PaletteIcon,
        permissions: [Permission.BRANDING_VIEW],
      },
      {
        href: "/app/admin/email-templates",
        label: "Email templates",
        icon: MailIcon,
        permissions: [Permission.EMAIL_TEMPLATE_VIEW],
      },
      {
        href: "/app/admin/emails",
        label: "Email previews",
        icon: MailIcon,
        permissions: [Permission.SETTINGS_VIEW],
      },
      {
        href: "/app/admin/audit",
        label: "Audit log",
        icon: ScrollTextIcon,
        permissions: [Permission.AUDIT_VIEW],
      },
      {
        href: "/app/admin/settings",
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
          ? "hidden md:flex md:w-[14.5rem] md:shrink-0 md:border-r md:border-sidebar-border"
          : "w-full",
      )}
    >
      {variant === "full" ? (
        // Brand block height matches (telemetry strip 28px + topbar
        // 48px = 76px) so the chrome reads as one continuous layer
        // across all three columns.
        <div className="flex h-[76px] items-center px-4 border-b border-sidebar-border">
          <Link
            href="/app/dashboard"
            className="flex-1 min-w-0 transition-opacity hover:opacity-90"
          >
            <LogoLockup brand={brand} subtitle="Ops console" size="sm" />
          </Link>
        </div>
      ) : null}

      <nav className="flex-1 overflow-y-auto px-2.5 py-5 space-y-5 scrollbar-thin">
        {visibleSections.map((section) => (
          <div key={section.label}>
            <div className="mb-1.5 px-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/65">
              {section.label}
            </div>
            <ul className="space-y-px">
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
                        "group relative flex items-center gap-2.5 px-2 py-1.5",
                        "text-[13px] leading-tight tracking-[-0.005em]",
                        "transition-[background-color,color] duration-150",
                        "rounded-[6px]",
                        active
                          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                      )}
                    >
                      {/* Active rail, flat 2px emerald edge marker.
                          No gradient, no pulse, no marketing accent;
                          a single brand color line that just says
                          "you are here". */}
                      {active ? (
                        <span
                          aria-hidden
                          className="absolute -left-2.5 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-r-full bg-success"
                        />
                      ) : null}
                      <Icon
                        className={cn(
                          "size-[15px] transition-colors",
                          active
                            ? "text-foreground"
                            : "text-muted-foreground/60 group-hover:text-foreground",
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
        <div className="border-t border-sidebar-border px-4 py-2.5">
          <p className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground/65 tabular-nums">
            v1.0
          </p>
        </div>
      ) : null}
    </aside>
  );
}
