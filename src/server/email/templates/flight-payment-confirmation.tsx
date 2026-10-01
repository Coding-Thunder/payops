import { Link, Section, Text } from "@react-email/components";
import * as React from "react";

import { BookingTypeLabel } from "@/lib/constants/labels";
import type { BookingType } from "@/lib/constants/enums";
import type { ServiceRow } from "@/lib/service-summary";

import {
  ChargeBreakdown,
  COLOR,
  type EmailChargeBreakdown,
  EmailAgreeButton,
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
 * Payment receipt for a FLIGHT order.
 *
 * A SEPARATE TEMPLATE, not a branch inside the rental one. Two reasons, and
 * the second is the one that matters:
 *
 *  1. The copy genuinely differs. A flight has no counter to collect a
 *     balance at, no vehicle, and no pick-up/drop-off pair; threading all of
 *     that through the rental template as optionals would leave a file whose
 *     every row is conditional and whose car output nobody can read off the
 *     page any more.
 *
 *  2. It makes the car guarantee structural. `payment-confirmation.tsx` is
 *     not touched by the flight feature at all, so a car receipt cannot
 *     regress — there is no shared conditional to get wrong. That is worth
 *     more than the handful of duplicated JSX lines it costs.
 *
 * Everything below the content is shared: the same EmailLayout, header,
 * footer, support section, terms section and charge table as the rental
 * receipt. This is a different template, not a different email system.
 *
 * The brand is a PROP. Nothing here names a company — `brandName` arrives
 * already resolved for this order's service type by
 * `@/server/email/service-brand`, which is what keeps "Airfare Fees" out of
 * the car path and out of this file.
 */
export interface FlightPaymentConfirmationEmailProps {
  brandName: string;
  /** Accepted for parity with the rental receipt's props so both can be
   *  built from one `commonProps` object. Unused here: a flight receipt has
   *  no provider badge, which is the only thing that linked to the app. */
  appUrl?: string;
  supportEmail: string;
  supportPhone: string;
  customerName: string;
  orderNumber: string;
  bookingType: BookingType;
  amount: string;
  paidOn: string;
  /** Itinerary rows, already formatted by `serviceDetailRows`. */
  flightRows: ServiceRow[];
  /** Airline record locator, once ticketed. */
  confirmationNumber?: string | null;
  chargeBreakdown?: EmailChargeBreakdown;
  termsText?: string | null;
  termsVersion?: string | null;
  acknowledgeUrl?: string | null;
  receiptUrl?: string | null;
  cancellationPolicy?: string;
  cancellationPolicyVersion?: string;
  /** Who actually took the money — never assume Stripe. */
  gatewayLabel?: string | null;
}

export function FlightPaymentConfirmationEmail({
  brandName,
  supportEmail,
  supportPhone,
  customerName,
  orderNumber,
  bookingType,
  amount,
  paidOn,
  flightRows,
  confirmationNumber,
  chargeBreakdown,
  termsText,
  termsVersion,
  acknowledgeUrl,
  receiptUrl,
  cancellationPolicy,
  cancellationPolicyVersion,
  gatewayLabel,
}: FlightPaymentConfirmationEmailProps) {
  const policyParagraphs = cancellationPolicy
    ? cancellationPolicy.split(/\n+/).filter((p) => p.trim().length > 0)
    : [];
  return (
    <EmailLayout
      preview={`${brandName} — payment confirmed for ${orderNumber} (${amount})`}
    >
      <EmailHeader brandName={brandName} eyebrow="Payment receipt" />

      <SuccessBanner
        label="Payment confirmed"
        title={`Thank you, ${customerName}.`}
        description={
          <>
            We&apos;ve received your payment for{" "}
            <strong style={{ color: COLOR.textPrimary }}>
              {BookingTypeLabel[bookingType].toLowerCase()}
            </strong>
            . Your itinerary is below — please keep this email for your
            records.
          </>
        }
      />

      {confirmationNumber ? (
        <Section
          style={{ padding: `${SPACE.md}px ${SPACE.xxxl}px ${SPACE.xs}px` }}
        >
          <Section
            style={{
              backgroundColor: COLOR.surfaceMuted,
              border: `1px solid ${COLOR.borderSoft}`,
              borderRadius: RADIUS.md,
              padding: `${SPACE.md}px ${SPACE.lg}px`,
            }}
          >
            <Text
              style={{
                ...typeStyle("micro"),
                margin: 0,
                color: COLOR.textMuted,
                textTransform: "uppercase",
              }}
            >
              Booking reference
            </Text>
            <Text
              style={{
                ...typeStyle("heading"),
                margin: 0,
                marginTop: 4,
                color: COLOR.textPrimary,
                fontFamily:
                  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
                letterSpacing: "0.02em",
              }}
            >
              {confirmationNumber}
            </Text>
          </Section>
        </Section>
      ) : null}

      <SummaryCard
        title="Flight details"
        topPadding={SPACE.xl}
        bottomPadding={SPACE.xs}
      >
        <MetadataRow label="Type" value={BookingTypeLabel[bookingType]} />
        {flightRows.map((row, idx) => (
          <MetadataRow
            key={row.label}
            label={row.label}
            value={row.value}
            isLast={idx === flightRows.length - 1 && !receiptUrl}
          />
        ))}
        {receiptUrl ? (
          <MetadataRow
            label={gatewayLabel ? `${gatewayLabel} receipt` : "Receipt"}
            value={
              <Link
                href={receiptUrl}
                style={{
                  color: COLOR.textPrimary,
                  textDecoration: "underline",
                  textDecorationColor: COLOR.textMuted,
                }}
              >
                View receipt
              </Link>
            }
            isLast
          />
        ) : null}
      </SummaryCard>

      <SummaryCard title="Payment" topPadding={SPACE.xl} bottomPadding={SPACE.xs}>
        <MetadataRow label="Order" value={orderNumber} />
        <MetadataRow label="Paid on" value={paidOn} />
        <MetadataRow label="Amount" value={amount} isLast />
      </SummaryCard>

      {chargeBreakdown ? (
        <ChargeBreakdown
          breakdown={chargeBreakdown}
          wording={FLIGHT_CHARGE_WORDING}
        />
      ) : null}

      {acknowledgeUrl && termsText ? (
        <EmailAgreeButton
          acknowledgeUrl={acknowledgeUrl}
          termsVersion={termsVersion ?? null}
        />
      ) : null}

      {policyParagraphs.length > 0 ? (
        <SummaryCard
          title="Cancellation &amp; refund policy"
          topPadding={SPACE.xl}
          bottomPadding={SPACE.xl}
        >
          {policyParagraphs.map((paragraph, idx) => (
            <Text
              key={idx}
              style={{
                ...typeStyle("label"),
                margin: 0,
                marginTop: idx === 0 ? 0 : 8,
                color: COLOR.textSecondary,
                fontSize: 13,
              }}
            >
              {paragraph}
            </Text>
          ))}
          {cancellationPolicyVersion ? (
            <Text
              style={{
                ...typeStyle("legal"),
                margin: 0,
                marginTop: 10,
                color: COLOR.textMuted,
              }}
            >
              Policy version {cancellationPolicyVersion}
            </Text>
          ) : null}
        </SummaryCard>
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
