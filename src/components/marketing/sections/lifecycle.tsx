import { MarketingSection, AccentWord } from "../section";
import { LifecycleCanvas } from "../mocks/lifecycle-canvas";

/**
 * Lifecycle chapter — the canonical order ledger.
 *
 * Embeds a live React rendition of the in-app lifecycle ledger
 * (same tabular pattern the evidence document uses). Replaces the
 * previous "left timeline + 12-card bento" composition — the model
 * is the model, demonstrated as one artifact rather than tiled out.
 */
export function Lifecycle() {
  return (
    <MarketingSection
      id="lifecycle"
      theme="sage"
      eyebrow="The lifecycle is the model"
      title={
        <>
          Every state of every order, captured in{" "}
          <AccentWord>one canonical chain.</AccentWord>
        </>
      }
      description="Operators stop asking 'is this paid yet'. The lifecycle is the answer — visible in realtime, derived from backend authority, with no UI shortcuts or optimistic guesses."
    >
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)] lg:items-start">
        <div data-reveal data-reveal-order={0} className="lg:sticky lg:top-32">
          <LifecycleCanvas />
        </div>

        <div className="space-y-8">
          <Note
            order={0}
            label="01"
            title="Backend authority, never UI optimism"
            body="Every status badge in the product derives from the canonical chain. The dashboard, the order detail, the dispute log all read the same record at the same time. No shadow store, no stale cache."
          />
          <Note
            order={1}
            label="02"
            title="Idempotent webhooks, atomic writes"
            body={
              <>
                Duplicate Stripe deliveries collapse to one transition.
                Retried reconciles are no-ops. Stamping a row as paid
                writes the audit, the event, and the outbox in a single{" "}
                <code className="font-mono text-[12px]">withTx</code>{" "}
                boundary.
              </>
            }
          />
          <Note
            order={2}
            label="03"
            title="Realtime push, polling backstop"
            body="The operator's surface receives SSE updates the moment the webhook fires. If the connection drops, the page falls back to short-interval polling — the canonical record never disagrees with what's on screen."
          />
          <Note
            order={3}
            label="04"
            title="Refund and failure paths preserve the chain"
            body="Refunded orders never delete. Failed orders never delete. Risk-flagged orders persist through archive. The lifecycle keeps its full shape, so a dispute six months later still has a complete artifact."
          />
        </div>
      </div>
    </MarketingSection>
  );
}

function Note({
  order,
  label,
  title,
  body,
}: {
  order: number;
  label: string;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div
      data-reveal
      data-reveal-order={order + 1}
      className="grid grid-cols-[2.25rem_1fr] items-baseline gap-x-3"
    >
      <span
        className="font-mono text-[10.5px] uppercase tracking-[0.14em]"
        style={{ color: "var(--m-eyebrow)" }}
      >
        {label}
      </span>
      <div className="space-y-1.5">
        <h3 className="text-[15.5px] font-semibold tracking-tight">
          {title}
        </h3>
        <p
          className="text-[13.5px] leading-relaxed"
          style={{ color: "var(--m-fg-soft)" }}
        >
          {body}
        </p>
      </div>
    </div>
  );
}
