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

      {/* A brand that publishes no phone number gets a full-width "Email us"
          rather than a dead tel: link. Only a non-default organization can
          reach that state — the deployment always has both. */}
      <Row style={{ marginTop: SPACE.md + 2 }}>
        {supportEmail ? (
          <Column
            style={{
              width: supportPhone ? "50%" : "100%",
              paddingRight: supportPhone ? 6 : 0,
            }}
          >
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
        ) : null}
        {supportPhone ? (
          <Column
            style={{
              width: supportEmail ? "50%" : "100%",
              paddingLeft: supportEmail ? 6 : 0,
            }}
          >
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
        ) : null}
      </Row>

      {/* The number in plain text, not only behind the button.
          "Call us" carries it in a tel: href, which works in a mail client
          but leaves the number unreadable to anyone who prints the email,
          forwards it as text, or is using a client that strips tel: links.
          The support ADDRESS is already legible in the footer; the phone
          had no such line. */}
      {supportPhone ? (
        <Text
          style={{
            ...typeStyle("label"),
            margin: 0,
            marginTop: SPACE.sm,
            fontSize: 11,
            lineHeight: "16px",
            color: COLOR.textMuted,
          }}
        >
          Or call {supportPhone}.
        </Text>
      ) : null}
    </Section>
  );
}
