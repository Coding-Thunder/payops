import { Column, Link, Row, Section, Text } from "@react-email/components";
import * as React from "react";

import { COLOR, RADIUS, SPACE, typeStyle } from "./tokens";

interface SupportSectionProps {
  orderNumber: string;
  supportEmail: string;
  supportPhone: string;
}

/**
 * Two-button support block: solid primary "Email us" with the order
 * number prefilled, outlined secondary "Call us". Uses styled <a>
 * tags because email clients strip <button>.
 */
export function SupportSection({
  orderNumber,
  supportEmail,
  supportPhone,
}: SupportSectionProps) {
  return (
    <Section style={{ padding: `0 ${SPACE.xxxl}px ${SPACE.xxl}px` }}>
      <Text
        style={{
          ...typeStyle("meta"),
          margin: 0,
          color: COLOR.textPrimary,
          fontWeight: 700,
        }}
      >
        Need help with this booking?
      </Text>
      <Text
        style={{
          ...typeStyle("label"),
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
            fontFamily:
              "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
            color: COLOR.textPrimary,
          }}
        >
          {orderNumber}
        </strong>{" "}
        in your message and we&apos;ll reply within one business day.
      </Text>

      <Row style={{ marginTop: SPACE.md + 2 }}>
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
              borderRadius: RADIUS.md,
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
              borderRadius: RADIUS.md,
              textDecoration: "none",
              letterSpacing: "-0.005em",
              border: `1px solid ${COLOR.border}`,
            }}
          >
            Call us
          </Link>
        </Column>
      </Row>
    </Section>
  );
}
