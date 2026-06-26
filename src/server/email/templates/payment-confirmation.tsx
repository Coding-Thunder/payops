import {
  Column,
  Hr,
  Img,
  Link,
  Row,
  Section,
  Text,
} from "@react-email/components";
import * as React from "react";

import { BookingTypeLabel } from "@/lib/constants/labels";
import type { BookingType } from "@/lib/constants/enums";
import type { ProviderSnapshot } from "@/lib/constants/providers";

import {
  ChargeBreakdown,
  COLOR,
  type EmailChargeBreakdown,
  EmailFooter,
  EmailHeader,
  EmailLayout,
  MetadataRow,
  ProviderBadge,
  RADIUS,
  SPACE,
  SuccessBanner,
  SummaryCard,
  SupportSection,
  typeStyle,
} from "../components";

export interface PaymentConfirmationEmailProps {
  brandName: string;
  appUrl: string;
  supportEmail: string;
  supportPhone: string;
  customerName: string;
  orderNumber: string;
  bookingType: BookingType;
  amount: string;
  paidOn: string;
  provider: ProviderSnapshot;
  vehicle: { company: string; type: string; imageUrl?: string | null };
  trip: {
    pickupDate: string;
    dropoffDate: string;
    pickupLocation?: string | null;
    dropoffLocation?: string | null;
  };
  /** Supplier confirmation number — surfaces prominently at the top. */
  confirmationNumber?: string | null;
  /** Pre-formatted charge breakdown (prepaid / due-at-counter / total). */
  chargeBreakdown?: EmailChargeBreakdown;
  /** Terms & Conditions text + version + the signed "I Agree" link. */
  termsText?: string | null;
  termsVersion?: string | null;
  acknowledgeUrl?: string | null;
  receiptUrl?: string | null;
  cancellationPolicy?: string;
  cancellationPolicyVersion?: string;
}

/**
 * Payment confirmation receipt. Built from primitives in
 * `server/email/components/` — each section maps 1:1 to the brief:
 *   Header → SuccessBanner → ProviderBadge → vehicle hero (optional)
 *   → SummaryCard(Payment) → SummaryCard(Booking) → cancellation policy
 *   → SupportSection → EmailFooter.
 */
