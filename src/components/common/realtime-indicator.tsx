"use client";

import * as React from "react";

import { Spinner } from "@/components/ui/spinner";
import { useRealtimeStatus } from "@/components/providers/realtime-provider";
import { cn } from "@/lib/utils";

interface RealtimeIndicatorProps {
  className?: string;
  /** Show explanatory text next to the dot. Defaults to true. */
  withLabel?: boolean;
}

/**
 * Compact realtime status badge. Three states:
 *  - "live"         → soft green pulse + "Live"
 *  - "connecting"   → muted spinner + "Connecting"
 *  - "reconnecting" → warning spinner + "Reconnecting"
 *  - "offline"      → red dot + "Offline"
 *
 * Designed to live in tight chrome — page headers, card titles, footers.
 * Visual weight scales down with the surrounding text.
 */
export function RealtimeIndicator({
  className,
  withLabel = true,
}: RealtimeIndicatorProps) {
  const status = useRealtimeStatus();

  const config = {
    live: {
      tone: "text-success",
      label: "Live",
      kind: "dot" as const,
    },
    connecting: {
      tone: "text-muted-foreground",
      label: "Connecting",
      kind: "spinner" as const,
    },
    reconnecting: {
      tone: "text-warning-foreground",
      label: "Reconnecting",
      kind: "spinner" as const,
    },
    offline: {
      tone: "text-destructive",
      label: "Offline",
      kind: "static" as const,
    },
  }[status];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[11px]",
        config.tone,
        className,
      )}
      data-state={status}
      aria-live="polite"
    >
      {config.kind === "dot" ? (
        <span className="pulse-dot" aria-hidden />
      ) : config.kind === "spinner" ? (
        <Spinner size="xs" tone="current" label={config.label} />
      ) : (
        <span
          aria-hidden
          className="inline-block size-1.5 rounded-full bg-current"
        />
      )}
      {withLabel ? <span>{config.label}</span> : null}
    </span>
  );
}
