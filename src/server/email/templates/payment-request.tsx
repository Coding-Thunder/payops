import {
  Column,
  Hr,
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
  COLOR,
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

export interface PaymentRequestEmailProps {
  brandName: string;
  appUrl: string;
  supportEmail: string;
  supportPhone: string;

  customerName: string;
  orderNumber: string;
  bookingType: BookingType;
  amount: string;
  /** ISO due-by string formatted by the caller. Optional. */
  dueBy?: string | null;

  provider: ProviderSnapshot;
  vehicle: { company: string; type: string };
  trip: { pickupDate: string; dropoffDate: string };

  /** Hosted Stripe Checkout URL the customer clicks. */
  paymentUrl: string;

  /** All four are editable by the agent in the composer; if empty / null the
   *  template falls back to the code-default copy. */
  greeting?: string | null;
  intro?: string | null;
  note?: string | null;

  cancellationPolicy?: string;
  cancellationPolicyVersion?: string;
}

/**
 * Pre-payment "please complete your payment" email. Sister template to
 * payment-confirmation: same primitives, same monochrome palette — the
 * difference is the prominent CTA button to the Stripe link instead of
 * a "thank you" confirmation.
 *
 * The agent's editable surface (subject, greeting, intro, optional note)
 * is threaded in as props. Hardcoded defaults below ensure the email
 * still reads well when the agent leaves a field blank.
 */
export function PaymentRequestEmail({
  brandName,
  appUrl,
  supportEmail,
  supportPhone,
  customerName,
  orderNumber,
  bookingType,
  amount,
  dueBy,
  provider,
  vehicle,
  trip,
  paymentUrl,
  greeting,
  intro,
  note,
  cancellationPolicy,
  cancellationPolicyVersion,
}: PaymentRequestEmailProps) {
  const preview = `Complete payment for ${orderNumber} — ${amount}`;
  const policyParagraphs = cancellationPolicy
    ? cancellationPolicy.split(/\n+/).filter((p) => p.trim().length > 0)
    : [];

  const greetingLine =
    greeting && greeting.trim().length > 0
      ? greeting
      : `Hi ${customerName},`;
  const introLine =
    intro && intro.trim().length > 0
      ? intro
      : `Thanks for booking with ${provider.name}. Your ${BookingTypeLabel[
          bookingType
        ].toLowerCase()} is reserved — please complete payment using the secure link below to confirm it.`;

  return (
    <EmailLayout preview={preview}>
      <EmailHeader brandName={brandName} eyebrow="Payment requested" />

      <SuccessBanner
        label="Action required"
        title={greetingLine}
        description={introLine}
      />

      {/* Amount due — leans heavier than the confirmation receipt's
          amount block because this email is asking the customer to pay
          now. Same flat layout, just larger type weight. */}
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
              Amount due
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
            {dueBy ? (
              <Text
                style={{
                  ...typeStyle("legal"),
                  margin: 0,
                  marginTop: 4,
                  color: COLOR.textMuted,
                  fontSize: 11,
                }}
              >
                Due {dueBy}
              </Text>
            ) : null}
          </Column>
        </Row>
      </Section>

      {/* Primary CTA — the whole point of this email. Bulletproof <a>
          styled as a button (clients strip <button>). The hosted Stripe
          link handles the checkout flow end-to-end. */}
      <Section style={{ padding: `${SPACE.lg}px ${SPACE.xxxl}px` }}>
        <Link
          href={paymentUrl}
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
          Pay {amount} securely with Stripe →
        </Link>
        <Text
          style={{
            ...typeStyle("legal"),
            margin: 0,
            marginTop: SPACE.md,
            color: COLOR.textMuted,
            textAlign: "center",
            lineHeight: "16px",
          }}
        >
          Or paste this link into your browser:{" "}
          <Link
            href={paymentUrl}
            style={{
              color: COLOR.textMuted,
              wordBreak: "break-all",
            }}
          >
            {paymentUrl}
          </Link>
        </Text>
      </Section>

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
        <MetadataRow label="Provider" value={provider.name} />
        <MetadataRow
          label="Vehicle"
          value={`${vehicle.company} • ${vehicle.type}`}
        />
        <MetadataRow label="Pick-up" value={trip.pickupDate} />
        <MetadataRow label="Drop-off" value={trip.dropoffDate} isLast />
      </SummaryCard>

      {/* Optional agent note — only renders when something was typed. */}
      {note && note.trim().length > 0 ? (
        <Section style={{ padding: `${SPACE.md}px ${SPACE.xxxl}px` }}>
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
              Note from {brandName}
            </Text>
            <Text
              style={{
                ...typeStyle("body"),
                margin: 0,
                marginTop: 6,
                color: COLOR.textPrimary,
                whiteSpace: "pre-wrap",
              }}
            >
              {note}
            </Text>
          </div>
        </Section>
      ) : null}

      {/* Stripe trust line */}
      <Section style={{ padding: `${SPACE.xs}px ${SPACE.xxxl}px ${SPACE.xl}px` }}>
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

      <SupportSection
        orderNumber={orderNumber}
        supportEmail={supportEmail}
        supportPhone={supportPhone}
      />

      <EmailFooter brandName={brandName} supportEmail={supportEmail} />
    </EmailLayout>
  );
}

export default PaymentRequestEmail;
