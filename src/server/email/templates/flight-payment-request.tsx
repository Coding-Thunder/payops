import { Column, Link, Row, Section, Text } from "@react-email/components";
import * as React from "react";

import { BookingTypeLabel } from "@/lib/constants/labels";
import type { BookingType } from "@/lib/constants/enums";
import type { ServiceRow } from "@/lib/service-summary";

import {
  ChargeBreakdown,
  COLOR,
  type EmailChargeBreakdown,
  EmailFooter,
  EmailHeader,
  EmailLayout,
  EmailTermsSection,
  FLIGHT_CHARGE_WORDING,
  MetadataRow,
  RADIUS,
  SPACE,
  SuccessBanner,
  SummaryCard,
  SupportSection,
  typeStyle,
} from "../components";

/**
 * "Please complete your payment" email for a FLIGHT order.
 *
 * Sister to `flight-payment-confirmation.tsx`, and a deliberate sibling of
 * the rental `payment-request.tsx` rather than a branch inside it — see the
 * long note in the flight confirmation template for why the car templates
 * are left untouched. The short version: the car email's output is
 * guaranteed unchanged because no flight code runs through it.
 *
 * Everything structural is shared with the rental emails: EmailLayout,
 * header, success banner, summary cards, charge table, terms, support block
 * and footer all come from `../components`. What differs is the itinerary
 * rows, the charge wording (a flight has no counter to settle at), and the
 * brand — which arrives as a prop, already resolved for this service type.
 */
export interface FlightPaymentRequestEmailProps {
  brandName: string;
  appUrl: string;
  supportEmail: string;
  supportPhone: string;

  customerName: string;
  orderNumber: string;
  bookingType: BookingType;
  amount: string;
  dueBy?: string | null;

  /** Itinerary rows, already formatted by `serviceDetailRows`. */
  flightRows: ServiceRow[];
  chargeBreakdown?: EmailChargeBreakdown;

  /** Human label for the gateway actually routing this charge. Never
   *  assume Stripe — this deployment runs PayPal too. */
  gatewayLabel?: string | null;

  /** Operator-editable copy from the composer; falls back to the defaults
   *  below when left blank. */
  greeting?: string | null;
  intro?: string | null;
  note?: string | null;

  cancellationPolicy?: string;
  cancellationPolicyVersion?: string;
  termsText?: string | null;
  termsVersion?: string | null;

  /** The single guided action — hosted consent page, or checkout when
   *  consent is already recorded. Same contract as the rental template. */
  primaryCta?: {
    url: string;
    label: string;
    helperText?: string | null;
  };
}

export function FlightPaymentRequestEmail({
  brandName,
  supportEmail,
  supportPhone,
  customerName,
  orderNumber,
  bookingType,
  amount,
  dueBy,
  flightRows,
  chargeBreakdown,
  gatewayLabel,
  greeting,
  intro,
  note,
  termsText,
  termsVersion,
  primaryCta,
}: FlightPaymentRequestEmailProps) {
  const greetingLine = greeting?.trim() || `Hi ${customerName},`;
  const introLine =
    intro?.trim() ||
    `Your flight booking with ${brandName} is held and ready. Complete the payment below to confirm it.`;

  return (
    <EmailLayout
      preview={`${brandName} — payment requested for ${orderNumber} (${amount})`}
    >
      <EmailHeader brandName={brandName} eyebrow="Payment requested" />

      <SuccessBanner
        label="Action required"
        title={greetingLine}
        description={introLine}
      />

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
              You pay today
            </Text>
            <Text
              style={{
                ...typeStyle("amount"),
                margin: 0,
                marginTop: 6,
                color: COLOR.textPrimary,
              }}
            >
              {amount}
            </Text>
            {dueBy ? (
              <Text
                style={{
                  ...typeStyle("legal"),
                  margin: 0,
                  marginTop: 4,
                  color: COLOR.textMuted,
                }}
              >
                Payment link expires {dueBy}
              </Text>
            ) : null}
          </Column>
        </Row>
      </Section>

      {primaryCta ? (
        <Section style={{ padding: `${SPACE.lg}px ${SPACE.xxxl}px` }}>
          <Link
            href={primaryCta.url}
            style={{
              display: "block",
              backgroundColor: COLOR.textPrimary,
              color: COLOR.textInverted,
              fontSize: 14,
              fontWeight: 600,
              padding: "13px 20px",
              borderRadius: RADIUS.md,
              textDecoration: "none",
              textAlign: "center",
              letterSpacing: "-0.005em",
            }}
          >
            {primaryCta.label}
          </Link>
          {primaryCta.helperText ? (
            <Text
              style={{
                ...typeStyle("legal"),
                margin: 0,
                marginTop: SPACE.sm,
                color: COLOR.textMuted,
                textAlign: "center",
                lineHeight: "16px",
                fontSize: 11,
              }}
            >
              {primaryCta.helperText}
            </Text>
          ) : null}
        </Section>
      ) : null}

      <SummaryCard
        title="Flight details"
        topPadding={SPACE.xl}
        bottomPadding={SPACE.xs}
      >
        <MetadataRow label="Type" value={BookingTypeLabel[bookingType]} />
        <MetadataRow label="Order" value={orderNumber} />
        {flightRows.map((row, idx) => (
          <MetadataRow
            key={row.label}
            label={row.label}
            value={row.value}
            isLast={idx === flightRows.length - 1}
          />
        ))}
      </SummaryCard>

      {chargeBreakdown ? (
        <ChargeBreakdown
          breakdown={chargeBreakdown}
          wording={FLIGHT_CHARGE_WORDING}
        />
      ) : null}

      {note?.trim() ? (
        <Section
          style={{ padding: `${SPACE.xs}px ${SPACE.xxxl}px ${SPACE.md}px` }}
        >
          <Text
            style={{
              ...typeStyle("body"),
              margin: 0,
              color: COLOR.textSecondary,
            }}
          >
            {note}
          </Text>
        </Section>
      ) : null}

      <EmailTermsSection
        termsText={termsText ?? null}
        termsVersion={termsVersion ?? null}
      />

      <SupportSection
        orderNumber={orderNumber}
        supportEmail={supportEmail}
        supportPhone={supportPhone}
      />

      <EmailFooter
        brandName={brandName}
        supportEmail={supportEmail}
        gatewayLabel={gatewayLabel ?? null}
      />
    </EmailLayout>
  );
}
