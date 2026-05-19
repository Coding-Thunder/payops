import { Fragment } from "react";
import {
  CarIcon,
  CheckCircle2Icon,
  CreditCardIcon,
  FileSignatureIcon,
  HashIcon,
  MailIcon,
  PenLineIcon,
  ShieldCheckIcon,
  XCircleIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  OrderEvidenceActorLabel,
  OrderEvidenceEventLabel,
} from "@/lib/constants/labels";
import { OrderEvidenceEventType } from "@/lib/constants/enums";
import { formatDateTime, formatIp, formatRelative } from "@/lib/format";
import type { OrderEvidenceEventDTO } from "@/types";

interface EvidenceTimelineProps {
  events: OrderEvidenceEventDTO[];
  brokenAtSequence?: number | null;
}

const ICONS: Partial<Record<OrderEvidenceEventDTO["eventType"], React.ComponentType<{ className?: string }>>> = {
  ORDER_CREATED: CarIcon,
  DRAFT_SAVED: PenLineIcon,
  GATEWAY_SELECTED: CreditCardIcon,
  PAYMENT_LINK_GENERATED: CreditCardIcon,
  PAYMENT_LINK_REGENERATED: CreditCardIcon,
  PAYMENT_REQUEST_EMAIL_SENT: MailIcon,
  CONSENT_REQUESTED: FileSignatureIcon,
  CONSENT_RECEIVED: FileSignatureIcon,
  CONSENT_VERIFIED: ShieldCheckIcon,
  PAYMENT_STARTED: CreditCardIcon,
  PAYMENT_COMPLETED: CheckCircle2Icon,
  CONFIRMATION_EMAIL_SENT: MailIcon,
  PAYMENT_FAILED: XCircleIcon,
  PAYMENT_EXPIRED: XCircleIcon,
};

/**
 * Vertical event timeline rendered on the evidence page. Every event
 * carries its sequence, type, occurredAt, actor, refs, and hashes. The
 * UI surfaces a "Broken from here" indicator on the first event after
 * a verification failure so the operator can see where the chain
 * diverged.
 *
 * Email-send events render the captured HTML inline (sandboxed iframe
 * via `srcDoc`) — no modal indirection. Keeps the whole evidence
 * record on one scrollable page that matches the PDF dispute packet.
 */
