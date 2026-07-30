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
 *   [LIVE|TEST badge]  [Workspace]  [System health]  [SSE]
 *   [Region]  [UTC clock]  [Operator]
 *
 * Heights stay tight (28px). Type is monospace, 10.5px, uppercase
 * with letter-spacing, the visual signature of an ops console.
 *
 * Health is REAL, not decorative: the SYS badge polls `/api/health` (public)
 * every 60s and reflects healthy / degraded / unhealthy — so a rejected email
 * key or an unreachable DB shows here instead of a fabricated green. (The old
 * strip hard-coded Stripe/WH/Q to "OK" and read green straight through a live
 * outage.) SSE state is live via useRealtimeStatus; LIVE/TEST is detected from
 * the Stripe publishable-key env at first render.
 */

export interface TelemetryStripProps {
  workspace: string;
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
  // Read the NEXT_PUBLIC key directly — it's inlined on BOTH server and
  // client, so the result is identical on each. The old `typeof window`
  // guard made the server always return "test" while the client returned
  // "live", which is a guaranteed hydration mismatch (#418).
  const k = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";
  return k.startsWith("pk_live_") ? "live" : "test";
}

export function TelemetryStrip({
  workspace,
  env,
  operatorLabel,
  region = "US-East",
}: TelemetryStripProps) {
  const realtime = useRealtimeStatus();
  const health = useSystemHealth();
  const mode = env ?? detectEnv();

  // UTC clock, ticks every 15s. Operators glance at it constantly
  // when correlating webhook timestamps. Tight format `12:34 UTC`.
  //
  // Seeded with a STABLE placeholder rather than `formatUtc(new Date())`:
  // the initializer runs on the server (SSR) and again on the client at
  // hydration, and those two moments differ — so the rendered clock text
  // didn't match, tripping React hydration error #418 across every authed
  // page. The real time is filled in right after mount (deferred so no
  // state is set synchronously in the effect), then ticks.
  const [now, setNow] = React.useState<string>("--:-- UTC");
  React.useEffect(() => {
    const tick = () => setNow(formatUtc(new Date()));
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, 15_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
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
        <HealthBadge label="SYS" tone={health.tone} value={health.label} />
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
  value,
}: {
  label: string;
  tone: "ok" | "degraded" | "down" | "unknown";
  /** Overrides the default tone label (e.g. "Degraded" instead of "Slow"). */
  value?: string;
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
        {value ?? t.label}
      </span>
    </span>
  );
}

/* ─── Real system health (polls /api/health) ───────────────────── */

type HealthTone = "ok" | "degraded" | "down" | "unknown";

/**
 * Polls the public `/api/health` endpoint and maps its `data.status` to a
 * telemetry tone. Kept deliberately cheap: one fetch on mount then every 60s,
 * and the endpoint itself is process-cached server-side. Never throws — a
 * failed probe reads as "unknown" (dash), never a false "OK".
 */
function useSystemHealth(): { tone: HealthTone; label: string } {
  const [state, setState] = React.useState<{ tone: HealthTone; label: string }>(
    { tone: "unknown", label: "…" },
  );
  React.useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const json = (await res.json()) as { data?: { status?: string } };
        if (!alive) return;
        const status = json?.data?.status;
        setState(
          status === "healthy"
            ? { tone: "ok", label: "OK" }
            : status === "degraded"
              ? { tone: "degraded", label: "Degraded" }
              : status === "unhealthy"
                ? { tone: "down", label: "Down" }
                : { tone: "unknown", label: "-" },
        );
      } catch {
        if (alive) setState({ tone: "unknown", label: "-" });
      }
    };
    void check();
    const id = window.setInterval(() => void check(), 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  return state;
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
