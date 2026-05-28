import { LifecycleCanvas } from "../mocks/lifecycle-canvas";

/**
 * Lifecycle region — multi-tonal body notes.
 *
 * Sits in a soft inset surface so it visually contrasts from the
 * Evidence region above (white canvas) and the Gateways region below
 * (also white). Page rhythm: white → inset → white → inset → white,
 * not flat-white-everywhere.
 *
 * Each body note carries a semantic tonal identity:
 *   - Backend authority   green  (integrity)
 *   - Idempotent webhooks blue   (infrastructure)
 *   - Realtime push       cyan   (live signal)
 *   - Preserved chain     amber  (retention)
 */
export function LifecycleRegion() {
  return (
    <section
      id="lifecycle"
      className="scroll-mt-20 mt-20 sm:mt-28 -mx-6 lg:-mx-10 px-6 lg:px-10 py-16 sm:py-20"
      style={{ background: "var(--surface-1)" }}
    >
      <div className="grid grid-cols-1 gap-x-10 gap-y-10 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] lg:items-start">
        <div className="lg:sticky lg:top-20">
          <LifecycleCanvas />
        </div>

        <div className="space-y-7">
          <p className="text-[15.5px] leading-relaxed text-foreground">
            One lifecycle, ten states, one source of truth. Operators stop
            asking{" "}
            <span className="italic">is this paid yet</span> — the answer
            is the chain, visible in realtime.
          </p>

          <BodyNote
            tone="success"
            label="Backend authority"
            title="Backend authority, never UI optimism"
            body="Every status badge in TraceTxn derives from the canonical chain. The dashboard, the order detail, and the dispute log all read the same record at the same time. No shadow store."
          />
          <BodyNote
            tone="info"
            label="Atomic writes"
            title="Idempotent webhooks, atomic writes"
            body={
              <>
                Duplicate Stripe deliveries collapse to one transition.
                Stamping a row as paid writes the audit, the event, and
                the outbox in a single{" "}
                <code className="font-mono text-[12px]">withTx</code>{" "}
                boundary.
              </>
            }
          />
          <BodyNote
            tone="cyan"
            label="Live signal"
            title="Realtime push, polling backstop"
            body="The operator's surface receives SSE updates the moment the webhook fires. If the connection drops, polling fills the gap — the canonical record never disagrees with what's on screen."
          />
          <BodyNote
            tone="warning"
            label="Retention"
            title="Refunds and failures preserve the chain"
            body="Refunded orders never delete. Failed orders never delete. Risk-flagged orders persist through archive. A dispute six months later still has a complete artifact."
          />
        </div>
      </div>
    </section>
  );
}

function BodyNote({
  tone,
  label,
  title,
  body,
}: {
  tone: "success" | "info" | "cyan" | "warning";
  label: string;
  title: string;
  body: React.ReactNode;
}) {
  const labelColor =
    tone === "success"
      ? "var(--success-strong)"
      : tone === "info"
        ? "var(--info)"
        : tone === "cyan"
          ? "oklch(0.62 0.14 200)"
          : "oklch(0.52 0.15 78)";
  const dotColor =
    tone === "success"
      ? "var(--success)"
      : tone === "info"
        ? "var(--info)"
        : tone === "cyan"
          ? "oklch(0.7 0.16 200)"
          : "var(--warning)";
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-3">
      <span
        aria-hidden
        className="mt-2 size-1.5 rounded-full shrink-0"
        style={{ background: dotColor }}
      />
      <div>
        <p
          className="font-mono text-[10.5px] uppercase tracking-[0.14em]"
          style={{ color: labelColor }}
        >
          {label}
        </p>
        <h3 className="mt-1 text-[14.5px] font-semibold tracking-tight">
          {title}
        </h3>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">
          {body}
        </p>
      </div>
    </div>
  );
}
