import {
  Column,
  Hr,
  Row,
  Section,
  Text,
} from "@react-email/components";
import * as React from "react";

import { BookingTypeLabel } from "@/lib/constants/labels";
import { ServiceType, type BookingType } from "@/lib/constants/enums";
import type { ProviderSnapshot } from "@/lib/constants/providers";
import { serviceNoun, type ServiceRow } from "@/lib/service-summary";

import { chargeWordingFor } from "../components/charge-breakdown";
import { rentalBookingRows } from "./payment-confirmation";
import {
  ChargeBreakdown,
  COLOR,
  type EmailChargeBreakdown,
  EmailAgreeButton,
  EmailFooter,
  EmailHeader,
  EmailLayout,
  EmailTermsSection,
  MetadataRow,
  ProviderBadge,
  RADIUS,
  SPACE,
  SuccessBanner,
  SummaryCard,
  SupportSection,
  typeStyle,
} from "../components";

export interface PaymentAuthorizedEmailProps {
  brandName: string;
  appUrl: string;
  supportEmail: string;
  supportPhone: string;
  customerName: string;
  orderNumber: string;
  bookingType: BookingType;
  /**
   * The amount HELD on the card. Deliberately not named `amountPaid` —
   * nothing has been paid at this point in the lifecycle.
   */
  amount: string;
  /** When the hold was placed. */
  authorizedOn: string;
  /**
   * When the gateway's hold lapses if we have not confirmed by then. Null
   * when the gateway reported no expiry; the copy then omits the deadline
   * rather than inventing one.
   */
  holdExpiresOn?: string | null;
  provider: ProviderSnapshot;
  /** WHAT was booked. Drives the noun in the copy and the charge wording. */
  serviceType?: ServiceType;
  /** CAR_RENTAL payload; null on a FLIGHT / HOTEL order. */
  vehicle?: { company: string; type: string; imageUrl?: string | null } | null;
  /** CAR_RENTAL payload; null on a FLIGHT / HOTEL order. */
  trip?: {
    pickupDate: string;
    dropoffDate: string;
    pickupLocation?: string | null;
    dropoffLocation?: string | null;
  } | null;
  /** Pre-formatted "what was booked" rows, from `serviceDetailRows()`.
   *  Omitted for CAR_RENTAL, which falls back to `vehicle` / `trip`. */
  serviceRows?: ServiceRow[] | null;
  /** Pre-formatted charge breakdown. The prepaid total is relabelled
   *  "Amount authorized" here — it has not been collected. */
  chargeBreakdown?: EmailChargeBreakdown;
  /** Terms & Conditions text + version + the signed "I Agree" link. */
  termsText?: string | null;
  termsVersion?: string | null;
  acknowledgeUrl?: string | null;
  cancellationPolicy?: string;
  cancellationPolicyVersion?: string;
  /** Processor holding the authorization ("Stripe", "PayPal"). Null when
   *  unknown, in which case the copy stays gateway-agnostic. */
  gatewayLabel?: string | null;
}

/**
 * The MANUAL-CAPTURE authorization notice.
 *
 * This is not a payment confirmation and must never read like one. At this
 * moment the customer's bank has placed a HOLD: the money is ring-fenced,
 * their available balance has dropped, and nothing has been taken. The
 * charge happens later — only if an operator confirms the booking with the
 * supplier — and if it cannot be confirmed the hold is released in full.
 *
 * Every ambiguity here is a chargeback: a customer who reads "payment
 * confirmed", sees the pending line on their statement, and then finds the
 * booking was never made has a dispute we would lose. So the words "paid",
 * "confirmed" and "charged" are avoided for the amount, and the release
 * promise is stated in the banner, in the "What happens next" block, and
 * again next to the total.
 *
 * Structure, primitives and brand handling are lifted from
 * payment-confirmation.tsx so the two emails are visually siblings and the
 * per-organization brand name / support contacts / gateway attribution
 * resolve through exactly the same components.
 *
 * Only manual-capture organizations reach this template. Both incumbent
 * brands run automatic capture, so neither can render it.
 */
