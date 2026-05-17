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

// Minimal "RC" wordmark + key/car glyph baked into a data URI so the brand
// renders without an external image host. Background is a deep navy that
// reads well in both light and dark email clients.
const LOGO_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCI+PHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiByeD0iMTAiIGZpbGw9IiMxMTE4MjciLz48cGF0aCBkPSJNMTAuNSAyOWgyN2EyIDIgMCAwIDAgMS41LTMuM2wtMy00LjJjLS41LS43LTEuMy0xLjEtMi4yLTEuMUgxNC4yYy0uOSAwLTEuNy40LTIuMiAxLjFsLTMgNC4yYTIgMiAwIDAgMCAxLjUgMy4zWiIgZmlsbD0iI2ZmZmZmZiIvPjxjaXJjbGUgY3g9IjE2IiBjeT0iMzIiIHI9IjIuMiIgZmlsbD0iIzExMTgyNyIvPjxjaXJjbGUgY3g9IjMyIiBjeT0iMzIiIHI9IjIuMiIgZmlsbD0iIzExMTgyNyIvPjxwYXRoIGQ9Ik0xNi41IDIwbDIuNy03YzAtLjUuNC0xIDEuMS0xaDcuM2MuNyAwIDEgLjUgMS4xIDFsMi43IDdIMTYuNVoiIGZpbGw9IiMxMTE4MjciLz48L3N2Zz4=";

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
  vehicle: { company: string; type: string };
  trip: { pickupDate: string; dropoffDate: string };
  receiptUrl?: string | null;
}

const COLORS = {
  bg: "#f4f6fa",
  card: "#ffffff",
  border: "#e6e9ee",
  headerBg: "#111827",
  headerText: "#ffffff",
  headerAccent: "#94a3b8",
  text: "#0f172a",
  muted: "#475569",
  faint: "#64748b",
  divider: "#e2e8f0",
  amountBg: "#f8fafc",
  primary: "#0f766e",
  link: "#0b6dd6",
};

