import { CheckIcon } from "lucide-react";

/**
 * Lifecycle canvas — order lifecycle ledger with numbered green
 * ring nodes. Same operational identity element the case-file
 * timeline uses; here applied to the canonical-state lifecycle.
 *
 * States are styled by `state`:
 *   done     — filled green ring with white check
 *   current  — filled green ring with white number + outer pulse
 *   pending  — outlined green ring with muted number
 *
 * Connector line runs solid green between done/current states and
 * fades to a quieter green for the pending tail — the chain
 * continues but hasn't been written yet.
 */

interface Stage {
  seq: number;
  label: string;
  meta: string;
  time: string;
  state: "done" | "current" | "pending";
}

const STAGES: Stage[] = [
  { seq: 1, label: "Order created", meta: "Agent · Mira Holst", time: "08:13:35", state: "done" },
  { seq: 2, label: "Gateway selected", meta: "Stripe · frozen for this order", time: "08:13:53", state: "done" },
  { seq: 3, label: "Payment link generated", meta: "Session cs_test_a1B2c3…", time: "08:13:53", state: "done" },
  { seq: 4, label: "Email sent", meta: "Consent record created in lockstep", time: "08:14:46", state: "done" },
  { seq: 5, label: "Consent received", meta: "Customer · IP 73.114.142.18", time: "08:21:22", state: "done" },
  { seq: 6, label: "Payment started", meta: "Customer reached the gateway", time: "08:21:30", state: "done" },
  { seq: 7, label: "Paid", meta: "Webhook reconciled · pi_3R7kx2KZ4m…", time: "08:21:35", state: "current" },
  { seq: 8, label: "Confirmation sent", meta: "Receipt delivered via durable outbox", time: "—", state: "pending" },
  { seq: 9, label: "Refunded / Failed", meta: "Refund + failure paths preserve the chain", time: "—", state: "pending" },
];

export function LifecycleCanvas() {
  return (
    <div
      className="relative overflow-hidden rounded-2xl shadow-[0_24px_60px_-32px_rgba(15,40,80,0.3)]"
      style={{ background: "oklch(0.97 0.005 240)" }}
    >
      {/* Dark navy header band */}
      <header
        className="border-b border-white/10 px-6 py-5 text-white sm:px-7"
        style={{ background: "var(--ink-navy)" }}
      >
        <p className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-white/55">
          TraceTxn · order lifecycle
        </p>
        <p className="mt-1.5 font-mono text-[14px] tracking-tight tabular-nums">
          ORD-260805-K4M9P2RT3W
        </p>
        <p className="mt-1 font-mono text-[11px] text-white/60 tabular-nums">
          One canonical chain · backend authority · realtime push
        </p>
      </header>

      <div className="p-5 sm:p-6">
        <div className="flex items-baseline justify-between pb-2 border-b border-border/70">
          <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Lifecycle ledger
          </p>
          <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
            10 canonical states
          </span>
        </div>

        <ol className="relative mt-4">
          {/* Connector line — solid green through "done" zone,
              quieter green through pending tail. Two stacked lines. */}
          <span
            aria-hidden
            className="pointer-events-none absolute left-[0.875rem] top-3 w-[2.5px] rounded-full"
            style={{
              background: "var(--success)",
              height: "calc(7 * 44px)",
            }}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute left-[0.875rem] w-[2.5px] rounded-full"
            style={{
              background: "var(--success-border)",
              top: "calc(7 * 44px + 12px)",
              bottom: "12px",
            }}
          />
          {STAGES.map((s) => (
            <li
              key={s.seq}
              className="relative grid grid-cols-[1.75rem_1fr_auto] items-start gap-x-3 py-[7px]"
            >
              <LifecycleNode state={s.state} seq={s.seq} />
              <div className="pt-0.5 min-w-0">
                <p
                  className={`text-[12.5px] leading-tight ${
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
                  className={`mt-0.5 truncate font-mono text-[10.5px] leading-snug ${
                    s.state === "pending"
                      ? "text-muted-foreground/55"
                      : "text-muted-foreground"
                  }`}
                >
                  {s.meta}
                </p>
              </div>
              <span
                className={`pt-1 font-mono text-[10.5px] tabular-nums ${
                  s.state === "pending"
                    ? "text-muted-foreground/55"
                    : "text-muted-foreground"
                }`}
              >
                {s.time}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function LifecycleNode({
  state,
  seq,
}: {
  state: Stage["state"];
  seq: number;
}) {
  if (state === "done") {
    return (
      <span
        className="relative z-10 grid size-7 place-items-center rounded-full text-white"
        style={{ background: "var(--success)" }}
      >
        <CheckIcon className="size-3.5" strokeWidth={3} />
      </span>
    );
  }
  if (state === "current") {
    return (
      <span
        className="relative z-10 grid size-7 place-items-center rounded-full text-[10.5px] font-semibold text-white shadow-[0_0_0_3px_oklch(0.62_0.17_148_/_0.25)]"
        style={{ background: "var(--success)" }}
      >
        {seq}
      </span>
    );
  }
  return (
    <span
      className="relative z-10 grid size-7 place-items-center rounded-full bg-background text-[10.5px] font-medium"
      style={{
        border: "1.5px solid var(--success-border)",
        color: "var(--muted-foreground)",
      }}
    >
      {seq}
    </span>
  );
}