export function PaymentAuthorizedEmail({
  brandName,
  appUrl,
  supportEmail,
  supportPhone,
  customerName,
  orderNumber,
  bookingType,
  amount,
  authorizedOn,
  holdExpiresOn,
  provider,
  serviceType = ServiceType.CAR_RENTAL,
  vehicle,
  trip,
  serviceRows,
  chargeBreakdown,
  termsText,
  termsVersion,
  acknowledgeUrl,
  cancellationPolicy,
  cancellationPolicyVersion,
  gatewayLabel,
}: PaymentAuthorizedEmailProps) {
  const preview = `${brandName} — ${amount} held on your card for ${orderNumber}, not yet charged`;
  const noun = serviceNoun({ serviceType });
  const policyParagraphs = cancellationPolicy
    ? cancellationPolicy.split(/\n+/).filter((p) => p.trim().length > 0)
    : [];
  const bookingRows = serviceRows?.length
    ? serviceRows
    : rentalBookingRows(vehicle, trip);
  const wording = chargeWordingFor(serviceType);

  return (
    <EmailLayout preview={preview}>
      <EmailHeader brandName={brandName} eyebrow="Authorization hold" />

      <SuccessBanner
        label="Card authorized — not charged"
        title={`Thank you, ${customerName}.`}
        description={
          <>
            Your card has been authorized for{" "}
            <strong style={{ color: COLOR.textPrimary }}>{amount}</strong> —
            this is a hold, and{" "}
            <strong style={{ color: COLOR.textPrimary }}>
              no money has been taken yet
            </strong>
            . We&apos;ll charge it only once your {noun} is confirmed with{" "}
            {provider.name}. If we can&apos;t confirm it, we release the hold
            in full and you are never charged.
          </>
        }
      />

      <ProviderBadge
        provider={provider}
        appUrl={appUrl}
        caption={BookingTypeLabel[bookingType]}
      />

      <SummaryCard
        title="Booking details"
        topPadding={SPACE.xl}
        bottomPadding={SPACE.xs}
      >
        <MetadataRow label="Type" value={BookingTypeLabel[bookingType]} />
        <MetadataRow
          label="Provider"
          value={provider.name}
          isLast={bookingRows.length === 0}
        />
        {bookingRows.map((row, idx) => (
          <MetadataRow
            key={`${row.label}-${idx}`}
            label={row.label}
            value={row.value}
            isLast={idx === bookingRows.length - 1}
          />
        ))}
      </SummaryCard>

      {acknowledgeUrl ? (
        <EmailAgreeButton
          acknowledgeUrl={acknowledgeUrl}
          termsVersion={termsVersion}
        />
      ) : null}

      <AuthorizationSummary
        amount={amount}
        orderNumber={orderNumber}
        authorizedOn={authorizedOn}
      />

      {/* The single most important block in this email: the difference
          between a hold and a charge, spelled out in order. */}
      <Section style={{ padding: `${SPACE.md}px ${SPACE.xxxl}px ${SPACE.xs}px` }}>
        <div
          style={{
            backgroundColor: COLOR.surfaceMuted,
            border: `1px solid ${COLOR.borderSoft}`,
            borderLeftWidth: 3,
            borderLeftColor: COLOR.textPrimary,
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
            What happens next
          </Text>
          <NextStep>
            We&apos;re confirming your {noun} with {provider.name}.
          </NextStep>
          <NextStep>
            Once it&apos;s confirmed we charge exactly {amount} — not a penny
            more — and email you the confirmation.
          </NextStep>
          <NextStep>
            If it can&apos;t be confirmed, the hold is released in full and
            nothing is ever taken from your account.
          </NextStep>
          {holdExpiresOn ? (
            <NextStep>
              If we haven&apos;t confirmed by {holdExpiresOn}, the hold
              expires on its own and the funds return to your available
              balance.
            </NextStep>
          ) : null}
          <Text
            style={{
              ...typeStyle("legal"),
              margin: 0,
              marginTop: SPACE.md,
              color: COLOR.textMuted,
              fontSize: 11,
              lineHeight: "16px",
            }}
          >
            Your bank may show {amount} as pending until then. That is the
            hold, not a charge.
          </Text>
        </div>
      </Section>

      {chargeBreakdown ? (
        <ChargeBreakdown
          breakdown={chargeBreakdown}
          title="What you'll be charged"
          topPadding={SPACE.md}
          {...wording}
          prepaidLabel="Amount authorized"
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
          {gatewayLabel
            ? `Authorization held securely by ${gatewayLabel} — PCI-DSS Level 1 certified.`
            : "Authorization held securely."}{" "}
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
                authorization
              </Text>
            ) : null}
          </SummaryCard>
        </>
      ) : null}

      <EmailTermsSection termsText={termsText} termsVersion={termsVersion} />

      <SupportSection
        orderNumber={orderNumber}
        supportEmail={supportEmail}
        supportPhone={supportPhone}
      />

      <EmailFooter
        brandName={brandName}
        supportEmail={supportEmail}
        gatewayLabel={gatewayLabel}
        // NOT "receipt": no money has moved. The default footer sentence
        // would tell the customer they had been charged.
        disclosure="Automated authorization notice — replies route to our support team."
      />
    </EmailLayout>
  );
}

/** One bulleted line in the "What happens next" block. */
function NextStep({ children }: { children: React.ReactNode }) {
  return (
    <Text
      style={{
        ...typeStyle("label"),
        margin: 0,
        marginTop: 8,
        color: COLOR.textSecondary,
        fontSize: 13,
        lineHeight: "20px",
      }}
    >
      • {children}
    </Text>
  );
}

interface AuthorizationSummaryProps {
  amount: string;
  orderNumber: string;
  authorizedOn: string;
}

/**
 * Amount (left) / order + authorized-on (right). Same layout as the
 * confirmation's payment hero, with the labels that tell the truth about
 * this moment: the amount is AUTHORIZED, and the date is when the hold was
 * placed — not when anything was collected.
 */
function AuthorizationSummary({
  amount,
  orderNumber,
  authorizedOn,
}: AuthorizationSummaryProps) {
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
            Amount authorized
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
          <Text
            style={{
              ...typeStyle("legal"),
              margin: 0,
              marginTop: 4,
              color: COLOR.textMuted,
              fontSize: 11,
            }}
          >
            Held, not charged
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
            Authorized {authorizedOn}
          </Text>
        </Column>
      </Row>
    </Section>
  );
}

export default PaymentAuthorizedEmail;
