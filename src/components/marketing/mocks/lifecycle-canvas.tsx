import { CheckIcon } from "lucide-react";

/**
 * Marketing canvas — order lifecycle ledger.
 *
 * Static React mock that mirrors the in-app evidence timeline pattern
 * — tabular ledger rows, no per-event icons, mono timestamps, tight
 * line-height. Used in the landing's Lifecycle chapter to demonstrate
 * the canonical model without reaching for a screenshot.
 */

interface Stage {
  seq: string;
  label: string;
  meta: string;
  time: string;
  state: "done" | "current" | "pending";
}

const STAGES: Stage[] = [
  {
    seq: "01",
    label: "Order created",
    meta: "Agent · Mira Holst",
    time: "08:13:35",
    state: "done",
  },
  {
    seq: "02",
    label: "Gateway selected",
    meta: "Stripe · frozen for this order",
    time: "08:13:53",
    state: "done",
  },
  {
    seq: "03",
    label: "Payment link generated",
    meta: "Session cs_test_a1B2c3…",
    time: "08:13:53",
    state: "done",
  },
  {
    seq: "04",
    label: "Email sent",
    meta: "Consent record created in lockstep",
    time: "08:14:46",
    state: "done",
  },
  {
    seq: "05",
    label: "Consent received",
    meta: "Customer · IP 73.114.142.18",
    time: "08:21:22",
    state: "done",
  },
  {
    seq: "06",
    label: "Payment started",
    meta: "Customer reached the gateway",
    time: "08:21:30",
    state: "done",
  },
  {
    seq: "07",
    label: "Paid",
    meta: "Webhook reconciled · pi_3R7kx2KZ4m…",
    time: "08:21:35",
    state: "current",
  },
  {
    seq: "08",
    label: "Confirmation sent",
    meta: "Receipt delivered via durable outbox",
    time: "08:21:35",
    state: "pending",
  },
  {
    seq: "09",
    label: "Refunded / Failed",
    meta: "Refund + failure paths preserve the chain",
    time: "—",
    state: "pending",
  },
];

export function LifecycleCanvas() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-[0_24px_60px_-32px_rgba(0,0,0,0.35)]">
      {/* Header band — matches case-file's dark cover sheet so the
          two surfaces feel like one design system. */}
      <div className="border-b border-white/10 bg-[oklch(0.13_0.012_286)] px-5 py-4 text-white">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
          tracetxn · order lifecycle
        </p>
        <p className="mt-1.5 font-mono text-[14px] tracking-tight tabular-nums">
          ORD-260805-K4M9P2RT3W
        </p>
        <p className="mt-1 font-mono text-[10.5px] text-white/55 tabular-nums">
          One canonical chain · backend authority · realtime push
        </p>
      </div>

      <div className="px-5 py-5">
        <div className="flex items-baseline justify-between border-b border-border/70 pb-1.5">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Lifecycle ledger
          </h3>
          <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
            10 canonical states
          </span>
        </div>

        <ol className="mt-3 divide-y divide-border/60">
          {STAGES.map((s) => (
            <li
              key={s.seq}
              className="grid grid-cols-[1.75rem_1fr_auto_1rem] items-baseline gap-x-3 py-2"
            >
              <span
                className={`font-mono text-[11px] tabular-nums ${
                  s.state === "pending"
                    ? "text-muted-foreground/50"
                    : "text-muted-foreground"
                }`}
              >
                {s.seq}
              </span>
              <div className="min-w-0">
                <p
                  className={`text-[12px] leading-tight ${
                    s.state === "current"
                      ? "font-semibold"
                      : s.state === "pending"
                        ? "text-muted-foreground/70"
                        : "font-medium"
                  }`}
                >
                  {s.label}
                </p>
                <p
                  className={`mt-0.5 truncate text-[10.5px] leading-snug ${
                    s.state === "pending"
                      ? "text-muted-foreground/50"
                      : "text-muted-foreground"
                  }`}
                >
                  {s.meta}
                </p>
              </div>
              <span
                className={`font-mono text-[10.5px] tabular-nums ${
                  s.state === "pending"
                    ? "text-muted-foreground/50"
                    : "text-muted-foreground"
                }`}
              >
                {s.time}
              </span>
              <Marker state={s.state} />
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function Marker({ state }: { state: Stage["state"] }) {
  if (state === "done") {
    return (
      <CheckIcon
        className="size-3 text-success justify-self-end"
        aria-hidden
      />
    );
  }
  if (state === "current") {
    return (
      <span
        aria-hidden
        className="justify-self-end inline-block size-2 rounded-full bg-success"
        style={{ animation: "pulse-soft 2.4s ease-in-out infinite" }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="justify-self-end inline-block size-1.5 rounded-full bg-border"
    />
  );
}
