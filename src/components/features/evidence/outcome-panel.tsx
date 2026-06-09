import { AlertCircleIcon, CheckIcon, XCircleIcon } from "lucide-react";

import { ConsentStatus, DisputeOutcome, DisputeStatus, OrderStatus } from "@/lib/constants/enums";
import { formatCurrency, formatUtcTimestamp } from "@/lib/format";
import type { OrderEvidenceChainDTO, OrderEvidenceEventDTO } from "@/types";

/**
 * Polymorphic outcome panel, the right column of the case file.
 *
 * Reads the order's dispute / payment / consent pointers and renders
 * one of four variants:
 *
 *   READY  paid, no dispute (the dispute-readiness profile)
 *   OPEN   dispute opened, awaiting outcome
 *   WON    dispute closed in merchant's favor
 *   LOST   dispute closed in customer's favor
 *
 * Tone is deliberately bank-grade: no celebratory color washes, no
 * marketing pills. State is communicated through one calm label,
 * one numeric focal point, and a typographically dense fact column.
 */

interface OutcomePanelProps {
  order: OrderEvidenceChainDTO["order"];
  events: OrderEvidenceEventDTO[];
  integrityValid: boolean;
}

type OutcomeVariant = "READY" | "OPEN" | "WON" | "LOST";

function variantFor(
  order: OrderEvidenceChainDTO["order"],
): OutcomeVariant {
  const d = order.dispute;
  if (d && d.status) {
    // Outcome (when populated) is the most authoritative signal.
    if (d.outcome === DisputeOutcome.WON) return "WON";
    if (d.outcome === DisputeOutcome.LOST) return "LOST";
    // Warning-closed / charge-refunded read as LOST from the
    // merchant's evidence perspective, funds went the customer's way.
    if (
      d.outcome === DisputeOutcome.WARNING_CLOSED ||
      d.outcome === DisputeOutcome.CHARGE_REFUNDED
    ) {
      return "LOST";
    }
    // Status-only fallback for closed disputes without an outcome.
    if (d.status === DisputeStatus.WON) return "WON";
    if (d.status === DisputeStatus.LOST) return "LOST";
    // Everything else (needs-response, under-review, warning-*) reads
    // as OPEN, there's an active case awaiting a terminal call.
    return "OPEN";
  }
  return "READY";
}

export function OutcomePanel({
  order,
  events,
  integrityValid,
}: OutcomePanelProps) {
  const variant = variantFor(order);

  return (
    <aside className="flex flex-col">
      <SectionLabel>Outcome</SectionLabel>

      {variant === "READY" ? (
        <ReadyVariant
          order={order}
          events={events}
          integrityValid={integrityValid}
        />
      ) : null}
      {variant === "OPEN" ? <OpenVariant order={order} /> : null}
      {variant === "WON" ? (
        <WonVariant order={order} events={events} />
      ) : null}
      {variant === "LOST" ? <LostVariant order={order} /> : null}
    </aside>
  );
}

/* ─────────────────────── READY (most common) ────────────────────────── */

