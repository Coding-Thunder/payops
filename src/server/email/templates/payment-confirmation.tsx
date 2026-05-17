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
import {
  resolveProvider,
  type ProviderSnapshot,
} from "@/lib/constants/providers";

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
  trip: { pickupDate: string; dropoffDate: string };
  receiptUrl?: string | null;
  cancellationPolicy?: string;
  cancellationPolicyVersion?: string;
}

// ────────────────────────────────────────────────────────────────────────
// Monochrome token palette. The template is deliberately drained of brand
// color — sharp typographic hierarchy carries the layout instead of
// stacked colored bands.
// ────────────────────────────────────────────────────────────────────────
const COLOR = {
  page: "#f6f7f9",
  surface: "#ffffff",
  surfaceMuted: "#fafbfc",
  border: "#e6e8eb",
  borderSoft: "#eef0f3",
  textPrimary: "#0f172a",
  textSecondary: "#475569",
  textMuted: "#6b7280",
  textInverted: "#ffffff",
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
  const preview = `${brandName} — payment confirmed for ${orderNumber} (${amount})`;
  const year = new Date().getUTCFullYear();
  const policyParagraphs = cancellationPolicy
    ? cancellationPolicy.split(/\n+/).filter((p) => p.trim().length > 0)
    : [];
  const providerMeta = resolveProvider(provider ?? undefined);
  const providerLogoUrl = absoluteUrl(appUrl, providerMeta.logo);

  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Tailwind>
        <Body
          style={{
            backgroundColor: COLOR.page,
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, Arial, sans-serif",
            margin: 0,
            padding: "32px 12px",
            color: COLOR.textPrimary,
          }}
        >
          <Container
            style={{
              backgroundColor: COLOR.surface,
              borderRadius: 8,
              maxWidth: 600,
              margin: "0 auto",
              border: `1px solid ${COLOR.border}`,
              overflow: "hidden",
            }}
          >
            {/* ─── Header — single line, no color band ─── */}
            <Section
              style={{
                padding: "20px 32px",
                borderBottom: `1px solid ${COLOR.border}`,
              }}
            >
              <Text
                style={{
                  margin: 0,
                  fontSize: 15,
                  fontWeight: 700,
                  letterSpacing: "-0.01em",
                  color: COLOR.textPrimary,
                  lineHeight: "20px",
                }}
              >
                {brandName}
              </Text>
              <Text
                style={{
                  margin: 0,
                  marginTop: 4,
                  color: COLOR.textMuted,
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  lineHeight: "14px",
                }}
              >
                Payment receipt
              </Text>
            </Section>

            {/* ─── Provider strip — neutral surface, logo only ─── */}
            <Section
              style={{
                padding: "16px 32px",
                borderBottom: `1px solid ${COLOR.borderSoft}`,
                backgroundColor: COLOR.surfaceMuted,
              }}
            >
              <Row>
                <Column
                  style={{
                    width: 56,
                    paddingRight: 14,
                    verticalAlign: "middle",
                  }}
                >
                  <Img
                    src={providerLogoUrl}
                    width="44"
                    height="44"
                    alt={providerMeta.name}
                    style={{
                      display: "block",
                      borderRadius: 6,
                      backgroundColor: COLOR.surface,
                      border: `1px solid ${COLOR.border}`,
                      padding: 4,
                      boxSizing: "border-box",
                    }}
                  />
                </Column>
                <Column style={{ verticalAlign: "middle" }}>
                  <Text
                    style={{
                      margin: 0,
                      fontSize: 14,
                      fontWeight: 600,
                      color: COLOR.textPrimary,
                      lineHeight: "18px",
                    }}
                  >
                    {providerMeta.name}
                  </Text>
                  <Text
                    style={{
                      margin: 0,
                      marginTop: 2,
                      fontSize: 11,
                      color: COLOR.textMuted,
                      lineHeight: "14px",
                    }}
                  >
                    {BookingTypeLabel[bookingType]}
                  </Text>
                </Column>
              </Row>
            </Section>

            {/* ─── Vehicle hero (optional) ─── */}
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

            {/* ─── Confirmation copy ─── */}
            <Section style={{ padding: "32px 32px 12px" }}>
              <Text
                style={{
                  margin: 0,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: COLOR.textMuted,
                }}
              >
                Payment confirmed
              </Text>
              <Heading
                as="h1"
                style={{
                  margin: 0,
                  marginTop: 10,
                  color: COLOR.textPrimary,
                  fontSize: 24,
                  fontWeight: 700,
                  lineHeight: "30px",
                  letterSpacing: "-0.02em",
                }}
              >
                Thank you, {customerName}.
              </Heading>
              <Text
                style={{
                  margin: 0,
                  marginTop: 10,
                  color: COLOR.textSecondary,
                  fontSize: 14,
                  lineHeight: "22px",
                }}
              >
                We&apos;ve received your payment for{" "}
                <strong style={{ color: COLOR.textPrimary }}>
                  {BookingTypeLabel[bookingType].toLowerCase()}
                </strong>
                . Your booking details are below — please keep this email for
                your records.
              </Text>
            </Section>

            {/* ─── Amount + Order (flat, no color box) ─── */}
            <Section style={{ padding: "12px 32px 4px" }}>
              <Row>
                <Column style={{ verticalAlign: "top" }}>
                  <Text
                    style={{
                      margin: 0,
                      color: COLOR.textMuted,
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
                      marginTop: 6,
                      color: COLOR.textPrimary,
                      fontSize: 30,
                      fontWeight: 700,
                      letterSpacing: "-0.025em",
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
                      color: COLOR.textMuted,
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
                      marginTop: 6,
                      color: COLOR.textPrimary,
                      fontSize: 13,
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
                      color: COLOR.textMuted,
                      fontSize: 11,
                    }}
                  >
                    {paidOn}
                  </Text>
                </Column>
              </Row>
            </Section>

            <Hr
              style={{
                margin: "24px 32px 0",
                borderColor: COLOR.borderSoft,
                borderTopWidth: 1,
              }}
            />

            {/* ─── Booking details ─── */}
            <Section style={{ padding: "20px 32px 4px" }}>
              <Heading
                as="h2"
                style={{
                  margin: 0,
                  marginBottom: 6,
                  color: COLOR.textMuted,
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.10em",
                  textTransform: "uppercase",
                }}
              >
                Booking details
              </Heading>
              <DetailRow label="Type" value={BookingTypeLabel[bookingType]} />
              <DetailRow label="Provider" value={providerMeta.name} />
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
            </Section>

            {/* ─── Stripe attribution — single line, no card ─── */}
            <Section style={{ padding: "8px 32px 24px" }}>
              <Text
                style={{
                  margin: 0,
                  color: COLOR.textMuted,
                  fontSize: 11,
                  lineHeight: "16px",
                }}
              >
                Payment processed securely by Stripe — PCI-DSS Level 1
                certified. Your card details are encrypted end-to-end and
                never stored on our servers.
              </Text>
            </Section>

            {/* ─── Cancellation policy ─── */}
            {policyParagraphs.length > 0 ? (
              <>
                <Hr
                  style={{
                    margin: 0,
                    borderColor: COLOR.borderSoft,
                    borderTopWidth: 1,
                  }}
                />
                <Section style={{ padding: "20px 32px" }}>
                  <Heading
                    as="h2"
                    style={{
                      margin: 0,
                      marginBottom: 10,
                      color: COLOR.textMuted,
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
                        margin: 0,
                        marginTop: 12,
                        color: COLOR.textMuted,
                        fontSize: 10,
                        letterSpacing: "0.04em",
                      }}
                    >
                      Policy version {cancellationPolicyVersion} • applied at
                      payment
                    </Text>
                  ) : null}
                </Section>
              </>
            ) : null}

            {/* ─── Footer / support ─── */}
            <Section
              style={{
                padding: "22px 32px 28px",
                borderTop: `1px solid ${COLOR.border}`,
                backgroundColor: COLOR.surfaceMuted,
              }}
            >
              <Text
                style={{
                  margin: 0,
                  color: COLOR.textPrimary,
                  fontSize: 13,
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
                  color: COLOR.textSecondary,
                  fontSize: 12,
                  lineHeight: "18px",
                }}
              >
                Reference order{" "}
                <strong
                  style={{
                    fontFamily: "ui-monospace, SFMono-Regular, monospace",
                    color: COLOR.textPrimary,
                  }}
                >
                  {orderNumber}
                </strong>{" "}
                in your message and we&apos;ll reply within one business day.
              </Text>

              <Row style={{ marginTop: 14 }}>
                <Column style={{ width: "50%", paddingRight: 6 }}>
                  <Link
                    href={`mailto:${supportEmail}?subject=${encodeURIComponent(
                      `Help with order ${orderNumber}`,
                    )}&body=${encodeURIComponent(
                      `Hi,\n\nI need help with order ${orderNumber}.\n\n`,
                    )}`}
                    style={{
                      display: "inline-block",
                      backgroundColor: COLOR.textPrimary,
                      color: COLOR.textInverted,
                      fontSize: 12,
                      fontWeight: 600,
                      padding: "9px 16px",
                      borderRadius: 6,
                      textDecoration: "none",
                      letterSpacing: "-0.005em",
                    }}
                  >
                    Email us
                  </Link>
                </Column>
                <Column style={{ width: "50%", paddingLeft: 6 }}>
                  <Link
                    href={`tel:${supportPhone.replace(/[^\d+]/g, "")}`}
                    style={{
                      display: "inline-block",
                      backgroundColor: COLOR.surface,
                      color: COLOR.textPrimary,
                      fontSize: 12,
                      fontWeight: 600,
                      padding: "8px 15px",
                      borderRadius: 6,
                      textDecoration: "none",
                      letterSpacing: "-0.005em",
                      border: `1px solid ${COLOR.border}`,
                    }}
                  >
                    Call us
                  </Link>
                </Column>
              </Row>

              <Hr
                style={{
                  margin: "22px 0 14px",
                  borderColor: COLOR.borderSoft,
                  borderTopWidth: 1,
                }}
              />

              <Text
                style={{
                  margin: 0,
                  color: COLOR.textMuted,
                  fontSize: 10,
                  lineHeight: "15px",
                }}
              >
                © {year} {brandName}. Automated payment receipt — replies
                route to our support team. Powered by Stripe.
              </Text>
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
    paddingTop: 10,
    paddingBottom: 10,
    borderBottom: isLast ? "none" : `1px solid ${COLOR.borderSoft}`,
    verticalAlign: "middle",
  };
  return (
    <Row>
      <Column style={{ ...cellStyle, width: "40%" }}>
        <Text
          style={{
            margin: 0,
            color: COLOR.textMuted,
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
            color: COLOR.textPrimary,
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

function absoluteUrl(base: string, path: string): string {
  if (path.startsWith("data:")) return path;
  if (/^https?:\/\//i.test(path)) return path;
  const trimmedBase = base.replace(/\/+$/, "");
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

export default PaymentConfirmationEmail;
