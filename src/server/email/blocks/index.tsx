import {
  Column,
  Heading,
  Hr,
  Img,
  Link,
  Row,
  Section,
  Text,
} from "@react-email/components";
import * as React from "react";

import { EmailBlockKey } from "@/lib/constants/items";
import type { Currency } from "@/lib/constants/enums";
import type { OrderDTO } from "@/types";

import {
  COLOR,
  MetadataRow,
  SPACE,
  SummaryCard,
  typeStyle,
} from "../components";
import { formatEmailDate, formatEmailDay, formatMoney } from "../format";

/**
 * Pass 5f — Composable email block library.
 *
 * The confirmation + payment-request emails are now assembled from this
 * finite set of blocks. ItemType.confirmationEmailBlocks declares which
 * blocks the email should include; the renderer below picks the right
 * React Email component per key, dedupes, and emits them in a stable
 * platform-defined order.
 *
 * Adding a new block kind is a deliberate platform change:
 *   1. Add the key to `EmailBlockKey` in `lib/constants/items.ts`.
 *   2. Add a component + register it in `BLOCK_COMPONENTS` below.
 *   3. Add it to `BLOCK_ORDER` so the layout is deterministic.
 *
 * Tenants cannot mint new blocks — that would be a markup-injection
 * surface in customer-facing email. They CAN choose which platform
 * blocks their ItemType opts into via the admin UI (Pass 5e).
 */

/* ─────────────────────────── Block context ───────────────────────────── */

/**
 * Everything any block might need at render time. Built once by the
 * caller (`composeUniversalEmailProps`) so each block stays a pure
 * function of the snapshot.
 */
export interface EmailBlockContext {
  order: OrderDTO;
  branding: {
    brandName: string;
    supportEmail: string;
    supportPhone: string;
  };
  /** Set by the confirmation flow. Null in the payment-request preview
   *  where the customer hasn't paid yet. */
  payment: {
    amount: string;
    paidOn: string | null;
    receiptUrl: string | null;
  } | null;
  /** Set when the consent-received signature should be surfaced. */
  signature?: {
    signedName: string;
    receivedAt: string;
  } | null;
}

interface BlockProps {
  ctx: EmailBlockContext;
}

/* ──────────────────────────── Block bodies ───────────────────────────── */

function PaymentSummaryBlock({ ctx }: BlockProps): React.ReactElement | null {
  if (!ctx.payment) return null;
  return (
    <Section style={{ padding: `${SPACE.md}px ${SPACE.xxxl}px ${SPACE.xs}px` }}>
      <Row>
        <Column style={{ verticalAlign: "top" }}>
          <Text
            style={{
              ...typeStyle("micro"),
              margin: 0,
              color: COLOR.textMuted,
              textTransform: "uppercase",
            }}
          >
            Amount paid
          </Text>
          <Text
            style={{
              ...typeStyle("amount"),
              margin: 0,
              marginTop: 6,
              color: COLOR.textPrimary,
            }}
          >
            {ctx.payment.amount}
          </Text>
        </Column>
        <Column align="right" style={{ verticalAlign: "top" }}>
          <Text
            style={{
              ...typeStyle("micro"),
              margin: 0,
              color: COLOR.textMuted,
              textTransform: "uppercase",
            }}
          >
            Order
          </Text>
          <Text
            style={{
              ...typeStyle("meta"),
              margin: 0,
              marginTop: 6,
              color: COLOR.textPrimary,
              fontFamily:
                "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
            }}
          >
            {ctx.order.orderNumber}
          </Text>
          {ctx.payment.paidOn ? (
            <Text
              style={{
                ...typeStyle("legal"),
                margin: 0,
                marginTop: 4,
                color: COLOR.textMuted,
                fontSize: 11,
              }}
            >
              {ctx.payment.paidOn}
            </Text>
          ) : null}
        </Column>
      </Row>
    </Section>
  );
}

