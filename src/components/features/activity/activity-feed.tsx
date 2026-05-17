"use client";

import Link from "next/link";
import * as React from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertCircleIcon,
  ArchiveIcon,
  CheckCircle2Icon,
  ClockIcon,
  CreditCardIcon,
  LinkIcon,
  UserPlusIcon,
  UserCogIcon,
  type LucideIcon,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/common/empty-state";
import {
  DomainEventType,
  type DomainEvent,
} from "@/lib/constants/events";
import { formatRelative } from "@/lib/format";
import { useActivityFeed } from "@/hooks/use-activity-feed";
import { cn } from "@/lib/utils";

interface EventVisual {
  icon: LucideIcon;
  tone: string;
  title: string;
  description: (event: DomainEvent) => string;
  href?: (event: DomainEvent) => string | null;
}

const VISUALS: Record<DomainEventType, EventVisual> = {
  [DomainEventType.ORDER_CREATED]: {
    icon: CreditCardIcon,
    tone: "bg-info-soft text-info ring-info-border/60",
    title: "Order created",
    description: (e) =>
      `${e.payload.orderNumber ?? ""} · ${e.payload.customerName ?? ""}`,
    href: (e) =>
      e.payload.orderId ? `/orders/${e.payload.orderId}` : null,
  },
  [DomainEventType.ORDER_PAID]: {
    icon: CheckCircle2Icon,
    tone: "bg-success-soft text-success ring-success-border/60",
    title: "Payment received",
    description: (e) =>
      `${e.payload.orderNumber ?? ""} · ${e.payload.customerName ?? ""}`,
    href: (e) =>
      e.payload.orderId ? `/orders/${e.payload.orderId}` : null,
  },
  [DomainEventType.ORDER_FAILED]: {
    icon: AlertCircleIcon,
    tone: "bg-destructive-soft text-destructive ring-destructive-border/60",
    title: "Payment failed",
    description: (e) =>
      `${e.payload.orderNumber ?? ""} · ${e.payload.customerName ?? ""}`,
    href: (e) =>
      e.payload.orderId ? `/orders/${e.payload.orderId}` : null,
  },
  [DomainEventType.ORDER_EXPIRED]: {
    icon: ClockIcon,
    tone: "bg-warning-soft text-warning-foreground ring-warning-border/60",
    title: "Link expired",
    description: (e) =>
      `${e.payload.orderNumber ?? ""} · ${e.payload.customerName ?? ""}`,
    href: (e) =>
      e.payload.orderId ? `/orders/${e.payload.orderId}` : null,
  },
  [DomainEventType.ORDER_ARCHIVED]: {
    icon: ArchiveIcon,
    tone: "bg-surface-1 text-muted-foreground ring-border",
    title: "Order archived",
    description: (e) => `${e.payload.orderNumber ?? ""}`,
    href: (e) =>
      e.payload.orderId ? `/orders/${e.payload.orderId}` : null,
  },
  [DomainEventType.ORDER_LINK_REGENERATED]: {
    icon: LinkIcon,
    tone: "bg-info-soft text-info ring-info-border/60",
    title: "Payment link regenerated",
    description: (e) => `${e.payload.orderNumber ?? ""}`,
    href: (e) =>
      e.payload.orderId ? `/orders/${e.payload.orderId}` : null,
  },
  [DomainEventType.USER_CREATED]: {
    icon: UserPlusIcon,
    tone: "bg-info-soft text-info ring-info-border/60",
    title: "Team member added",
    description: (e) =>
      `${e.payload.name ?? ""}${e.payload.role ? ` · ${e.payload.role}` : ""}`,
  },
  [DomainEventType.USER_UPDATED]: {
    icon: UserCogIcon,
    tone: "bg-surface-1 text-muted-foreground ring-border",
    title: "Team member updated",
    description: (e) => `${e.payload.name ?? ""}`,
  },
  [DomainEventType.SETTINGS_UPDATED]: {
    icon: UserCogIcon,
    tone: "bg-surface-1 text-muted-foreground ring-border",
    title: "Settings updated",
    description: () => "Operational defaults changed",
  },
};

interface ActivityFeedProps {
  className?: string;
  /** Max items to show. Defaults to 8. */
  limit?: number;
}

export function ActivityFeed({ className, limit = 8 }: ActivityFeedProps) {
  const { events } = useActivityFeed();
  const visible = events.slice(0, limit);

  return (
    <Card className={className}>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle>Live activity</CardTitle>
          <CardDescription>
            Realtime payments and team events.
          </CardDescription>
        </div>
        <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="relative grid size-2 place-items-center">
            <span className="absolute inset-0 rounded-full bg-success/40 animate-ping" />
            <span className="size-1.5 rounded-full bg-success" />
          </span>
          Live
        </span>
      </CardHeader>
      <CardContent>
        {visible.length === 0 ? (
          <EmptyState
            title="Waiting for activity"
            description="Payments, new orders, and team changes will appear here in realtime."
          />
        ) : (
          <ol className="relative space-y-3">
            <AnimatePresence initial={false}>
              {visible.map((event) => (
                <ActivityRow key={event.id} event={event} />
              ))}
            </AnimatePresence>
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function ActivityRow({ event }: { event: DomainEvent }) {
  const visual = VISUALS[event.type];
  if (!visual) return null;
  const Icon = visual.icon;
  const href = visual.href?.(event);

  const content = (
    <motion.li
      layout
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className={cn(
        "flex items-start gap-3 rounded-md px-2 py-2",
        "transition-colors",
        href && "cursor-pointer hover:bg-surface-1",
      )}
    >
      <span
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-md ring-1 ring-inset",
          visual.tone,
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-[13px] font-medium text-foreground truncate">
            {visual.title}
          </p>
          <span className="text-[11px] text-muted-foreground shrink-0">
            {formatRelative(event.at)}
          </span>
        </div>
        <p className="text-[12px] text-muted-foreground truncate">
          {visual.description(event)}
        </p>
      </div>
    </motion.li>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="block"
        prefetch={false}
      >
        {content}
      </Link>
    );
  }
  return content;
}
