import { Hr, Text } from "@react-email/components";
import * as React from "react";

import { SummaryCard } from "./summary-card";
import { COLOR, SPACE, typeStyle } from "./tokens";

interface EmailTermsSectionProps {
  /** Raw Terms & Conditions text (newline-separated paragraphs). Renders
   *  nothing when empty so legacy orders / disabled terms degrade cleanly. */
  termsText?: string | null;
  termsVersion?: string | null;
}

/**
 * The ONE place the rental Terms & Conditions TEXT is rendered in email. Both
 * customer emails (payment request + payment confirmation) compose this so
 * the T&C copy/styling can never drift between templates. Sits just before
 * the support/footer block. Self-hides when there's no terms text.
 *
 * The "I Agree" acknowledgement button is intentionally NOT here — it lives
 * in `EmailAgreeButton`, placed high in the confirmation email so the required
 * action is immediately visible. This section is the readable full terms.
 */
export function EmailTermsSection({
  termsText,
  termsVersion,
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
        {termsVersion ? (
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
