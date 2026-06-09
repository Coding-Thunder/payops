import { Fragment } from "react";
import { AlertTriangleIcon } from "lucide-react";

import {
  OrderEvidenceActorLabel,
  OrderEvidenceEventLabel,
} from "@/lib/constants/labels";
import { OrderEvidenceEventType } from "@/lib/constants/enums";
import {
  formatHashShort,
  formatIp,
  formatUtcTime,
  formatUtcTimestamp,
} from "@/lib/format";
import type { OrderEvidenceEventDTO } from "@/types";

interface EvidenceTimelineProps {
  events: OrderEvidenceEventDTO[];
  brokenAtSequence?: number | null;
}

/**
 * Operational ledger for the case file's evidence timeline.
 *
 * Rendered as a flat tabular list, not a card stack. Each row is one
 * event, single-line by default; the row expands inline to reveal
 * email HTML (when applicable) and the hash chain link. Designed to
 * read at ~12px line-height like a ledger printout, not a
 * notification feed.
 *
 *   ┌──── seq ────┬───────── label ──────────┬──── meta ──────┬─ ✓
 *   01            Order created               08:13:35 UTC     ✓
 *                                             Agent · Mira Holst
 *
 * Email events + chain-link details collapse behind a per-row
 * `<details>` so dense scanning stays uninterrupted; operators who
 * need the body or the hashes open them deliberately.
 */
export function EvidenceTimeline({
  events,
  brokenAtSequence,
}: EvidenceTimelineProps) {
  if (events.length === 0) {
    return (
      <p className="text-[12.5px] text-muted-foreground">
        No evidence events recorded for this order yet.
      </p>
    );
  }
  return (
    <ol className="relative">
      {/* Vertical green connector line behind the numbered nodes.
          Solid green when the chain is valid; destructive when broken
          at any point (the row-level marker tells you which one). */}
      <span
        aria-hidden
        className="pointer-events-none absolute left-[0.875rem] top-3 bottom-3 w-[2.5px] rounded-full"
        style={{
          background:
            brokenAtSequence != null
              ? "var(--destructive)"
              : "var(--success)",
        }}
      />
      {events.map((event) => (
        <TimelineRow
          key={event.id}
          event={event}
          isBrokenHead={brokenAtSequence === event.sequence}
        />
      ))}
    </ol>
  );
}

function TimelineRow({
  event,
  isBrokenHead,
}: {
  event: OrderEvidenceEventDTO;
  isBrokenHead: boolean;
}) {
  const label =
    OrderEvidenceEventLabel[event.eventType] ?? event.eventType;
  const isEmailEvent =
    event.eventType === OrderEvidenceEventType.PAYMENT_REQUEST_EMAIL_SENT ||
    event.eventType === OrderEvidenceEventType.CONFIRMATION_EMAIL_SENT;
  const html =
    isEmailEvent && typeof event.payload.html === "string"
      ? (event.payload.html as string)
      : null;

  return (
    <li className="relative grid grid-cols-[1.75rem_1fr_auto] items-start gap-x-3 py-2.5 first:pt-0 last:pb-0">
      {/* Numbered green ring node, bold operational identity
          marker. Replaces the prior tiny sequence + tick combo. */}
      <span
        className={`relative z-10 grid size-7 place-items-center rounded-full text-[11px] font-semibold ${
          isBrokenHead
            ? "text-white shadow-[0_0_0_3px_color-mix(in_oklch,var(--destructive)_25%,transparent)]"
            : "text-white"
        }`}
        style={{
          background: isBrokenHead
            ? "var(--destructive)"
            : "var(--success)",
        }}
      >
        {isBrokenHead ? (
          <AlertTriangleIcon className="size-3.5" strokeWidth={2.5} />
        ) : (
          event.sequence
        )}
      </span>

      {/* Label + secondary line */}
      <div className="min-w-0 pt-1">
        <p
          className={`text-[13px] font-semibold leading-tight ${
            isBrokenHead ? "text-destructive" : ""
          }`}
        >
          {label}
        </p>
        <RowMeta event={event} />
        {isBrokenHead ? (
          <p className="mt-1 inline-flex items-center gap-1.5 text-[11.5px] font-medium text-destructive">
            <AlertTriangleIcon className="size-3" aria-hidden />
            Chain breaks at this event, payload or hash mutated
          </p>
        ) : null}
        <RowExpand event={event} html={html} />
      </div>

      {/* Timestamp */}
      <span className="pt-1 font-mono text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
        {formatUtcTime(event.occurredAt)}
      </span>
    </li>
  );
}

function RowMeta({ event }: { event: OrderEvidenceEventDTO }) {
  const actorLabel =
    OrderEvidenceActorLabel[event.actor.type] ?? event.actor.type;
  const refs = event.refs ?? null;

  // One-line secondary that surfaces the most operationally useful
  // reference for the row, without expanding the inline details.
  let secondary: string | null = null;
  if (refs?.paymentSessionId) {
    secondary = `Session ${formatHashShort(refs.paymentSessionId, 14)}`;
  } else if (refs?.paymentIntentId) {
    secondary = `Intent ${formatHashShort(refs.paymentIntentId, 14)}`;
  } else if (refs?.customerEmail) {
    secondary = `To ${refs.customerEmail}`;
  } else if (refs?.signatureName) {
    secondary = `Signed by ${refs.signatureName}`;
  } else if (event.request?.ip) {
    secondary = `IP ${formatIp(event.request.ip)}`;
  }

  return (
    <p className="text-[11.5px] text-muted-foreground leading-snug">
      {actorLabel}
      {event.actor.name ? ` · ${event.actor.name}` : ""}
      {secondary ? ` · ` : null}
      {secondary ? (
        <span className="font-mono tabular-nums">{secondary}</span>
      ) : null}
    </p>
  );
}