export function PaymentConfirmationEmail({
  brandName,
  appUrl,
  supportEmail,
  supportPhone,
  customerName,
  orderNumber,
  bookingType,
  amount,
  paidOn,
  provider,
  vehicle,
  trip,
  confirmationNumber,
  chargeBreakdown,
  termsText,
  termsVersion,
  acknowledgeUrl,
  receiptUrl,
  cancellationPolicy,
  cancellationPolicyVersion,
}: PaymentConfirmationEmailProps) {
  const preview = `${brandName} — payment confirmed for ${orderNumber} (${amount})`;
  const policyParagraphs = cancellationPolicy
    ? cancellationPolicy.split(/\n+/).filter((p) => p.trim().length > 0)
    : [];
  const termsParagraphs = termsText
    ? termsText.split(/\n+/).filter((p) => p.trim().length > 0)
    : [];
  const pickupValue = trip.pickupLocation
    ? `${trip.pickupDate} · ${trip.pickupLocation}`
    : trip.pickupDate;
  const dropoffValue = trip.dropoffLocation
    ? `${trip.dropoffDate} · ${trip.dropoffLocation}`
    : trip.dropoffDate;

  return (
    <EmailLayout preview={preview}>
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
            . Your booking details are below — please keep this email for
            your records.
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
              Confirmation number
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

      <PaymentSummary
        amount={amount}
        orderNumber={orderNumber}
        paidOn={paidOn}
      />

      <ProviderBadge
        provider={provider}
        appUrl={appUrl}
        caption={BookingTypeLabel[bookingType]}
      />

      {vehicle.imageUrl ? (
        <Section style={{ padding: 0 }}>
          <Img
            src={vehicle.imageUrl}
            alt={`${vehicle.company} ${vehicle.type}`}
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
      ) : null}

      <SummaryCard
        title="Booking details"
        topPadding={SPACE.xl}
        bottomPadding={SPACE.xs}
      >
        <MetadataRow label="Type" value={BookingTypeLabel[bookingType]} />
        <MetadataRow label="Provider" value={provider.name} />
        <MetadataRow
          label="Vehicle"
          value={`${vehicle.company} • ${vehicle.type}`}
        />
        <MetadataRow label="Pick-up" value={pickupValue} />
        <MetadataRow
          label="Drop-off"
          value={dropoffValue}
          isLast={!receiptUrl}
        />
        {receiptUrl ? (
          <MetadataRow
            label="Stripe receipt"
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

      {chargeBreakdown ? (
        <ChargeBreakdown
          breakdown={chargeBreakdown}
          title="Charge breakdown"
          topPadding={SPACE.md}
        />
      ) : null}

      <Section
        style={{
          padding: `${SPACE.xs}px ${SPACE.xxxl}px ${SPACE.xl}px`,
        }}
      >
        <Text
          style={{
            ...typeStyle("legal"),
            margin: 0,
            color: COLOR.textMuted,
            fontSize: 11,
            lineHeight: "16px",
          }}
        >
          Payment processed securely by Stripe — PCI-DSS Level 1 certified.
          Your card details are encrypted end-to-end and never stored on our
          servers.
        </Text>
      </Section>

      {policyParagraphs.length > 0 ? (
        <>
          <Hr
            style={{
              margin: 0,
              borderColor: COLOR.borderSoft,
              borderTopWidth: 1,
            }}
          />
          <SummaryCard
            title="Cancellation & refund policy"
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
                  lineHeight: "20px",
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
                  marginTop: SPACE.md,
                  color: COLOR.textMuted,
                  letterSpacing: "0.04em",
                }}
              >
                Policy version {cancellationPolicyVersion} • applied at
                payment
              </Text>
            ) : null}
          </SummaryCard>
        </>
      ) : null}

      {termsParagraphs.length > 0 ? (
        <>
          <Hr
            style={{
              margin: 0,
              borderColor: COLOR.borderSoft,
              borderTopWidth: 1,
            }}
          />
          <SummaryCard
            title="Terms & Conditions"
            topPadding={SPACE.xl}
            bottomPadding={SPACE.lg}
          >
            {termsParagraphs.map((paragraph, idx) => (
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
                {paragraph}
              </Text>
            ))}
            {acknowledgeUrl ? (
              <>
                <Link
                  href={acknowledgeUrl}
                  style={{
                    display: "inline-block",
                    marginTop: SPACE.lg,
                    backgroundColor: COLOR.textPrimary,
                    color: COLOR.textInverted,
                    fontSize: 14,
                    fontWeight: 600,
                    padding: "11px 22px",
                    borderRadius: RADIUS.md,
                    textDecoration: "none",
                    textAlign: "center",
                  }}
                >
                  I Agree
                </Link>
                <Text
                  style={{
                    ...typeStyle("legal"),
                    margin: 0,
                    marginTop: SPACE.sm,
                    color: COLOR.textMuted,
                    fontSize: 11,
                    lineHeight: "16px",
                  }}
                >
                  By clicking &ldquo;I Agree&rdquo; you confirm you have read and
                  accept these terms
                  {termsVersion ? ` (version ${termsVersion})` : ""}. Your
                  acknowledgement is recorded against this booking.
                </Text>
              </>
            ) : null}
          </SummaryCard>
        </>
      ) : null}

      <SupportSection
        orderNumber={orderNumber}
        supportEmail={supportEmail}
        supportPhone={supportPhone}
      />

      <EmailFooter brandName={brandName} supportEmail={supportEmail} />
    </EmailLayout>
  );
}

interface PaymentSummaryProps {
  amount: string;
  orderNumber: string;
  paidOn: string;
}

/**
 * Local sub-section: amount (left) / order + paid-on (right). Inlined
 * here because the payment-hero layout is specific to the confirmation
 * receipt — other templates won't reuse this exact shape.
 */
function PaymentSummary({ amount, orderNumber, paidOn }: PaymentSummaryProps) {
  return (
    <Section
      style={{ padding: `${SPACE.md}px ${SPACE.xxxl}px ${SPACE.xs}px` }}
    >
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
            {amount}
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
            {orderNumber}
          </Text>
          <Text
            style={{
              ...typeStyle("legal"),
              margin: 0,
              marginTop: 4,
              color: COLOR.textMuted,
              fontSize: 11,
            }}
          >
            {paidOn}
          </Text>
        </Column>
      </Row>
    </Section>
  );
}

export default PaymentConfirmationEmail;