function LineItemsTableBlock({
  ctx,
}: BlockProps): React.ReactElement | null {
  const lines = ctx.order.lineItems;
  if (!lines || lines.length === 0) return null;
  const currency = ctx.order.pricing.currency as Currency;
  return (
    <SummaryCard
      title={lines.length === 1 ? "Item" : "Items"}
      topPadding={SPACE.xl}
      bottomPadding={SPACE.xs}
    >
      {lines.map((line, idx) => (
        <Row
          key={`${line.itemTypeKey}-${idx}`}
          style={{
            borderBottom:
              idx === lines.length - 1
                ? "none"
                : `1px solid ${COLOR.borderSoft}`,
            paddingBottom: SPACE.sm,
            marginBottom: idx === lines.length - 1 ? 0 : SPACE.sm,
          }}
        >
          <Column style={{ verticalAlign: "top" }}>
            <Text
              style={{
                ...typeStyle("bodyStrong"),
                margin: 0,
                color: COLOR.textPrimary,
              }}
            >
              {line.name}
            </Text>
            {line.description ? (
              <Text
                style={{
                  ...typeStyle("label"),
                  margin: 0,
                  marginTop: 2,
                  color: COLOR.textMuted,
                }}
              >
                {line.description}
              </Text>
            ) : null}
            <Text
              style={{
                ...typeStyle("legal"),
                margin: 0,
                marginTop: 4,
                color: COLOR.textFaint,
                fontSize: 11,
              }}
            >
              {line.quantity} × {formatMoney(line.unitPrice, currency)}
            </Text>
          </Column>
          <Column
            align="right"
            style={{ verticalAlign: "top", width: 120 }}
          >
            <Text
              style={{
                ...typeStyle("bodyStrong"),
                margin: 0,
                color: COLOR.textPrimary,
              }}
            >
              {formatMoney(line.total, currency)}
            </Text>
          </Column>
        </Row>
      ))}
    </SummaryCard>
  );
}

function TotalsBlock({ ctx }: BlockProps): React.ReactElement {
  const currency = ctx.order.pricing.currency as Currency;
  return (
    <Section
      style={{ padding: `${SPACE.sm}px ${SPACE.xxxl}px ${SPACE.xl}px` }}
    >
      <Hr
        style={{
          margin: 0,
          marginBottom: SPACE.sm,
          borderColor: COLOR.borderSoft,
          borderTopWidth: 1,
        }}
      />
      <Row>
        <Column style={{ verticalAlign: "top" }}>
          <Text
            style={{
              ...typeStyle("meta"),
              margin: 0,
              color: COLOR.textSecondary,
            }}
          >
            Total
          </Text>
        </Column>
        <Column align="right" style={{ verticalAlign: "top" }}>
          <Text
            style={{
              ...typeStyle("amount"),
              margin: 0,
              color: COLOR.textPrimary,
              fontSize: 20,
              lineHeight: "26px",
            }}
          >
            {formatMoney(ctx.order.pricing.amount, currency)}
          </Text>
        </Column>
      </Row>
    </Section>
  );
}

function SchedulingWindowBlock({
  ctx,
}: BlockProps): React.ReactElement | null {
  const s = ctx.order.scheduling;
  if (!s) return null;
  return (
    <SummaryCard
      title="Scheduling"
      topPadding={SPACE.lg}
      bottomPadding={SPACE.xs}
    >
      <MetadataRow label="Starts" value={formatEmailDate(s.startsAt)} />
      {s.endsAt ? (
        <MetadataRow label="Ends" value={formatEmailDate(s.endsAt)} isLast />
      ) : (
        <MetadataRow label="Ends" value="Open-ended" isLast />
      )}
    </SummaryCard>
  );
}

function ItemHeroBlock({ ctx }: BlockProps): React.ReactElement | null {
  // First line's image attribute. Rental orders carry `vehicle_image_url`
  // (auto-seeded backfill); other verticals can populate `image_url`.
  const line = ctx.order.lineItems[0];
  if (!line) return null;
  const attrs = line.attributes ?? {};
  const url =
    (attrs.vehicle_image_url as string | null | undefined) ??
    (attrs.image_url as string | null | undefined) ??
    null;
  if (!url) return null;
  return (
    <Section style={{ padding: 0 }}>
      <Img
        src={url}
        alt={line.name}
        width="600"
        height="220"
        style={{
          display: "block",
          width: "100%",
          height: "220px",
          objectFit: "cover",
          backgroundColor: COLOR.surfaceMuted,
          borderBottom: `1px solid ${COLOR.borderSoft}`,
        }}
      />
    </Section>
  );
}

