"use client";

import * as React from "react";

import { useRealtimeStatus } from "@/components/providers/realtime-provider";
import { cn } from "@/lib/utils";

/**
 * TelemetryStrip, high-density status bar that lives ABOVE the
 * topbar. Reads like Bloomberg-terminal infrastructure telemetry,
 * not SaaS chrome.
 *
 * Layout (left→right):
 *   [LIVE|TEST badge]  [Workspace]  [Stripe health]  [Webhook health]
 *   [Queue]  [SSE]  [Region]  [UTC clock]  [Operator]
 *
 * Heights stay tight (28px). Type is monospace, 10.5px, uppercase
 * with letter-spacing, the visual signature of an ops console.
 *
 * Health indicators are presentational (dot + label). Real backends
 * for Stripe / webhook / queue health are wired separately and
 * stream into this component via props when available; defaults
 * read "OK" so the strip never *lies*, it shows the conservative
 * default until a real signal supersedes it.
 *
 * Pure client-side; no API calls. The SSE state is the only real
 * live data here today (via useRealtimeStatus). LIVE/TEST is
 * detected from the Stripe publishable-key env at first render.
 */

export interface TelemetryStripProps {
  workspace: string;
  /** Optional override; defaults to "OK" / "live". */
  stripe?: "ok" | "degraded" | "down" | "unknown";
  webhook?: "ok" | "degraded" | "down" | "unknown";
  queue?: "ok" | "degraded" | "down" | "unknown";
  /** Optional explicit env mode. Defaults to detection from the
   *  Stripe publishable-key prefix at render time. */
  env?: "live" | "test";
  /** Operator label (typically the signed-in user's name + role).
   *  Right-aligned so the operator's identity is always visible
   *  without taking focus from the workflow on the left. */
  operatorLabel?: string;
  /** Region/zone hint (e.g. "US-East", "PROD-A"). */
  region?: string;
}

const TONE: Record<
  "ok" | "degraded" | "down" | "unknown",
  { dot: string; label: string }
> = {
  ok: { dot: "bg-success", label: "OK" },
  degraded: { dot: "bg-warning", label: "Slow" },
  down: { dot: "bg-destructive", label: "Down" },
  unknown: { dot: "bg-muted-foreground/50", label: "-" },
};

function detectEnv(): "live" | "test" {
  if (typeof window === "undefined") return "test";
  const k = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";
  return k.startsWith("pk_live_") ? "live" : "test";
}

export function TelemetryStrip({
  workspace,
  stripe = "ok",
  webhook = "ok",
  queue = "ok",
  env,
  operatorLabel,
  region = "US-East",
}: TelemetryStripProps) {
  const realtime = useRealtimeStatus();
  const mode = env ?? detectEnv();

  // UTC clock, ticks every 15s. Operators glance at it constantly
  // when correlating webhook timestamps. Tight format `12:34Z`.
  const [now, setNow] = React.useState<string>(() => formatUtc(new Date()));
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(formatUtc(new Date())), 15_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div
      data-slot="telemetry-strip"
      className={cn(
        "hidden md:flex h-7 shrink-0 items-center gap-0",
        // Inset hairline border + faint top accent stroke. Visually
        // partitions infrastructure status from app chrome below.
        "relative border-b border-border bg-surface-1/80",
        "font-mono text-[10.5px] uppercase leading-none tracking-[0.08em] text-muted-foreground",
      )}
      role="status"
      aria-label="System telemetry"
    >
      {/* Faint top accent stroke, single brand-color hairline.
          Drops the old marketing-gradient (orange/cobalt/ultraviolet)
          in favor of TraceTxn's emerald identity, consistent with
          the landing's document chrome. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px opacity-70"
        style={{
          background:
            "linear-gradient(90deg, transparent 0%, var(--success) 50%, transparent 100%)",
        }}
      />

      <Cell>
        <EnvBadge mode={mode} />
      </Cell>
      <Cell>
        <span className="text-foreground/85 normal-case tracking-[0.04em]">
          {workspace}
        </span>
      </Cell>
      <Cell>
        <HealthBadge label="Stripe" tone={stripe} />
      </Cell>
      <Cell>
        <HealthBadge label="WH" tone={webhook} />
      </Cell>
      <Cell>
        <HealthBadge label="Q" tone={queue} />
      </Cell>
      <Cell>
        <RealtimeDot status={realtime} />
      </Cell>

      <span className="ml-auto flex h-full items-center">
        <Cell>
          <span>{region}</span>
        </Cell>
        <Cell>
          <span className="text-foreground/85 normal-case tabular-nums tracking-normal">
            {now}
          </span>
        </Cell>
        {operatorLabel ? (
          <Cell last>
            <span className="text-foreground/85 normal-case tracking-[0.04em]">
              {operatorLabel}
            </span>
          </Cell>
        ) : null}
      </span>
    </div>
  );
}

/* ─── Cell primitive ───────────────────────────────────────────── */

function Cell({
  children,
  last = false,
}: {
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex h-full items-center gap-1.5 px-3",
        !last && "border-r border-border/70",
      )}
    >
      {children}
    </span>
  );
}

