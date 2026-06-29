import { Link, Section, Text } from "@react-email/components";
import * as React from "react";

import { COLOR, RADIUS, SPACE, typeStyle } from "./tokens";

interface EmailAgreeButtonProps {
  /** Signed public acknowledgement URL (/acknowledge/[token]). */
  acknowledgeUrl: string;
  termsVersion?: string | null;
}

/**
 * Prominent "I Agree" acknowledgement call-to-action. Placed HIGH in the
 * confirmation email (right after the booking summary) so the required action
 * is immediately visible without scrolling — the full Terms & Conditions text
 * still sits at the bottom of the email (EmailTermsSection). Single source of
 * the acknowledgement-button markup.
 */
export function EmailAgreeButton({
  acknowledgeUrl,
  termsVersion,
}: EmailAgreeButtonProps) {
  return (
    <Section style={{ padding: `${SPACE.md}px ${SPACE.xxxl}px ${SPACE.lg}px` }}>
      <Section
        style={{
          backgroundColor: COLOR.surfaceMuted,
          border: `1px solid ${COLOR.borderSoft}`,
          borderRadius: RADIUS.md,
          padding: `${SPACE.lg}px`,
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
          Action required
        </Text>
        <Text
          style={{
            ...typeStyle("body"),
            margin: 0,
            marginTop: 6,
            color: COLOR.textPrimary,
          }}
        >
          Please confirm you have read and accept the booking Terms &amp;
          Conditions.
        </Text>
        <Link
          href={acknowledgeUrl}
          style={{
            display: "inline-block",
            marginTop: SPACE.md,
            backgroundColor: COLOR.textPrimary,
            color: COLOR.textInverted,
            fontSize: 14,
            fontWeight: 600,
            padding: "12px 28px",
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
          The full Terms &amp; Conditions are at the bottom of this email
          {termsVersion ? ` (version ${termsVersion})` : ""}. Your
          acknowledgement is recorded against this booking — no login required.
        </Text>
      </Section>
    </Section>
  );
}