function PrescriptionBlock({ ctx }: BlockProps): React.ReactElement | null {
  // Render the first line's rx attributes if present. A pharmacy order
  // typically has one Rx per line; multi-line Rx orders fall back to
  // the line-items table (which still renders).
  const line = ctx.order.lineItems[0];
  if (!line) return null;
  const attrs = line.attributes ?? {};
  const rx = attrs.rx_number as string | null | undefined;
  if (!rx) return null;
  const refills = attrs.refills_remaining as number | string | null | undefined;
  return (
    <SummaryCard
      title="Prescription"
      topPadding={SPACE.lg}
      bottomPadding={SPACE.xs}
    >
      <MetadataRow label="Rx number" value={String(rx)} />
      {refills !== undefined && refills !== null ? (
        <MetadataRow
          label="Refills remaining"
          value={String(refills)}
          isLast
        />
      ) : null}
    </SummaryCard>
  );
}

function PurchaseTermsBlock({ ctx }: BlockProps): React.ReactElement | null {
  const policy = ctx.order.policy?.text ?? "";
  if (!policy.trim()) return null;
  const paragraphs = policy.split(/\n+/).filter((p) => p.trim().length > 0);
  return (
    <>
      <Hr
        style={{
          margin: 0,
          borderColor: COLOR.borderSoft,
          borderTopWidth: 1,
        }}
      />
      <SummaryCard
        title="Purchase terms"
        topPadding={SPACE.xl}
        bottomPadding={SPACE.xl}
      >
        {paragraphs.map((p, idx) => (
          <Text
            key={idx}
            style={{
              ...typeStyle("label"),
              margin: 0,
              marginTop: idx === 0 ? 0 : 8,
              color: COLOR.textSecondary,
              fontSize: 13,
              lineHeight: "20px",
            }}
          >
            {p}
          </Text>
        ))}
        {ctx.order.policy?.version ? (
          <Text
            style={{
              ...typeStyle("legal"),
              margin: 0,
              marginTop: SPACE.md,
              color: COLOR.textMuted,
              letterSpacing: "0.04em",
            }}
          >
            Policy version {ctx.order.policy.version} • applied at payment
          </Text>
        ) : null}
      </SummaryCard>
    </>
  );
}

function SupportSectionBlock({ ctx }: BlockProps): React.ReactElement {
  return (
    <Section
      style={{
        padding: `${SPACE.xl}px ${SPACE.xxxl}px ${SPACE.xl}px`,
        backgroundColor: COLOR.surfaceMuted,
        borderTop: `1px solid ${COLOR.borderSoft}`,
      }}
    >
      <Heading
        as="h3"
        style={{
          ...typeStyle("micro"),
          margin: 0,
          marginBottom: SPACE.sm,
          color: COLOR.textMuted,
          textTransform: "uppercase",
        }}
      >
        Need help?
      </Heading>
      <Text
        style={{
          ...typeStyle("body"),
          margin: 0,
          color: COLOR.textSecondary,
          fontSize: 13,
        }}
      >
        Reply to this email or reach{" "}
        <Link
          href={`mailto:${ctx.branding.supportEmail}`}
          style={{ color: COLOR.textPrimary, textDecoration: "underline" }}
        >
          {ctx.branding.supportEmail}
        </Link>
        {ctx.branding.supportPhone ? ` • ${ctx.branding.supportPhone}` : null}.
        Quote order{" "}
        <strong style={{ color: COLOR.textPrimary }}>
          {ctx.order.orderNumber}
        </strong>{" "}
        when contacting us.
      </Text>
    </Section>
  );
}

function SignatureBlock({ ctx }: BlockProps): React.ReactElement | null {
  if (!ctx.signature) return null;
  return (
    <SummaryCard
      title="Acknowledged"
      topPadding={SPACE.lg}
      bottomPadding={SPACE.xs}
    >
      <MetadataRow label="Signed by" value={ctx.signature.signedName} />
      <MetadataRow
        label="Received"
        value={formatEmailDate(ctx.signature.receivedAt)}
        isLast
      />
    </SummaryCard>
  );
}

function TrackingInfoBlock({ ctx }: BlockProps): React.ReactElement | null {
  const line = ctx.order.lineItems[0];
  if (!line) return null;
  const attrs = line.attributes ?? {};
  const tracking = attrs.tracking_number as string | null | undefined;
  if (!tracking) return null;
  const carrier = attrs.carrier as string | null | undefined;
  const eta = attrs.delivery_eta as string | null | undefined;
  return (
    <SummaryCard
      title="Shipping"
      topPadding={SPACE.lg}
      bottomPadding={SPACE.xs}
    >
      <MetadataRow label="Tracking number" value={tracking} />
      {carrier ? <MetadataRow label="Carrier" value={carrier} /> : null}
      {eta ? (
        <MetadataRow label="Estimated arrival" value={formatEmailDay(eta)} isLast />
      ) : (
        <MetadataRow
          label="Carrier"
          value={carrier ?? "—"}
          isLast={!carrier}
        />
      )}
    </SummaryCard>
  );
}

