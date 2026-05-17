import {
  Body,
  Column,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Row,
  Section,
  Tailwind,
  Text,
} from "@react-email/components";
import * as React from "react";

import { BookingTypeLabel } from "@/lib/constants/labels";
import type { BookingType } from "@/lib/constants/enums";
import type { ProviderSnapshot } from "@/lib/constants/providers";

import { EmailProviderHeader } from "@/components/features/providers/email-provider-header";

// Stripe "S" mark — official rounded-square logo in their brand purple.
// Inlined as a data URI so it renders in every email client (Gmail,
// Outlook, Apple Mail) without depending on an external asset host.
const STRIPE_LOGO_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMCIgaGVpZ2h0PSIyMCIgdmlld0JveD0iMCAwIDMyIDMyIj48cmVjdCB3aWR0aD0iMzIiIGhlaWdodD0iMzIiIHJ4PSI3IiBmaWxsPSIjNjM1QkZGIi8+PHBhdGggZmlsbD0iI0ZGRiIgZD0iTTE0LjQxIDEyLjdjMC0uODQuNjktMS4xNiAxLjgzLTEuMTYgMS42MyAwIDMuNy41IDUuMzQgMS4zOFY3Ljg3Yy0xLjc4LS43MS0zLjU1LS45OS01LjM0LS45OS00LjM1IDAtNy4yNSAyLjI3LTcuMjUgNi4wNiAwIDUuOTEgOC4xMyA0Ljk2IDguMTMgNy41MSAwIC45OS0uODYgMS4zMi0yLjA3IDEuMzItMS43OCAwLTQuMDYtLjczLTUuODctMS43MXY1LjEyYzIgLjg1IDQuMDIgMS4yMSA1Ljg3IDEuMjEgNC40NyAwIDcuNTMtMi4yMSA3LjUzLTYuMDYgMC02LjM2LTguMTctNS4yMy04LjE3LTcuNjF6Ii8+PC9zdmc+";

// Inline lock-shield icon for the "secure payment" trust block.
const LOCK_ICON_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMxNTk5NjkiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTIgMjJzOC00IDgtMTBWNWwtOC0zLTggM3Y3YzAgNiA4IDEwIDggMTAiLz48cGF0aCBkPSJtOSAxMiAyIDIgNC00Ii8+PC9zdmc+";

// Inline checkmark icon for the "Payment confirmed" pill.
const CHECK_ICON_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMiIgaGVpZ2h0PSIxMiIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMwZTlmNmUiIHN0cm9rZS13aWR0aD0iMyIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMjAgNiA5IDE3bC01LTUiLz48L3N2Zz4=";

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
  /** Rental brand snapshot. Drives the colour band + logo strip directly
   *  under the operator header so the receipt feels co-branded. */
  provider: ProviderSnapshot;
  vehicle: { company: string; type: string; imageUrl?: string | null };
  trip: { pickupDate: string; dropoffDate: string };
  receiptUrl?: string | null;
  /** Free-text cancellation/refund policy snapshot. Rendered as a paragraph
   *  inside the policy section. Pass an empty string to omit the section. */
  cancellationPolicy?: string;
  /** Policy version label (e.g. "v2") rendered in the email footer for
   *  dispute-evidence purposes. */
  cancellationPolicyVersion?: string;
}

