import { LifecycleCanvas } from "../mocks/lifecycle-canvas";

/**
 * Lifecycle region — different column ratio from Evidence above it
 * (canvas-left, prose-right rather than prose-above, canvas-below)
 * so the page rhythm shifts as the visitor scrolls.
 *
 * The model is the model: lifecycle ledger embedded inline, prose
 * alongside, no section header chrome.
 */
export function LifecycleRegion() {
  return (
    <section id="lifecycle" className="scroll-mt-20 pt-20 sm:pt-28">
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
            label="Backend authority, never UI optimism"
            body="Every status badge in TraceTxn derives from the canonical chain. The dashboard, the order detail, and the dispute log all read the same record at the same time. No shadow store."
          />
          <BodyNote
            label="Idempotent webhooks, atomic writes"
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
            label="Realtime push, polling backstop"
            body="The operator's surface receives SSE updates the moment the webhook fires. If the connection drops, polling fills the gap — the canonical record never disagrees with what's on screen."
          />
          <BodyNote
            label="Refunds and failures preserve the chain"
            body="Refunded orders never delete. Failed orders never delete. Risk-flagged orders persist through archive. A dispute six months later still has a complete artifact."
          />
        </div>
      </div>
    </section>
  );
}

function BodyNote({
  label,
  body,
}: {
  label: string;
  body: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-[14.5px] font-semibold tracking-tight">{label}</h3>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">
        {body}
      </p>
    </div>
  );
}