function RefundDetailsBlock({ ctx }: BlockProps): React.ReactElement | null {
  // Surfaced in refund emails (separate sender, future work). When the
  // confirmation/request flows include this key (rare) it renders a
  // cumulative refunded-amount note only.
  const refunded = ctx.order.refundedAmount ?? 0;
  if (refunded <= 0) return null;
  return (
    <SummaryCard
      title="Refunds"
      topPadding={SPACE.lg}
      bottomPadding={SPACE.xs}
    >
      <MetadataRow
        label="Refunded to date"
        value={formatMoney(refunded, ctx.order.pricing.currency as Currency)}
        isLast
      />
    </SummaryCard>
  );
}

/* ─────────────────────── Registry + ordering ─────────────────────────── */

type BlockComponent = (props: BlockProps) => React.ReactElement | null;

const BLOCK_COMPONENTS: Record<EmailBlockKey, BlockComponent> = {
  [EmailBlockKey.PAYMENT_SUMMARY]: PaymentSummaryBlock,
  [EmailBlockKey.LINE_ITEMS_TABLE]: LineItemsTableBlock,
  [EmailBlockKey.TOTALS]: TotalsBlock,
  [EmailBlockKey.SCHEDULING_WINDOW]: SchedulingWindowBlock,
  [EmailBlockKey.ITEM_HERO]: ItemHeroBlock,
  [EmailBlockKey.PRESCRIPTION_BLOCK]: PrescriptionBlock,
  [EmailBlockKey.PURCHASE_TERMS]: PurchaseTermsBlock,
  [EmailBlockKey.SUPPORT_SECTION]: SupportSectionBlock,
  [EmailBlockKey.SIGNATURE_BLOCK]: SignatureBlock,
  [EmailBlockKey.TRACKING_INFO]: TrackingInfoBlock,
  [EmailBlockKey.REFUND_DETAILS]: RefundDetailsBlock,
};

/**
 * The canonical render order. Drives the visual rhythm of every
 * universal email regardless of which org enabled which blocks. The
 * SCHEDULING_WINDOW + ITEM_HERO + PRESCRIPTION_BLOCK + TRACKING_INFO
 * sit between the line items + totals and the purchase terms so the
 * customer sees the contextual detail before the legal block.
 */
export const BLOCK_ORDER: EmailBlockKey[] = [
  EmailBlockKey.PAYMENT_SUMMARY,
  EmailBlockKey.ITEM_HERO,
  EmailBlockKey.LINE_ITEMS_TABLE,
  EmailBlockKey.SCHEDULING_WINDOW,
  EmailBlockKey.PRESCRIPTION_BLOCK,
  EmailBlockKey.TRACKING_INFO,
  EmailBlockKey.TOTALS,
  EmailBlockKey.SIGNATURE_BLOCK,
  EmailBlockKey.REFUND_DETAILS,
  EmailBlockKey.PURCHASE_TERMS,
  EmailBlockKey.SUPPORT_SECTION,
];

/**
 * Deduplicate + sort the caller's block list against `BLOCK_ORDER` so the
 * layout is stable no matter what order the ItemTypes contributed their
 * blocks in.
 */
export function sortBlocks(blocks: EmailBlockKey[]): EmailBlockKey[] {
  const set = new Set(blocks);
  return BLOCK_ORDER.filter((k) => set.has(k));
}

/**
 * Render the given block list as a list of React elements. Each block
 * decides internally whether it has anything to show; nulls are filtered
 * so the email never has phantom empty sections.
 */
export function renderBlocks(
  blocks: EmailBlockKey[],
  ctx: EmailBlockContext,
): React.ReactElement[] {
  const ordered = sortBlocks(blocks);
  const out: React.ReactElement[] = [];
  for (const key of ordered) {
    const Component = BLOCK_COMPONENTS[key];
    if (!Component) continue;
    const el = Component({ ctx });
    if (el) out.push(React.cloneElement(el, { key }));
  }
  return out;
}
