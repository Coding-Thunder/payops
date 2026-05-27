import { Button, Section, Text } from "@react-email/components";
import * as React from "react";

import type { EmailBlockKey } from "@/lib/constants/items";

import {
  COLOR,
  EmailFooter,
  EmailHeader,
  EmailLayout,
  SPACE,
  SuccessBanner,
  typeStyle,
} from "../components";
import {
  renderBlocks,
  type EmailBlockContext,
} from "../blocks";

/**
 * Pass 5f — Universal order email.
 *
 * One template, two variants:
 *   - `confirmation`: success banner + payment block list, used after
 *     Stripe reports a paid checkout.
 *   - `request`: introductory paragraph + primary CTA + block list,
 *     used by the agent to ask the customer to pay or acknowledge.
 *
 * Variant differences are in the BANNER + CTA only. The block list is
 * identical: payment_summary (confirmation only), line_items_table,
 * totals, plus whatever the order's ItemTypes opt into
 * (scheduling_window for rentals, prescription_block for pharmacy,
 * tracking_info for shipping, etc.).
 *
 * The block context (`ctx`) carries the order DTO + branding + optional
 * payment snapshot, signature snapshot — everything any block needs.
 * The template stays purely layout-only.
 */

export interface UniversalOrderEmailProps {
  variant: "confirmation" | "request";
  /** Resolved + ordered block keys to render. The renderer dedupes +
   *  sorts internally, but the caller is the one that knows which
   *  blocks the order's ItemTypes contribute. */
  blocks: EmailBlockKey[];
  /** Render-ready snapshot for every block. */
  ctx: EmailBlockContext;
  /** Optional headline overrides. Falls back to variant defaults. */
  bannerTitle?: string | null;
  bannerDescription?: React.ReactNode;
  /** Payment-request only — primary CTA copy + URL + helper. */
  cta?: {
    url: string;
    label: string;
    helperText?: string | null;
  } | null;
  /** Optional override greeting / intro text — written by the agent in
   *  the composer and carried into the request flow. */
  greeting?: string | null;
  intro?: string | null;
  note?: string | null;
}

export function UniversalOrderEmail({
  variant,
  blocks,
  ctx,
  bannerTitle,
  bannerDescription,
  cta,
  greeting,
  intro,
  note,
}: UniversalOrderEmailProps): React.ReactElement {
  const customerName = ctx.order.customer.name;
  const amount =
    ctx.payment?.amount ??
    `${ctx.order.pricing.amount.toFixed(2)} ${ctx.order.pricing.currency}`;
  const preview =
    variant === "confirmation"
      ? `${ctx.branding.brandName} — payment confirmed for ${ctx.order.orderNumber} (${amount})`
      : `${ctx.branding.brandName} — please review order ${ctx.order.orderNumber}`;

  return (
    <EmailLayout preview={preview}>
      <EmailHeader
        brandName={ctx.branding.brandName}
        eyebrow={variant === "confirmation" ? "Payment receipt" : "Payment request"}
      />

      {variant === "confirmation" ? (
        <SuccessBanner
          label="Payment confirmed"
          title={bannerTitle ?? `Thank you, ${customerName}.`}
          description={
            bannerDescription ?? (
              <>
                We&apos;ve received your payment for order{" "}
                <strong style={{ color: COLOR.textPrimary }}>
                  {ctx.order.orderNumber}
                </strong>
                . Details below — please keep this email for your records.
              </>
            )
          }
        />
      ) : (
        <RequestIntro
          customerName={customerName}
          greeting={greeting}
          intro={intro}
          note={note}
        />
      )}

      {variant === "request" && cta ? <PrimaryCta cta={cta} /> : null}

      {renderBlocks(blocks, ctx)}

      <EmailFooter
        brandName={ctx.branding.brandName}
        supportEmail={ctx.branding.supportEmail}
      />
    </EmailLayout>
  );
}

function RequestIntro({
  customerName,
  greeting,
  intro,
  note,
}: {
  customerName: string;
  greeting: string | null | undefined;
  intro: string | null | undefined;
  note: string | null | undefined;
}): React.ReactElement {
  const headline = greeting ?? `Hi ${customerName},`;
  const body =
    intro ??
    "Please review the order details below and continue to payment when you're ready. Reach out if anything looks off — this link is good for the next 24 hours.";
  return (
    <Section
      style={{ padding: `${SPACE.xl}px ${SPACE.xxxl}px ${SPACE.sm}px` }}
    >
      <Text
        style={{
          ...typeStyle("heading"),
          margin: 0,
          color: COLOR.textPrimary,
        }}
      >
        {headline}
      </Text>
      <Text
        style={{
          ...typeStyle("body"),
          margin: 0,
          marginTop: SPACE.sm,
          color: COLOR.textSecondary,
        }}
      >
        {body}
      </Text>
      {note ? (
        <Text
          style={{
            ...typeStyle("label"),
            margin: 0,
            marginTop: SPACE.md,
            padding: `${SPACE.sm}px ${SPACE.md}px`,
            backgroundColor: COLOR.surfaceSubtle,
            borderRadius: 6,
            color: COLOR.textSecondary,
          }}
        >
          {note}
        </Text>
      ) : null}
    </Section>
  );
}

function PrimaryCta({
  cta,
}: {
  cta: NonNullable<UniversalOrderEmailProps["cta"]>;
}): React.ReactElement {
  return (
    <Section
      style={{ padding: `${SPACE.md}px ${SPACE.xxxl}px ${SPACE.lg}px` }}
    >
      <Button
        href={cta.url}
        style={{
          display: "block",
          textAlign: "center",
          padding: "12px 16px",
          backgroundColor: COLOR.textPrimary,
          color: COLOR.textInverted,
          borderRadius: 8,
          ...typeStyle("bodyStrong"),
          textDecoration: "none",
        }}
      >
        {cta.label}
      </Button>
      {cta.helperText ? (
        <Text
          style={{
            ...typeStyle("legal"),
            margin: 0,
            marginTop: SPACE.sm,
            color: COLOR.textMuted,
            textAlign: "center",
          }}
        >
          {cta.helperText}
        </Text>
      ) : null}
    </Section>
  );
}

export default UniversalOrderEmail;
