"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3Icon,
  CarIcon,
  CreditCardIcon,
  HomeIcon,
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

const SECTIONS: NavSection[] = [
  {
    label: "Workspace",
    items: [
      { href: "/app/dashboard", label: "Dashboard", icon: HomeIcon },
      {
        href: "/app/orders",
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
        href: "/app/admin/analytics",
        label: "Analytics",
        icon: BarChart3Icon,
        permissions: [Permission.ANALYTICS_VIEW],
      },
      {
        href: "/app/admin/users",
        label: "Team",
        icon: UsersIcon,
        permissions: [Permission.USER_VIEW],
      },
      {
        href: "/app/admin/providers",
        label: "Providers",
        icon: PackageIcon,
        permissions: [Permission.PROVIDER_VIEW],
      },
      {
        href: "/app/admin/car-links",
        label: "Car library",
        icon: CarIcon,
        permissions: [Permission.CAR_LINK_MANAGE],
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
        href: "/app/admin/disputes",
        label: "Disputes",
        icon: ShieldAlertIcon,
        permissions: [Permission.ORDER_VIEW_ALL],
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
          ? "hidden md:flex md:w-[15rem] md:shrink-0 md:border-r md:border-sidebar-border"
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

      <nav className="flex-1 overflow-y-auto px-2.5 py-5 space-y-6 scrollbar-thin">
        {visibleSections.map((section) => (
          <div key={section.label}>
            <div className="mb-2 px-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
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
                        "group relative flex items-center gap-2.5 px-2 py-[7px]",
                        "text-[13px] leading-none tracking-[-0.005em]",
                        "transition-[background-color,color] duration-150",
                        "rounded-[6px]",
                        active
                          ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold"
                          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                      )}
                    >
                      {/* Active rail — 2px chromatic stripe on the
                          left edge, tied to the telemetry-strip
                          accent gradient. Reads as a deliberate
                          ops-console selection, not a generic SaaS
                          pill highlight. */}
                      {active ? (
                        <span
                          aria-hidden
                          className="absolute -left-2.5 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r-full"
                          style={{
                            background:
                              "linear-gradient(180deg, var(--m-orange) 0%, var(--m-cobalt) 100%)",
                          }}
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
                      {/* Live indicator on the active item — pulses
                          to communicate that this surface is the
                          one receiving realtime updates. */}
                      {active ? (
                        <span
                          aria-hidden
                          className="ml-auto size-1.5 rounded-full bg-success"
                          style={{
                            animation:
                              "pulse-soft 2.4s ease-in-out infinite",
                          }}
                        />
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {variant === "full" ? (
        <div className="border-t border-sidebar-border px-4 py-3">
          <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
            <span>v1.0 · ops</span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="size-1.5 rounded-full bg-success"
                style={{
                  animation: "pulse-soft 2.6s ease-in-out infinite",
                }}
              />
              <span>online</span>
            </span>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