function RowExpand({
  event,
  html,
}: {
  event: OrderEvidenceEventDTO;
  html: string | null;
}) {
  return (
    <details className="group/expand mt-2">
      <summary className="cursor-pointer select-none text-[11.5px] text-muted-foreground hover:text-foreground">
        <span className="group-open/expand:hidden">Expand details</span>
        <span className="hidden group-open/expand:inline">Hide details</span>
      </summary>
      <div className="mt-3 space-y-4 border-l border-border/60 pl-4">
        <RefsBlock event={event} />
        {html ? <EmailRender event={event} html={html} /> : null}
        <HashBlock event={event} />
      </div>
    </details>
  );
}

function RefsBlock({ event }: { event: OrderEvidenceEventDTO }) {
  const refs = event.refs ?? null;
  const items: Array<{ label: string; value: string }> = [];
  if (refs?.paymentSessionId) {
    items.push({ label: "Payment session", value: refs.paymentSessionId });
  }
  if (refs?.paymentIntentId) {
    items.push({ label: "Payment intent", value: refs.paymentIntentId });
  }
  if (
    refs?.transactionId &&
    refs.transactionId !== refs.paymentIntentId
  ) {
    items.push({ label: "Transaction id", value: refs.transactionId });
  }
  if (refs?.gatewayEventId) {
    items.push({ label: "Gateway event", value: refs.gatewayEventId });
  }
  if (refs?.messageId) {
    items.push({ label: "Email message id", value: refs.messageId });
  }
  if (refs?.signatureName) {
    items.push({ label: "Signed name", value: refs.signatureName });
  }
  if (event.request?.ip) {
    items.push({ label: "IP", value: formatIp(event.request.ip) });
  }
  if (event.request?.userAgent) {
    items.push({ label: "User agent", value: event.request.userAgent });
  }
  if (items.length === 0) return null;
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-[11.5px]">
      {items.map((i) => (
        <Fragment key={i.label}>
          <dt className="text-muted-foreground">{i.label}</dt>
          <dd className="break-all font-mono">{i.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function HashBlock({ event }: { event: OrderEvidenceEventDTO }) {
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-[11.5px] font-mono">
      <dt className="text-muted-foreground">snapshotHash</dt>
      <dd className="break-all">{event.snapshotHash}</dd>
      <dt className="text-muted-foreground">hash</dt>
      <dd className="break-all">{event.hash}</dd>
      <dt className="text-muted-foreground">previousHash</dt>
      <dd className="break-all">
        {event.previousHash ?? "GENESIS"}
      </dd>
    </dl>
  );
}

/**
 * Renders the captured email body inline. Strip the outer chrome from
 * the React-Email HTML and a small reset overrides the centered-card
 * styling so it reads as flush-left evidence content.
 */
function EmailRender({
  event,
  html,
}: {
  event: OrderEvidenceEventDTO;
  html: string | null;
}) {
  if (!html) return null;
  const subject =
    typeof event.payload.subject === "string" ? event.payload.subject : "";
  const to = typeof event.payload.to === "string" ? event.payload.to : "";
  const from =
    typeof event.payload.from === "string" ? event.payload.from : "";
  const replyTo =
    typeof event.payload.replyTo === "string"
      ? (event.payload.replyTo as string)
      : null;
  const messageId =
    typeof event.payload.messageId === "string"
      ? (event.payload.messageId as string)
      : null;
  const body = extractEmailBody(html);
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-[13.5px] font-semibold text-foreground">
          {subject || "(no subject)"}
        </p>
        <dl className="grid grid-cols-[4rem_1fr] gap-x-3 gap-y-0.5 text-[11.5px]">
          <dt className="text-muted-foreground">From</dt>
          <dd className="text-foreground">{from || "-"}</dd>
          <dt className="text-muted-foreground">To</dt>
          <dd className="text-foreground">{to || "-"}</dd>
          {replyTo ? (
            <>
              <dt className="text-muted-foreground">Reply-To</dt>
              <dd>{replyTo}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Date</dt>
          <dd>{formatUtcTimestamp(event.occurredAt)}</dd>
          {messageId ? (
            <>
              <dt className="text-muted-foreground">Message id</dt>
              <dd className="font-mono break-all">{messageId}</dd>
            </>
          ) : null}
        </dl>
      </div>
      <div
        className="evidence-email-body rounded-md border border-border/70 bg-background p-4 text-[12.5px] text-foreground"
        dangerouslySetInnerHTML={{ __html: body }}
      />
    </div>
  );
}

function extractEmailBody(html: string): string {
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const inner = bodyMatch ? bodyMatch[1] : html;
  const reset = `<style>
    .evidence-email-body [style*="#f6f7f9"],
    .evidence-email-body [style*="#F6F7F9"] {
      background: transparent !important;
      background-color: transparent !important;
      padding-top: 0 !important;
      padding-bottom: 0 !important;
      margin: 0 !important;
    }
    .evidence-email-body table[align="center"],
    .evidence-email-body [style*="margin:0 auto"],
    .evidence-email-body [style*="margin: 0 auto"] {
      margin-left: 0 !important;
      margin-right: 0 !important;
    }
    .evidence-email-body img { max-width: 100%; height: auto; }
  </style>`;
  return reset + inner;
}