export function PaymentConfirmationEmail({
  brandName,
  supportEmail,
  supportPhone,
  customerName,
  orderNumber,
  bookingType,
  amount,
  paidOn,
  vehicle,
  trip,
  receiptUrl,
}: PaymentConfirmationEmailProps) {
  const year = new Date().getFullYear();
  return (
    <Html>
      <Head />
      <Preview>{`${brandName} - payment confirmed - ${orderNumber} - ${amount}`}</Preview>
      <Tailwind>
        <Body
          style={{
            backgroundColor: COLORS.bg,
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
            margin: 0,
            padding: "32px 0",
          }}
        >
          <Container
            style={{
              backgroundColor: COLORS.card,
              maxWidth: 600,
              margin: "0 auto",
              borderRadius: 14,
              overflow: "hidden",
              border: `1px solid ${COLORS.border}`,
            }}
          >
            {/* Header band */}
            <Section
              style={{
                backgroundColor: COLORS.headerBg,
                padding: "22px 32px",
              }}
            >
              <Row>
                <Column width="44">
                  <Img
                    src={LOGO_DATA_URI}
                    width="36"
                    height="36"
                    alt={brandName}
                    style={{ borderRadius: 8, display: "block" }}
                  />
                </Column>
                <Column>
                  <Text
                    style={{
                      color: COLORS.headerText,
                      fontSize: 14,
                      fontWeight: 600,
                      letterSpacing: "0.18em",
                      textTransform: "uppercase",
                      margin: 0,
                      lineHeight: "20px",
                    }}
                  >
                    {brandName}
                  </Text>
                  <Text
                    style={{
                      color: COLORS.headerAccent,
                      fontSize: 11,
                      margin: 0,
                      marginTop: 2,
                      letterSpacing: "0.04em",
                    }}
                  >
                    Booking & payment confirmation
                  </Text>
                </Column>
              </Row>
            </Section>

            {/* Hero */}
            <Section style={{ padding: "32px 32px 8px 32px" }}>
              <Heading
                as="h1"
                style={{
                  color: COLORS.text,
                  fontSize: 24,
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                  margin: "0 0 8px 0",
                }}
              >
                Payment confirmed
              </Heading>
              <Text
                style={{
                  color: COLORS.muted,
                  fontSize: 14,
                  lineHeight: "22px",
                  margin: 0,
                }}
              >
                Hi {customerName}, we&apos;ve received your payment for{" "}
                <strong style={{ color: COLORS.text }}>
                  {BookingTypeLabel[bookingType]}
                </strong>
                . Keep this email as your receipt — your booking summary is
                below.
              </Text>
            </Section>

            {/* Amount + Order card */}
            <Section style={{ padding: "20px 32px 8px 32px" }}>
              <div
                style={{
                  backgroundColor: COLORS.amountBg,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 12,
                  padding: "18px 22px",
                }}
              >
                <Row>
                  <Column>
                    <Text
                      style={{
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        color: COLORS.faint,
                        margin: 0,
                      }}
                    >
                      Amount paid
                    </Text>
                    <Text
                      style={{
                        color: COLORS.text,
                        fontWeight: 600,
                        fontSize: 22,
                        margin: 0,
                        marginTop: 4,
                        lineHeight: "28px",
                      }}
                    >
                      {amount}
                    </Text>
                  </Column>
                  <Column align="right">
                    <Text
                      style={{
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: "0.08em",
                        color: COLORS.faint,
                        margin: 0,
                      }}
                    >
                      Order
                    </Text>
                    <Text
                      style={{
                        color: COLORS.text,
                        fontWeight: 600,
                        fontSize: 14,
                        fontFamily:
                          "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
                        margin: 0,
                        marginTop: 6,
                      }}
                    >
                      {orderNumber}
                    </Text>
                  </Column>
                </Row>
              </div>
            </Section>

            {/* Booking details */}
            <Section style={{ padding: "20px 32px 8px 32px" }}>
              <Text
                style={{
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: COLORS.faint,
                  margin: "0 0 12px 0",
                  fontWeight: 600,
                }}
              >
                Booking details
              </Text>
              <DetailRow
                label="Booking type"
                value={BookingTypeLabel[bookingType]}
              />
              <DetailRow
                label="Vehicle"
                value={`${vehicle.company} • ${vehicle.type}`}
              />
              <DetailRow label="Pick-up" value={trip.pickupDate} />
              <DetailRow label="Drop-off" value={trip.dropoffDate} />
              <DetailRow label="Paid on" value={paidOn} />
            </Section>

            {/* Receipt CTA */}
            {receiptUrl ? (
              <Section style={{ padding: "10px 32px 20px 32px" }}>
                <Link
                  href={receiptUrl}
                  style={{
                    display: "inline-block",
                    color: COLORS.headerText,
                    backgroundColor: COLORS.headerBg,
                    padding: "10px 18px",
                    borderRadius: 8,
                    textDecoration: "none",
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  View Stripe receipt →
                </Link>
              </Section>
            ) : null}

            <Hr
              style={{
                borderColor: COLORS.divider,
                margin: "8px 32px",
              }}
            />

            {/* Support */}
            <Section style={{ padding: "16px 32px 8px 32px" }}>
              <Text
                style={{
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: COLORS.faint,
                  margin: "0 0 8px 0",
                  fontWeight: 600,
                }}
              >
                Need help?
              </Text>
              <Text
                style={{
                  color: COLORS.muted,
                  fontSize: 13,
                  lineHeight: "22px",
                  margin: 0,
                }}
              >
                Reply to this email or reach our team at{" "}
                <Link
                  href={`mailto:${supportEmail}`}
                  style={{ color: COLORS.link, textDecoration: "underline" }}
                >
                  {supportEmail}
                </Link>{" "}
                · {supportPhone}. Please include your order number{" "}
                <strong style={{ color: COLORS.text }}>{orderNumber}</strong>{" "}
                so we can pull up your booking faster.
              </Text>
            </Section>

            <Hr
              style={{
                borderColor: COLORS.divider,
                margin: "16px 32px 0 32px",
              }}
            />

            {/* Footer */}
            <Section
              style={{
                padding: "20px 32px 28px 32px",
                textAlign: "center",
              }}
            >
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: COLORS.text,
                  letterSpacing: "0.04em",
                  margin: 0,
                }}
              >
                {brandName}
              </Text>
              <Text
                style={{
                  fontSize: 11,
                  color: COLORS.faint,
                  margin: 0,
                  marginTop: 4,
                  lineHeight: "18px",
                }}
              >
                © {year} {brandName}. All rights reserved.
              </Text>
              <Text
                style={{
                  fontSize: 10,
                  color: COLORS.faint,
                  margin: 0,
                  marginTop: 10,
                  lineHeight: "16px",
                }}
              >
                This is a transactional confirmation sent in response to your
                booking. You&apos;re receiving it because you completed a
                payment with {brandName} — no marketing list involved.
              </Text>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <Row>
      <Column style={{ paddingBottom: 10, verticalAlign: "top" }}>
        <Text
          style={{
            fontSize: 12,
            color: COLORS.faint,
            margin: 0,
          }}
        >
          {label}
        </Text>
      </Column>
      <Column
        align="right"
        style={{ paddingBottom: 10, verticalAlign: "top" }}
      >
        <Text
          style={{
            fontSize: 13,
            color: COLORS.text,
            fontWeight: 500,
            margin: 0,
          }}
        >
          {value}
        </Text>
      </Column>
    </Row>
  );
}

export default PaymentConfirmationEmail;
