"use client";

import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowRightIcon,
  BanknoteIcon,
  FileTextIcon,
  LinkIcon,
  PaperclipIcon,
  ReceiptIcon,
  RotateCcwIcon,
  ScaleIcon,
  ShieldCheckIcon,
  UserPlusIcon,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import { formatCurrency, formatDateTime, formatRelative } from "@/lib/format";

/** Mirror of `TimelineEventDTO` from the client-profile service. */
export interface TimelineEvent {
  id: string;
  kind: string;
  category:
    | "client"
    | "order"
    | "payment"
    | "refund"
    | "consent"
    | "document"
    | "dispute"
    | "file"
    | "link";
  title: string;
  detail: string | null;
  at: string;
  orderId: string | null;
  orderNumber: string | null;
  amount: number | null;
  currency: string | null;
  status: string | null;
}

type Category = TimelineEvent["category"];

const META: Record<
  Category,
  { label: string; icon: LucideIcon; dot: string; ring: string }
> = {
  client: {
    label: "Client",
    icon: UserPlusIcon,
    dot: "bg-surface-2 text-muted-foreground",
    ring: "ring-border",
  },
  order: {
    label: "Orders",
    icon: ReceiptIcon,
    dot: "bg-info-soft text-info",
    ring: "ring-info-border/60",
  },
  payment: {
    label: "Payments",
    icon: BanknoteIcon,
    dot: "bg-success-soft text-success",
    ring: "ring-success-border/60",
  },
  refund: {
    label: "Refunds",
    icon: RotateCcwIcon,
    dot: "bg-warning-soft text-warning-foreground",
    ring: "ring-warning-border/60",
  },
  consent: {
    label: "Consent",
    icon: ShieldCheckIcon,
    dot: "bg-info-soft text-info",
    ring: "ring-info-border/60",
  },
  document: {
    label: "Documents",
    icon: FileTextIcon,
    dot: "bg-surface-2 text-foreground",
    ring: "ring-border",
  },
  dispute: {
    label: "Disputes",
    icon: ScaleIcon,
    dot: "bg-destructive-soft text-destructive",
    ring: "ring-destructive-border/60",
  },
  file: {
    label: "Files",
    icon: PaperclipIcon,
    dot: "bg-info-soft text-info",
    ring: "ring-info-border/60",
  },
  link: {
    label: "Links",
    icon: LinkIcon,
    dot: "bg-surface-2 text-foreground",
    ring: "ring-border",
  },
};

const ORDER: Category[] = [
  "client",
  "order",
  "payment",
  "refund",
  "consent",
  "document",
  "file",
  "link",
  "dispute",
];

interface ClientTimelineProps {
  events: TimelineEvent[];
}

/**
 * The client's cross-entity history as a single scrollable stream:
 * orders, payments, refunds, consent, documents, disputes — newest
 * first. Category chips filter the stream in place; the list animates
 * as the filter changes so the operator keeps their bearings.
 *
 * Data is fetched server-side and passed in; this component owns only
 * the presentation + filter state (no client fetch, no dead-ends).
 */
export function ClientTimeline({ events }: ClientTimelineProps) {
  const [active, setActive] = useState<Category | "all">("all");

  // Only offer chips for categories that actually occur — no dead filters.
  const present = useMemo(() => {
    const set = new Set(events.map((e) => e.category));
    return ORDER.filter((c) => set.has(c));
  }, [events]);

  const filtered = useMemo(
    () => (active === "all" ? events : events.filter((e) => e.category === active)),
    [events, active],
  );

  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card/40 p-10 text-center">
        <p className="text-sm font-medium text-foreground">No activity yet</p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Orders, payments, files, and links will appear here as they
          happen.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        <Chip
          label="All"
          count={events.length}
          active={active === "all"}
          onClick={() => setActive("all")}
        />
        {present.map((c) => (
          <Chip
            key={c}
            label={META[c].label}
            count={events.filter((e) => e.category === c).length}
            active={active === c}
            onClick={() => setActive(c)}
          />
        ))}
      </div>

      <ol className="relative space-y-1">
        {/* The rail runs down the centre of the icon nodes. */}
        <span
          aria-hidden
          className="absolute left-[15px] top-2 bottom-2 w-px bg-border"
        />
        <AnimatePresence mode="popLayout">
          {filtered.map((e, i) => (
            <motion.li
              key={e.id}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{
                duration: 0.24,
                delay: Math.min(i * 0.015, 0.3),
                ease: [0.22, 1, 0.36, 1],
              }}
              className="relative flex gap-3 rounded-md px-1 py-2"
            >
              <Node category={e.category} />
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-[13px] font-medium text-foreground">
                    {e.title}
                  </span>
                  {e.amount != null && e.currency ? (
                    <span
                      className={cn(
                        "text-[12.5px] font-semibold tabular-nums",
                        e.category === "refund"
                          ? "text-warning-foreground"
                          : e.category === "payment"
                            ? "text-success"
                            : "text-foreground",
                      )}
                    >
                      {formatCurrency(e.amount, e.currency)}
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-muted-foreground">
                  {/* Relative time is derived from the client clock, so it
                      can legitimately differ from the SSR render — suppress
                      the (harmless) hydration diff rather than freeze a
                      stale value. */}
                  <time
                    dateTime={e.at}
                    title={formatDateTime(e.at)}
                    suppressHydrationWarning
                  >
                    {formatRelative(e.at)}
                  </time>
                  {e.detail ? (
                    <>
                      <span aria-hidden>·</span>
                      <span className="truncate">{e.detail}</span>
                    </>
                  ) : null}
                  {e.orderId ? (
                    <Link
                      href={`/app/orders/${e.orderId}`}
                      className="inline-flex items-center gap-0.5 text-foreground/80 hover:text-foreground hover:underline"
                    >
                      View order
                      <ArrowRightIcon className="size-3" />
                    </Link>
                  ) : null}
                </div>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
    </div>
  );
}

function Node({ category }: { category: Category }) {
  const m = META[category];
  const Icon = m.icon;
  return (
    <span
      className={cn(
        "relative z-10 grid size-8 shrink-0 place-items-center rounded-full ring-1 ring-inset",
        m.dot,
        m.ring,
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}

function Chip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium ring-1 ring-inset transition-colors",
        active
          ? "bg-primary text-primary-foreground ring-primary/15"
          : "bg-surface-1 text-muted-foreground ring-border hover:text-foreground",
      )}
    >
      {label}
      <span
        className={cn(
          "tabular-nums",
          active ? "text-primary-foreground/80" : "text-muted-foreground/70",
        )}
      >
        {count}
      </span>
    </button>
  );
}