// ────────────────────────────────────────────────────────────────────────
// Token palette — kept inline so the email renders identically in clients
// that strip <style>/Tailwind. Everything is hex; Gmail-safe.
// ────────────────────────────────────────────────────────────────────────
const TOKENS = {
  background: "#eef1f6",
  surface: "#ffffff",
  surfaceMuted: "#f8f9fb",
  surfaceSubtle: "#f1f4f9",
  border: "#e5e7eb",
  borderSoft: "#eef0f4",
  textPrimary: "#0f172a",
  textSecondary: "#475569",
  textMuted: "#64748b",
  textInverted: "#ffffff",
  brand: "#2563eb", // Tailwind blue-600
  brandSoft: "#e3eefc",
  brandDark: "#0b1220", // near-black navy for the brand header bar
  brandSubtle: "#94a3b8", // muted slate for header eyebrow text
  success: "#0e9f6e",
  successSoft: "#ecfdf5",
  successBorder: "#bbf7d0",
  stripe: "#635BFF", // Stripe brand purple
  stripeSoft: "#eef0ff",
};

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
  receiptUrl,
  cancellationPolicy,
  cancellationPolicyVersion,
}: PaymentConfirmationEmailProps) {
  const preview = `${provider.name} — payment confirmed for ${orderNumber} (${amount})`;
  const year = new Date().getUTCFullYear();
  const policyParagraphs = cancellationPolicy
    ? cancellationPolicy.split(/\n+/).filter((p) => p.trim().length > 0)
    : [];

  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Tailwind>
        <Body
          style={{
            backgroundColor: TOKENS.background,
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, Arial, sans-serif",
            margin: 0,
            padding: "40px 12px",
            color: TOKENS.textPrimary,
          }}
        >
          <Container
            style={{
              backgroundColor: TOKENS.surface,
              borderRadius: 16,
              maxWidth: 620,
              margin: "0 auto",
              border: `1px solid ${TOKENS.border}`,
              overflow: "hidden",
              boxShadow:
                "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.06)",
            }}
          >
            {/* ───────── Header band — split-color wordmark on dark navy.
                The image logo was removed; the brand identity is the text
                itself: "Rental" in blue-600 + "Confirmation" in white. ── */}
            <Section
              style={{
                padding: "26px 32px",
                backgroundColor: TOKENS.brandDark,
                borderBottom: `1px solid ${TOKENS.brandDark}`,
              }}
            >
              <Row>
                <Column>
                  <Text
                    style={{
                      margin: 0,
                      fontSize: 22,
                      fontWeight: 700,
                      letterSpacing: "-0.015em",
                      lineHeight: "26px",
                    }}
                  >
                    <span style={{ color: TOKENS.brand }}>Rental</span>
                    <span style={{ color: TOKENS.textInverted }}>
                      &nbsp;Confirmation
                    </span>
                  </Text>
                  <Text
                    style={{
                      margin: 0,
                      marginTop: 6,
                      color: TOKENS.brandSubtle,
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: "0.12em",
                      textTransform: "uppercase",
                      lineHeight: "14px",
                    }}
                  >
                    Payment receipt
                  </Text>
                </Column>
              </Row>
            </Section>

            {/* Thin accent strip — visual tie between the dark header and
                the white body. Solid blue rather than a gradient because
                CSS gradients are unreliable across email clients. */}
            <div
              style={{
                height: 3,
                backgroundColor: TOKENS.brand,
                lineHeight: "3px",
                fontSize: 0,
              }}
            >
              &nbsp;
            </div>

            {/* ───────── Rental provider strip ─────────
                Sits between the operator header and the receipt body so
                the customer immediately sees which brand the booking is
                with. Image is loaded from an absolute URL so Gmail/Apple
                Mail/Outlook can fetch it; the brand-colour background is
                the visual fallback when images are blocked. */}
            <EmailProviderHeader
              provider={provider}
              appUrl={appUrl}
              eyebrow={`${BookingTypeLabel[bookingType]} booking`}
            />

            {/* ───────── Vehicle hero image (optional) ─────────
                If the operator captured a public car image at order
                creation, show it edge-to-edge in a fixed-height frame so
                wildly different aspect ratios still produce a clean
                receipt. We render the absolute URL the operator supplied
                — these are already publicly fetchable by design, no
                proxying required. Falls back to nothing when absent. */}
            {vehicle.imageUrl ? (
              <Section style={{ padding: 0 }}>
                <Img
                  src={vehicle.imageUrl}
                  alt={`${vehicle.company} ${vehicle.type}`}
                  width="620"
                  height="240"
                  style={{
                    display: "block",
                    width: "100%",
                    height: "240px",
                    objectFit: "cover",
                    backgroundColor: TOKENS.surfaceMuted,
                    borderBottom: `1px solid ${TOKENS.borderSoft}`,
                  }}
                />
              </Section>
            ) : null}

            {/* ───────── Confirmation copy ───────── */}
            <Section style={{ padding: "32px 32px 8px" }}>
              <table
                role="presentation"
                cellPadding="0"
                cellSpacing="0"
                style={{
                  borderCollapse: "collapse",
                  marginBottom: 18,
                }}
              >
                <tbody>
                  <tr>
                    <td
                      style={{
                        backgroundColor: TOKENS.successSoft,
                        border: `1px solid ${TOKENS.successBorder}`,
                        borderRadius: 999,
                        padding: "5px 12px 5px 10px",
                        verticalAlign: "middle",
                      }}
                    >
                      <Img
                        src={CHECK_ICON_DATA_URI}
                        width="12"
                        height="12"
                        alt=""
                        style={{
                          verticalAlign: "middle",
                          marginRight: 6,
                          display: "inline-block",
                        }}
                      />
                      <span
                        style={{
                          color: TOKENS.success,
                          fontSize: 11,
                          fontWeight: 700,
                          letterSpacing: "0.06em",
                          textTransform: "uppercase",
                          verticalAlign: "middle",
                        }}
                      >
                        Payment confirmed
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
              <Heading
                as="h1"
                style={{
                  margin: 0,
                  color: TOKENS.textPrimary,
                  fontSize: 26,
                  fontWeight: 700,
                  lineHeight: "34px",
                  letterSpacing: "-0.02em",
                }}
              >
                Thank you, {customerName}.
              </Heading>
              <Text
                style={{
                  marginTop: 12,
                  marginBottom: 0,
                  color: TOKENS.textSecondary,
                  fontSize: 14,
                  lineHeight: "22px",
                }}
              >
                We&apos;ve received your payment for{" "}
                <strong style={{ color: TOKENS.textPrimary }}>
                  {BookingTypeLabel[bookingType].toLowerCase()}
                </strong>
                . Your booking details are below — keep this email for your
                records.
              </Text>
            </Section>

            {/* ───────── Amount hero block ───────── */}
            <Section style={{ padding: "20px 32px" }}>
              <div
                style={{
                  backgroundColor: TOKENS.brandSoft,
                  borderRadius: 14,
                  padding: "22px 26px",
                  border: `1px solid #cfe0fb`,
                }}
              >
                <Row>
                  <Column>
                    <Text
                      style={{
                        margin: 0,
                        color: TOKENS.textMuted,
                        fontSize: 11,
                        fontWeight: 600,
                        letterSpacing: "0.10em",
                        textTransform: "uppercase",
                      }}
                    >
                      Amount paid
                    </Text>
                    <Text
                      style={{
                        margin: 0,
                        marginTop: 8,
                        color: TOKENS.textPrimary,
                        fontSize: 30,
                        fontWeight: 700,
                        letterSpacing: "-0.02em",
                        lineHeight: "34px",
                      }}
                    >
                      {amount}
                    </Text>
                  </Column>
                  <Column align="right" style={{ verticalAlign: "top" }}>
                    <Text
                      style={{
                        margin: 0,
                        color: TOKENS.textMuted,
                        fontSize: 11,
                        fontWeight: 600,
                        letterSpacing: "0.10em",
                        textTransform: "uppercase",
                      }}
                    >
                      Order
                    </Text>
                    <Text
                      style={{
                        margin: 0,
                        marginTop: 8,
                        color: TOKENS.textPrimary,
                        fontSize: 14,
                        fontWeight: 700,
                        fontFamily: "ui-monospace, SFMono-Regular, monospace",
                      }}
                    >
                      {orderNumber}
                    </Text>
                    <Text
                      style={{
                        margin: 0,
                        marginTop: 4,
                        color: TOKENS.textMuted,
                        fontSize: 11,
                      }}
                    >
                      {paidOn}
                    </Text>
                  </Column>
                </Row>
              </div>
            </Section>

            {/* ───────── Booking details ───────── */}
            <Section style={{ padding: "10px 32px 24px" }}>
              <Heading
                as="h2"
                style={{
                  margin: 0,
                  marginBottom: 12,
                  color: TOKENS.textMuted,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.10em",
                  textTransform: "uppercase",
                }}
              >
                Booking details
              </Heading>
              <DetailRow
                label="Type"
                value={BookingTypeLabel[bookingType]}
              />
              <DetailRow label="Provider" value={provider.name} />
              <DetailRow
                label="Vehicle"
                value={`${vehicle.company} • ${vehicle.type}`}
              />
              <DetailRow label="Pick-up" value={trip.pickupDate} />
              <DetailRow
                label="Drop-off"
                value={trip.dropoffDate}
                isLast={!receiptUrl}
              />
              {receiptUrl ? (
                <DetailRow
                  label="Stripe receipt"
                  value={
                    <Link
                      href={receiptUrl}
                      style={{
                        color: TOKENS.brand,
                        textDecoration: "underline",
                      }}
                    >
                      View receipt
                    </Link>
                  }
                  isLast
                />
              ) : null}
            </Section>

            {/* ───────── Secure payment trust block ─────────
                Card-shaped block that reassures the customer the
                transaction is encrypted end-to-end. Inline Stripe logo
                anchors the trust signal — bank-grade credibility in
                under two seconds of scanning. */}
            <Section style={{ padding: "0 32px 24px" }}>
              <div
                style={{
                  backgroundColor: TOKENS.stripeSoft,
                  borderRadius: 14,
                  padding: "18px 22px",
                  border: `1px solid #dadcff`,
                }}
              >
                <Row>
                  <Column style={{ width: 36, verticalAlign: "top" }}>
                    <Img
                      src={LOCK_ICON_DATA_URI}
                      width="18"
                      height="18"
                      alt=""
                      style={{ display: "block", marginTop: 2 }}
                    />
                  </Column>
                  <Column style={{ verticalAlign: "top" }}>
                    <Text
                      style={{
                        margin: 0,
                        color: TOKENS.textPrimary,
                        fontSize: 13,
                        fontWeight: 700,
                        lineHeight: "18px",
                      }}
                    >
                      Payment is made and secured by{" "}
                      <Img
                        src={STRIPE_LOGO_DATA_URI}
                        width="16"
                        height="16"
                        alt="Stripe"
                        style={{
                          display: "inline-block",
                          verticalAlign: "-3px",
                          marginLeft: 2,
                          marginRight: 4,
                          borderRadius: 4,
                        }}
                      />
                      <span style={{ color: TOKENS.stripe }}>Stripe</span>
                    </Text>
                    <Text
                      style={{
                        margin: 0,
                        marginTop: 6,
                        color: TOKENS.textSecondary,
                        fontSize: 12,
                        lineHeight: "18px",
                      }}
                    >
                      Your card details are encrypted end-to-end and never
                      seen or stored by us. Stripe is PCI-DSS Level 1
                      certified — the highest level of payment security.
                    </Text>
                  </Column>
                </Row>
              </div>
            </Section>

            {/* ───────── Cancellation policy ───────── */}
            {policyParagraphs.length > 0 ? (
              <>
                <Hr
                  style={{
                    margin: 0,
                    borderColor: TOKENS.borderSoft,
                    borderTopWidth: 1,
                  }}
                />
                <Section style={{ padding: "24px 32px" }}>
                  <Heading
                    as="h2"
                    style={{
                      margin: 0,
                      marginBottom: 12,
                      color: TOKENS.textMuted,
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: "0.10em",
                      textTransform: "uppercase",
                    }}
                  >
                    Cancellation &amp; refund policy
                  </Heading>
                  {policyParagraphs.map((paragraph, idx) => (
                    <Text
                      key={idx}
                      style={{
                        margin: 0,
                        marginTop: idx === 0 ? 0 : 8,
                        color: TOKENS.textSecondary,
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
                        margin: 0,
                        marginTop: 12,
                        color: TOKENS.textMuted,
                        fontSize: 11,
                      }}
                    >
                      Policy version {cancellationPolicyVersion} • applied at
                      payment
                    </Text>
                  ) : null}
                </Section>
              </>
            ) : null}

            {/* ───────── Footer ───────── */}
            <Section
              style={{
                padding: "24px 32px 28px",
                borderTop: `1px solid ${TOKENS.border}`,
                backgroundColor: TOKENS.surfaceMuted,
              }}
            >
              <Text
                style={{
                  margin: 0,
                  color: TOKENS.textPrimary,
                  fontSize: 14,
                  fontWeight: 700,
                  letterSpacing: "-0.005em",
                }}
              >
                Need help with this booking?
              </Text>
              <Text
                style={{
                  margin: 0,
                  marginTop: 6,
                  color: TOKENS.textSecondary,
                  fontSize: 13,
                  lineHeight: "20px",
                }}
              >
                Please quote order number{" "}
                <strong
                  style={{
                    fontFamily: "ui-monospace, SFMono-Regular, monospace",
                    color: TOKENS.textPrimary,
                  }}
                >
                  {orderNumber}
                </strong>{" "}
                in your message and we&apos;ll respond within one business
                day.
              </Text>

              {/* Action buttons — bulletproof email-friendly anchors.
                  Email clients strip <button>, so we use styled <a>
                  tags. Subject + body are pre-filled on the mailto so
                  support gets the order context automatically. */}
              <Row style={{ marginTop: 16 }}>
                <Column style={{ width: "50%", paddingRight: 8 }}>
                  <Link
                    href={`mailto:${supportEmail}?subject=${encodeURIComponent(
                      `Help with order ${orderNumber}`,
                    )}&body=${encodeURIComponent(
                      `Hi,\n\nI need help with order ${orderNumber}.\n\n`,
                    )}`}
                    style={{
                      display: "inline-block",
                      backgroundColor: TOKENS.brand,
                      color: TOKENS.textInverted,
                      fontSize: 13,
                      fontWeight: 600,
                      padding: "11px 20px",
                      borderRadius: 8,
                      textDecoration: "none",
                      letterSpacing: "-0.005em",
                    }}
                  >
                    Email us
                  </Link>
                </Column>
                <Column style={{ width: "50%", paddingLeft: 8 }}>
                  <Link
                    href={`tel:${supportPhone.replace(/[^\d+]/g, "")}`}
                    style={{
                      display: "inline-block",
                      backgroundColor: TOKENS.surface,
                      color: TOKENS.textPrimary,
                      fontSize: 13,
                      fontWeight: 600,
                      padding: "10px 19px",
                      borderRadius: 8,
                      textDecoration: "none",
                      letterSpacing: "-0.005em",
                      border: `1px solid ${TOKENS.border}`,
                    }}
                  >
                    Call us
                  </Link>
                </Column>
              </Row>

              <Hr
                style={{
                  margin: "22px 0 18px",
                  borderColor: TOKENS.borderSoft,
                  borderTopWidth: 1,
                }}
              />

              <Row>
                <Column>
                  <Text
                    style={{
                      margin: 0,
                      color: TOKENS.textMuted,
                      fontSize: 11,
                      lineHeight: "16px",
                    }}
                  >
                    © {year} {brandName}. This is an automated payment
                    receipt. You can reply to this email — it routes to our
                    support team.
                  </Text>
                </Column>
                <Column align="right" style={{ width: 110 }}>
                  <Text
                    style={{
                      margin: 0,
                      color: TOKENS.textMuted,
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: "0.04em",
                      lineHeight: "16px",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Powered by{" "}
                    <Img
                      src={STRIPE_LOGO_DATA_URI}
                      width="12"
                      height="12"
                      alt="Stripe"
                      style={{
                        display: "inline-block",
                        verticalAlign: "-2px",
                        marginRight: 3,
                        borderRadius: 3,
                      }}
                    />
                    <span style={{ color: TOKENS.stripe, fontWeight: 700 }}>
                      Stripe
                    </span>
                  </Text>
                </Column>
              </Row>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}

function DetailRow({
  label,
  value,
  isLast,
}: {
  label: string;
  value: React.ReactNode;
  isLast?: boolean;
}) {
  const cellStyle: React.CSSProperties = {
    paddingTop: 11,
    paddingBottom: 11,
    borderBottom: isLast ? "none" : `1px solid ${TOKENS.borderSoft}`,
    verticalAlign: "middle",
  };
  return (
    <Row>
      <Column style={{ ...cellStyle, width: "40%" }}>
        <Text
          style={{
            margin: 0,
            color: TOKENS.textMuted,
            fontSize: 12,
            fontWeight: 500,
          }}
        >
          {label}
        </Text>
      </Column>
      <Column style={{ ...cellStyle, textAlign: "right" }}>
        <Text
          style={{
            margin: 0,
            color: TOKENS.textPrimary,
            fontSize: 13,
            fontWeight: 600,
            wordBreak: "break-word",
          }}
        >
          {value}
        </Text>
      </Column>
    </Row>
  );
}

export default PaymentConfirmationEmail;
