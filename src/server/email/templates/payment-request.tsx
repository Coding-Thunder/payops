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
  /** Image is rendered as a hero strip below the provider badge when
   *  set — same treatment the post-payment confirmation email uses,
   *  so the customer recognises the car they reserved as soon as they
   *  open either email. */
  vehicle: { company: string; type: string; imageUrl?: string | null };
  trip: {
    pickupDate: string;
    dropoffDate: string;
    pickupLocation?: string | null;
    dropoffLocation?: string | null;
  };
  /** Pre-formatted charge breakdown — shows what the customer pays online
   *  today vs what's due at the counter. */
  chargeBreakdown?: EmailChargeBreakdown;

  /** Hosted-checkout URL — kept on the props for caller compat; the
   *  template no longer renders it directly. The active CTA is
   *  `primaryCta`. */
  paymentUrl?: string;

  /** Human label for the payment gateway routing this charge. Surfaces
   *  in the trust line ("Payment processed securely via Stripe"). When
   *  omitted, the trust line falls back to a gateway-agnostic phrasing. */
  gatewayLabel?: string | null;

  /** All four are editable by the agent in the composer; if empty / null the
   *  template falls back to the code-default copy. */
  greeting?: string | null;
  intro?: string | null;
  note?: string | null;

  cancellationPolicy?: string;
  cancellationPolicyVersion?: string;

  /** Rental Terms & Conditions — rendered via the shared EmailTermsSection
   *  just before the footer (text only; the "I Agree" acknowledgement is
   *  confirmation-email-only). */
  termsText?: string | null;
  termsVersion?: string | null;

  /** Consent-first flow: callers compute the single primary CTA from the
   *  order's consent state and pass it here.
   *
   *  - primaryCta.url       — where the button lands. Hosted consent page
   *    when consent is still needed; Stripe checkout when consent has
   *    already been received (re-send case) or skipped by policy.
   *  - primaryCta.label     — button copy. "Review & Confirm Booking"
   *    for the consent variant; "Pay {amount} securely with Stripe →"
   *    for the post-consent variant.
   *  - primaryCta.helperText— tiny line under the button (e.g. the
   *    acknowledgement statement, or "Pays via Stripe").
   *
   *  Mailto remains, but only as a tertiary "Email us instead" link in
   *  the support footer. The email no longer carries a second visible
   *  CTA — single guided path. */
  primaryCta?: {
    url: string;
    label: string;
    helperText?: string | null;
  };
  consentMailto?: string | null;
  consentRequired?: boolean;
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
  chargeBreakdown,
  greeting,
  intro,
  note,
  cancellationPolicy,
  cancellationPolicyVersion,
  termsText,
  termsVersion,
  primaryCta,
  consentMailto,
  consentRequired,
  gatewayLabel,
}: PaymentRequestEmailProps) {
  const preview = `Complete payment for ${orderNumber} — ${amount}`;
  const policyParagraphs = cancellationPolicy
    ? cancellationPolicy.split(/\n+/).filter((p) => p.trim().length > 0)
    : [];
  const pickupValue = trip.pickupLocation
    ? `${trip.pickupDate} · ${trip.pickupLocation}`
    : trip.pickupDate;
  const dropoffValue = trip.dropoffLocation
    ? `${trip.dropoffDate} · ${trip.dropoffLocation}`
    : trip.dropoffDate;

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

      {/* Single primary CTA — consent-first handoff.
          - Default copy: "Review & Confirm Booking" → hosted consent page.
            The page records acknowledgement + IP/UA, then auto-redirects
            to Stripe Checkout. Stripe stays the payment processor; only
            the entry point moves upstream.
          - Re-send / RECEIVED case: caller swaps to the Stripe URL so a
            customer who already acknowledged jumps straight to payment.

          We deliberately ship one visible action. Splitting into "Pay
          Now" and "I Agree" created the UX ambiguity we just removed. */}
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
              href={primaryCta.url}
              style={{
                color: COLOR.textMuted,
                wordBreak: "break-all",
              }}
            >
              {primaryCta.url}
            </Link>
          </Text>
          {consentRequired ? (
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
              Confirmation is required before payment can be completed.
            </Text>
          ) : null}
          {consentMailto ? (
            <Text
              style={{
                ...typeStyle("legal"),
                margin: 0,
                marginTop: SPACE.sm,
                color: COLOR.textFaint,
                textAlign: "center",
                lineHeight: "16px",
                fontSize: 10,
              }}
            >
              Trouble with the button?{" "}
              <Link
                href={consentMailto}
                style={{
                  color: COLOR.textMuted,
                  textDecoration: "underline",
                }}
              >
                Confirm by email
              </Link>
              .
            </Text>
          ) : null}
        </Section>
      ) : null}

      <ProviderBadge
        provider={provider}
        appUrl={appUrl}
        caption={BookingTypeLabel[bookingType]}
      />

      {/* Car hero — same treatment the confirmation email uses, so the
          customer immediately recognises the vehicle they reserved. Only
          renders when the agent supplied an image URL at creation. */}
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
        <MetadataRow label="Drop-off" value={dropoffValue} isLast />
      </SummaryCard>

      {chargeBreakdown ? (
        <ChargeBreakdown
          breakdown={chargeBreakdown}
          title="What you're paying"
          topPadding={SPACE.md}
        />
      ) : null}

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

      {/* Trust line — gateway-aware. The processor name is interpolated
          from the gatewayLabel prop so adding Razorpay / PayPal etc.
          doesn't require touching the template body. */}
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
          {gatewayLabel
            ? `Payment processed securely via ${gatewayLabel}. Your card details are encrypted end-to-end and never stored on our servers.`
            : "Payment processed securely. Your card details are encrypted end-to-end and never stored on our servers."}
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

      {/* Shared Terms & Conditions — same component the confirmation email
          uses (text only here; no "I Agree" pre-payment). */}
      <EmailTermsSection termsText={termsText} termsVersion={termsVersion} />

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