export function EvidenceTimeline({
  events,
  brokenAtSequence,
}: EvidenceTimelineProps) {
  return (
    <ol className="divide-y divide-border">
      {events.map((event) => {
        const Icon = ICONS[event.eventType] ?? HashIcon;
        const isBrokenHead = brokenAtSequence === event.sequence;
        const isEmailEvent =
          event.eventType ===
            OrderEvidenceEventType.PAYMENT_REQUEST_EMAIL_SENT ||
          event.eventType ===
            OrderEvidenceEventType.CONFIRMATION_EMAIL_SENT;
        const html =
          isEmailEvent && typeof event.payload.html === "string"
            ? (event.payload.html as string)
            : null;
        return (
          <li key={event.id} className="py-5 first:pt-0 last:pb-0">
            <div className="flex items-start gap-3 mb-2">
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 space-y-0.5">
                <h4 className="text-[13.5px] font-semibold text-foreground">
                  <span className="text-muted-foreground mr-2 font-mono font-normal">
                    #{event.sequence}
                  </span>
                  {OrderEvidenceEventLabel[event.eventType] ?? event.eventType}
                </h4>
                <p className="text-[12px] text-muted-foreground">
                  {formatDateTime(event.occurredAt)} ·{" "}
                  {formatRelative(event.occurredAt)} ·{" "}
                  {OrderEvidenceActorLabel[event.actor.type]}
                  {event.actor.name ? ` (${event.actor.name})` : ""}
                </p>
              </div>
            </div>
            <div className="ml-7 space-y-3">
              {isBrokenHead ? (
                <Badge variant="destructive">
                  Chain breaks at this event — payload or hash mutated
                </Badge>
              ) : null}
              <EventDetails event={event} />
              {isEmailEvent ? <EmailRender event={event} html={html} /> : null}
              <details className="text-[11.5px] text-muted-foreground">
                <summary className="cursor-pointer select-none font-medium text-foreground/80 hover:text-foreground">
                  Hash + chain link
                </summary>
                <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 font-mono">
                  <dt className="text-muted-foreground">sequence</dt>
                  <dd>{event.sequence}</dd>
                  <dt className="text-muted-foreground">snapshotHash</dt>
                  <dd className="break-all">{event.snapshotHash}</dd>
                  <dt className="text-muted-foreground">hash</dt>
                  <dd className="break-all">{event.hash}</dd>
                  <dt className="text-muted-foreground">previousHash</dt>
                  <dd className="break-all">{event.previousHash ?? "GENESIS"}</dd>
                </dl>
              </details>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function EventDetails({ event }: { event: OrderEvidenceEventDTO }) {
  const refs = event.refs ?? null;
  const items: Array<{ label: string; value: string }> = [];
  if (refs?.paymentSessionId) {
    items.push({
      label: "Payment session id",
      value: refs.paymentSessionId,
    });
  }
  if (refs?.paymentIntentId) {
    items.push({ label: "Payment intent id", value: refs.paymentIntentId });
  }
  if (refs?.transactionId && refs.transactionId !== refs.paymentIntentId) {
    items.push({ label: "Transaction id", value: refs.transactionId });
  }
  if (refs?.gatewayEventId) {
    items.push({ label: "Gateway event id", value: refs.gatewayEventId });
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
    <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-[12px]">
      {items.map((i) => (
        <Fragment key={i.label}>
          <dt className="text-muted-foreground">{i.label}</dt>
          <dd className="break-all font-mono">{i.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/**
 * Renders the captured email as flat evidence content — like reading a
 * "show original" download. No card box, no grey backdrop, no centered
 * container; just the subject + headers stacked above the body text.
 *
 * The HTML is generated by our own React Email templates and is safe to
 * mount via dangerouslySetInnerHTML. We use `extractEmailBody` to strip
 * the outer `<html>/<head>/<body>` wrappers + a `<style>` reset that
 * neutralises the templates' centered-card-on-grey chrome so the
 * content sits flush-left as evidence.
 */
function EmailRender({
  event,
  html,
}: {
  event: OrderEvidenceEventDTO;
  html: string | null;
}) {
  const subject =
    typeof event.payload.subject === "string" ? event.payload.subject : "";
  const to =
    typeof event.payload.to === "string" ? event.payload.to : "";
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
  const body = html ? extractEmailBody(html) : null;
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <h3 className="text-[15px] font-semibold text-foreground">
          {subject || "(no subject)"}
        </h3>
        <dl className="grid grid-cols-[4rem_1fr] gap-x-3 gap-y-0.5 text-[12px]">
          <dt className="text-muted-foreground">From</dt>
          <dd className="text-foreground">{from || "—"}</dd>
          <dt className="text-muted-foreground">To</dt>
          <dd className="text-foreground">{to || "—"}</dd>
          {replyTo ? (
            <>
              <dt className="text-muted-foreground">Reply-To</dt>
              <dd>{replyTo}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Date</dt>
          <dd>{formatDateTime(event.occurredAt)}</dd>
          {messageId ? (
            <>
              <dt className="text-muted-foreground">Message id</dt>
              <dd className="font-mono break-all">{messageId}</dd>
            </>
          ) : null}
        </dl>
      </div>
      {body ? (
        <Card className="max-w-[720px]">
          <CardContent>
            <div
              className="evidence-email-body text-[13px] text-foreground"
              dangerouslySetInnerHTML={{ __html: body }}
            />
          </CardContent>
        </Card>
      ) : (
        <p className="text-[12.5px] text-muted-foreground">
          No HTML snapshot captured for this send.
        </p>
      )}
    </div>
  );
}

/**
 * Strip the outer document chrome from a rendered React-Email HTML
 * string so it can be inlined as evidence content. Display-only — the
 * underlying email templates and the captured HTML payload stay
 * byte-identical, chain hashes still match.
 *
 *   - drops <html>/<head> entirely
 *   - takes the inside of <body>
 *   - prepends a scoped reset that:
 *       - kills any inline `#f6f7f9` page-colour leakage from internal
 *         wrappers (we paint the grey ourselves on the outer container,
 *         so internal duplicates would double up)
 *       - shifts the centered email card flush-left within its
 *         grey-backed container
 *       - constrains images to the container width
 */
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
