import { Hr, Link, Text } from "@react-email/components";
import * as React from "react";

import { SummaryCard } from "./summary-card";
import { COLOR, RADIUS, SPACE, typeStyle } from "./tokens";

interface EmailTermsSectionProps {
  /** Raw Terms & Conditions text (newline-separated paragraphs). Renders
   *  nothing when empty so legacy orders / disabled terms degrade cleanly. */
  termsText?: string | null;
  termsVersion?: string | null;
  /** When set, renders the post-payment "I Agree" acknowledgement button
   *  (confirmation email only). Omit on pre-payment emails — the T&C still
   *  renders, just without the button. */
  acknowledgeUrl?: string | null;
}

/**
 * The ONE place the rental Terms & Conditions are rendered in email. Both
 * customer emails (payment request + payment confirmation) compose this so
 * the T&C copy/styling can never drift between templates. Sits just before
 * the support/footer block. Self-hides when there's no terms text.
 */
export function EmailTermsSection({
  termsText,
  termsVersion,
  acknowledgeUrl,
}: EmailTermsSectionProps) {
  const paragraphs = termsText
    ? termsText.split(/\n+/).filter((p) => p.trim().length > 0)
    : [];
  if (paragraphs.length === 0) return null;

  return (
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
        {paragraphs.map((paragraph, idx) => (
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
        ) : termsVersion ? (
          <Text
            style={{
              ...typeStyle("legal"),
              margin: 0,
              marginTop: SPACE.md,
              color: COLOR.textMuted,
              letterSpacing: "0.04em",
            }}
          >
            Terms version {termsVersion}
          </Text>
        ) : null}
      </SummaryCard>
    </>
  );
}