/* ─── LIVE / TEST badge ────────────────────────────────────────── */

function EnvBadge({ mode }: { mode: "live" | "test" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm px-1.5 py-px",
        "text-[10px] font-semibold tracking-[0.12em]",
        mode === "live"
          ? "bg-success-soft text-success ring-1 ring-inset ring-success/30"
          : "bg-warning-soft text-warning-foreground ring-1 ring-inset ring-warning/40",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          mode === "live" ? "bg-success" : "bg-warning",
        )}
        // Only LIVE mode pulses, TEST mode stays static so operators
        // don't read it as "active live traffic".
        style={
          mode === "live"
            ? { animation: "pulse-soft 2.4s ease-in-out infinite" }
            : undefined
        }
      />
      {mode === "live" ? "LIVE" : "TEST"}
    </span>
  );
}

/* ─── Generic health badge ─────────────────────────────────────── */

function HealthBadge({
  label,
  tone,
}: {
  label: string;
  tone: "ok" | "degraded" | "down" | "unknown";
}) {
  const t = TONE[tone];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-1.5 rounded-full", t.dot)} />
      <span className="text-foreground/70">{label}</span>
      <span className="text-muted-foreground/70">·</span>
      <span
        className={cn(
          tone === "ok"
            ? "text-success"
            : tone === "degraded"
              ? "text-warning-foreground"
              : tone === "down"
                ? "text-destructive"
                : "text-muted-foreground/80",
        )}
      >
        {t.label}
      </span>
    </span>
  );
}

/* ─── SSE realtime dot (compact) ──────────────────────────────── */

function RealtimeDot({
  status,
}: {
  status: "live" | "connecting" | "reconnecting" | "offline";
}) {
  const t = {
    live: { dot: "bg-success", text: "text-success", label: "LIVE" },
    connecting: {
      dot: "bg-muted-foreground/50",
      text: "text-muted-foreground",
      label: "…",
    },
    reconnecting: {
      dot: "bg-warning",
      text: "text-warning-foreground",
      label: "RECON",
    },
    offline: {
      dot: "bg-destructive",
      text: "text-destructive",
      label: "OFFLINE",
    },
  }[status];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn("size-1.5 rounded-full", t.dot)}
        style={
          status === "live"
            ? { animation: "pulse-soft 2.6s ease-in-out infinite" }
            : undefined
        }
      />
      <span className="text-foreground/70">SSE</span>
      <span className="text-muted-foreground/70">·</span>
      <span className={t.text}>{t.label}</span>
    </span>
  );
}

/* ─── UTC clock ────────────────────────────────────────────────── */

function formatUtc(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}