function ReadyVariant({
  order,
  events,
  integrityValid,
}: {
  order: OrderEvidenceChainDTO["order"];
  events: OrderEvidenceEventDTO[];
  integrityValid: boolean;
}) {
  const paidAt = order.payment.paidAt;
  const consentSigned = order.consent.receivedAt ?? order.consent.verifiedAt;
  const emailsSent = events.filter(
    (e) =>
      e.eventType === "PAYMENT_REQUEST_EMAIL_SENT" ||
      e.eventType === "CONFIRMATION_EMAIL_SENT",
  ).length;
  const consentEvent = events.find(
    (e) => e.eventType === "CONSENT_RECEIVED",
  );
  const consentIp = consentEvent?.request?.ip ?? null;

  const isPaid = order.status === OrderStatus.PAID;
  const facts: Array<{ k: string; v: string }> = [
    { k: "Hashed event chain", v: `${events.length} events` },
    {
      k: "Customer consent",
      v: consentSigned
        ? `Signed ${formatTimeOnly(consentSigned)}`
        : order.consent.status === ConsentStatus.REQUESTED
          ? "Requested · awaiting signature"
          : "Not requested",
    },
    {
      k: "Email delivery",
      v: emailsSent > 0 ? `${emailsSent} sent · 0 failed` : "-",
    },
    {
      k: "Gateway receipt",
      v: order.payment.paymentIntentId
        ? `${order.payment.gateway ?? "-"} · ${truncate(order.payment.paymentIntentId, 16)}`
        : "Not generated",
    },
    {
      k: "Customer IP capture",
      v: consentIp ?? "-",
    },
    {
      k: "Integrity verification",
      v: integrityValid ? "Valid" : "Broken",
    },
  ];

  return (
    <div className="mt-5 flex flex-col gap-7">
      <StatusBlock
        label={isPaid ? "READY" : "PENDING"}
        line={
          isPaid && paidAt
            ? `Evidence chain captured. This order is dispute-ready as of ${formatUtcTimestamp(paidAt)}.`
            : "Evidence is being captured. The chain will be dispute-ready once payment completes."
        }
        tone="neutral"
      />

      <div>
        <MicroLabel>Evidence on file</MicroLabel>
        <dl className="mt-3 divide-y divide-border/60">
          {facts.map((f) => (
            <div
              key={f.k}
              className="grid grid-cols-[1fr_auto] items-baseline gap-4 py-2"
            >
              <dt className="text-[12.5px] text-muted-foreground">
                {f.k}
              </dt>
              <dd className="font-mono text-[12px] tabular-nums">
                {f.v}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/* ─────────────────────── OPEN dispute ───────────────────────────────── */

function OpenVariant({
  order,
}: {
  order: OrderEvidenceChainDTO["order"];
}) {
  const d = order.dispute!;
  const deadline = order.payment.paidAt; // proxy until DisputeDTO is wired
  return (
    <div className="mt-5 flex flex-col gap-6">
      {/* Amber OPEN hero block, calm urgency. */}
      <div
        className="grid grid-cols-[auto_1fr] items-center gap-4 rounded-xl px-5 py-5 shadow-[0_18px_44px_-20px_color-mix(in_oklch,var(--warning)_45%,transparent)]"
        style={{
          background: "var(--warning)",
          color: "oklch(0.18 0.05 78)",
        }}
      >
        <span
          className="grid size-12 place-items-center rounded-full bg-white/30 ring-2"
          style={{
            color: "oklch(0.18 0.05 78)",
            borderColor: "oklch(0.18 0.05 78 / 0.4)",
          }}
        >
          <AlertCircleIcon className="size-6" strokeWidth={2.5} />
        </span>
        <div>
          <p className="text-[20px] font-bold leading-tight tracking-tight">
            OPEN
          </p>
          <p className="mt-1 text-[12.5px] leading-snug opacity-85">
            Chargeback opened{" "}
            {d.openedAt ? formatUtcTimestamp(d.openedAt) : "-"}. Submit
            evidence before the deadline.
          </p>
        </div>
      </div>

      {d.amount && d.currency ? (
        <FocalAmount
          label="Amount in dispute"
          amount={d.amount}
          currency={d.currency}
        />
      ) : null}

      <FactColumn
        items={[
          { k: "Reason", v: d.reason ?? "-" },
          { k: "Status", v: d.status ?? "-" },
          { k: "Opened", v: d.openedAt ? formatUtcTimestamp(d.openedAt) : "-" },
          {
            k: "Evidence deadline",
            v: deadline ? formatUtcTimestamp(deadline) : "-",
          },
        ]}
      />
    </div>
  );
}

/* ─────────────────────── WON ────────────────────────────────────────── */

function WonVariant({
  order,
  events,
}: {
  order: OrderEvidenceChainDTO["order"];
  events: OrderEvidenceEventDTO[];
}) {
  const d = order.dispute!;
  const consentEvent = events.find(
    (e) => e.eventType === "CONSENT_RECEIVED",
  );
  return (
    <div className="mt-5 flex flex-col gap-6">
      {/* Big green CASE WON hero block, same operational
          identity moment as the reference's outcome panel. */}
      <div
        className="grid grid-cols-[auto_1fr] items-center gap-4 rounded-xl px-5 py-5 text-white shadow-[0_18px_44px_-20px_color-mix(in_oklch,var(--success)_50%,transparent)]"
        style={{ background: "var(--success)" }}
      >
        <span className="grid size-12 place-items-center rounded-full bg-white/20 ring-2 ring-white/70">
          <CheckIcon className="size-6 text-white" strokeWidth={3} />
        </span>
        <div>
          <p className="text-[20px] font-bold leading-tight tracking-tight">
            CASE WON
          </p>
          <p className="mt-1 text-[12.5px] leading-snug text-white/85">
            Chargeback reversed in your favor.
          </p>
        </div>
      </div>

      {d.amount && d.currency ? (
        <FocalAmount
          label="Recovered"
          amount={d.amount}
          currency={d.currency}
          tone="success"
        />
      ) : null}

      <FactColumn
        items={[
          { k: "Reason code", v: d.reason ?? "-" },
          { k: "Opened", v: d.openedAt ? formatUtcTimestamp(d.openedAt) : "-" },
          { k: "Decided", v: d.closedAt ? formatUtcTimestamp(d.closedAt) : "-" },
          { k: "Outcome", v: "Won, Reversed" },
        ]}
      />

      <div>
        <MicroLabel>Why we won</MicroLabel>
        <ul className="mt-3 space-y-2.5">
          {whyWon(order, events, consentEvent ?? null).map((reason) => (
            <li
              key={reason}
              className="flex items-start gap-2.5 text-[12.5px] leading-snug"
            >
              <CheckIcon
                className="mt-[3px] size-3.5 shrink-0 text-success"
                aria-hidden
              />
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ─────────────────────── LOST ───────────────────────────────────────── */

function LostVariant({
  order,
}: {
  order: OrderEvidenceChainDTO["order"];
}) {
  const d = order.dispute!;
  return (
    <div className="mt-5 flex flex-col gap-6">
      {/* Red CASE LOST hero block, same composition, opposite outcome. */}
      <div
        className="grid grid-cols-[auto_1fr] items-center gap-4 rounded-xl px-5 py-5 text-white shadow-[0_18px_44px_-20px_color-mix(in_oklch,var(--destructive)_50%,transparent)]"
        style={{ background: "var(--destructive)" }}
      >
        <span className="grid size-12 place-items-center rounded-full bg-white/20 ring-2 ring-white/70">
          <XCircleIcon className="size-6 text-white" strokeWidth={3} />
        </span>
        <div>
          <p className="text-[20px] font-bold leading-tight tracking-tight">
            CASE LOST
          </p>
          <p className="mt-1 text-[12.5px] leading-snug text-white/85">
            Chargeback decided in the customer&apos;s favor.
          </p>
        </div>
      </div>

      {d.amount && d.currency ? (
        <FocalAmount
          label="Lost"
          amount={d.amount}
          currency={d.currency}
          tone="danger"
        />
      ) : null}

      <FactColumn
        items={[
          { k: "Reason code", v: d.reason ?? "-" },
          { k: "Opened", v: d.openedAt ? formatUtcTimestamp(d.openedAt) : "-" },
          { k: "Decided", v: d.closedAt ? formatUtcTimestamp(d.closedAt) : "-" },
          { k: "Outcome", v: d.outcome ?? "Lost" },
        ]}
      />
    </div>
  );
}

/* ─────────────────────── shared primitives ──────────────────────────── */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
      {children}
    </p>
  );
}

function MicroLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
      {children}
    </p>
  );
}

function StatusBlock({
  label,
  line,
  tone,
}: {
  label: string;
  line: string;
  tone: "neutral" | "success" | "warning" | "danger";
}) {
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : tone === "danger"
          ? "text-destructive"
          : "text-foreground";
  return (
    <div className="mt-3">
      <div className="flex items-baseline gap-3">
        <span
          aria-hidden
          className={`inline-block size-2 rounded-full ${
            tone === "success"
              ? "bg-success"
              : tone === "warning"
                ? "bg-warning"
                : tone === "danger"
                  ? "bg-destructive"
                  : "bg-foreground/60"
          }`}
        />
        <p
          className={`text-[16px] font-semibold tracking-tight ${toneClass}`}
        >
          {label}
        </p>
      </div>
      <p className="mt-2 max-w-[28ch] text-[13px] leading-relaxed text-muted-foreground">
        {line}
      </p>
    </div>
  );
}

function FocalAmount({
  label,
  amount,
  currency,
  tone = "neutral",
}: {
  label: string;
  amount: number;
  currency: string;
  tone?: "neutral" | "success" | "danger";
}) {
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "danger"
        ? "text-destructive"
        : "text-foreground";
  return (
    <div>
      <MicroLabel>{label}</MicroLabel>
      <p
        className={`mt-2 font-mono text-[24px] font-semibold tabular-nums ${toneClass}`}
      >
        {formatCurrency(amount, currency)}
      </p>
    </div>
  );
}

function FactColumn({ items }: { items: Array<{ k: string; v: string }> }) {
  return (
    <dl className="divide-y divide-border/60">
      {items.map((f) => (
        <div
          key={f.k}
          className="grid grid-cols-[1fr_auto] items-baseline gap-4 py-2"
        >
          <dt className="text-[12.5px] text-muted-foreground">{f.k}</dt>
          <dd className="font-mono text-[12px] tabular-nums">{f.v}</dd>
        </div>
      ))}
    </dl>
  );
}

function whyWon(
  order: OrderEvidenceChainDTO["order"],
  events: OrderEvidenceEventDTO[],
  consentEvent: OrderEvidenceEventDTO | null,
): string[] {
  const reasons: string[] = ["Complete end-to-end transaction trail"];
  if (consentEvent) reasons.push("Customer consent on file");
  if (order.payment.paidAt) reasons.push("Payment successfully completed");
  if (
    events.some(
      (e) =>
        e.eventType === "PAYMENT_REQUEST_EMAIL_SENT" ||
        e.eventType === "CONFIRMATION_EMAIL_SENT",
    )
  ) {
    reasons.push("Email communication verified");
  }
  reasons.push("Immutable evidence with integrity proof");
  return reasons;
}

function formatTimeOnly(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mi}:${ss}`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
