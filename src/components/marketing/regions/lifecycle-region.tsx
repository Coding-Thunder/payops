import {
  ArchiveIcon,
  CheckCircle2Icon,
  DatabaseIcon,
  RadioTowerIcon,
  ZapIcon,
} from "lucide-react";

import { LifecycleCanvas } from "../mocks/lifecycle-canvas";

/**
 * Lifecycle region, brand-v1 rebuild.
 *
 * Replaces the document-style sticky-canvas + vertical body-notes
 * layout with the same card-grid vocabulary used on Pricing /
 * Security: cloud band background, emerald eyebrow chip, navy
 * headline with an emerald accent, then a four-card grid below the
 * featured LifecycleCanvas. All four cards on the same emerald rail,
 * the cyan / amber per-tone palette from the pre-brand-v1 version
 * dropped (brand-v1 is navy + emerald + slate).
 */

interface LifecyclePillar {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  points: string[];
}

const PILLARS: LifecyclePillar[] = [
  {
    icon: DatabaseIcon,
    title: "Backend authority, never UI optimism",
    body: "Every status badge in TraceTxn derives from the canonical chain. The dashboard, the order detail, and the dispute log all read the same record at the same time. No shadow store.",
    points: [
      "One canonical row per order, queried by every surface",
      "No client-side state that diverges from server truth",
      "Dispute review and customer page read the same record",
    ],
  },
  {
    icon: ZapIcon,
    title: "Idempotent webhooks, atomic writes",
    body: "Duplicate Stripe deliveries collapse to one transition. Stamping a row as paid writes the audit, the event, and the outbox inside a single transaction boundary.",
    points: [
      "Webhook dedupe at the processed_webhook_events collection",
      "Status, audit, event, outbox in one withTx() call",
      "Concurrent webhook + reconcile races collapse at the index",
    ],
  },
  {
    icon: RadioTowerIcon,
    title: "Realtime push, polling backstop",
    body: "The operator's surface receives SSE updates the moment the webhook fires. If the connection drops, polling fills the gap so the canonical record never disagrees with what's on screen.",
    points: [
      "Per-tenant SSE channel scoped to the actor's org",
      "Order-detail queries auto-poll while status is non-terminal",
      "Reconnect on tab focus, no missed transitions on sleep",
    ],
  },
  {
    icon: ArchiveIcon,
    title: "Refunds and failures preserve the chain",
    body: "Refunded orders never delete. Failed orders never delete. Risk-flagged orders persist through archive. A dispute six months later still has a complete artifact.",
    points: [
      "Append-only evidence rows enforced at the model layer",
      "Archive flips state, never removes the chain",
      "Hash-linked events let the bank re-verify integrity",
    ],
  },
];

export function LifecycleRegion() {
  return (
    <section
      id="lifecycle"
      className="scroll-mt-20 -mx-6 lg:-mx-10 px-6 lg:px-10 py-20 sm:py-24 mt-20 sm:mt-28"
      style={{ background: "var(--background)" }}
    >
      <div className="mx-auto max-w-[1280px]">
        {/* Header */}
        <div className="max-w-3xl">
          <p className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-3 py-1 font-display text-[10.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ background: "var(--brand-emerald)" }}
            />
            Lifecycle
          </p>
          <h2 className="mt-6 font-display text-[clamp(1.8rem,4vw,2.8rem)] font-medium leading-[1.08] tracking-[-0.022em]">
            One lifecycle, one source of truth.{" "}
            <span className="font-semibold text-[color:var(--brand-emerald)]">
              Visible in realtime.
            </span>
          </h2>
          <p className="mt-5 max-w-xl text-[14.5px] leading-relaxed text-muted-foreground">
            Operators stop asking &ldquo;is this paid yet&rdquo;, the answer
            is the chain. Ten states, one canonical record, every surface
            reading the same row.
          </p>
        </div>

        {/* Featured canvas strip */}
        <div className="mt-12 rounded-2xl border border-border bg-white p-4 shadow-sm sm:p-6">
          <LifecycleCanvas />
        </div>

        {/* Pillar grid */}
        <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-2">
          {PILLARS.map((p) => (
            <PillarCard key={p.title} pillar={p} />
          ))}
        </div>
      </div>
    </section>
  );
}

function PillarCard({ pillar }: { pillar: LifecyclePillar }) {
  const Icon = pillar.icon;
  return (
    <div className="rounded-2xl border border-border bg-white p-6">
      <span
        className="inline-flex size-10 items-center justify-center rounded-lg"
        style={{
          background:
            "color-mix(in oklch, var(--brand-emerald) 12%, white)",
          color: "var(--brand-emerald-strong)",
        }}
      >
        <Icon className="size-5" />
      </span>
      <h3 className="mt-4 font-display text-[16px] font-semibold tracking-tight">
        {pillar.title}
      </h3>
      <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
        {pillar.body}
      </p>
      <ul className="mt-4 space-y-1.5 text-[12.5px]">
        {pillar.points.map((p) => (
          <li key={p} className="flex items-start gap-2">
            <CheckCircle2Icon
              className="mt-[3px] size-3 shrink-0"
              style={{ color: "var(--brand-emerald)" }}
            />
            <span className="text-foreground/85">{p}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
