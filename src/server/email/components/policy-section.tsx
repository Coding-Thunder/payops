import { Hr, Text } from "@react-email/components";
import * as React from "react";

import { SummaryCard } from "./summary-card";
import { COLOR, SPACE, typeStyle } from "./tokens";

interface EmailPolicySectionProps {
  /** Raw cancellation/refund policy text (newline-separated paragraphs).
   *  Renders nothing when empty, so an order with no snapshot degrades
   *  cleanly rather than showing an empty card. */
  policyText?: string | null;
  policyVersion?: string | null;
}

/**
 * The cancellation & refund policy block, as a component.
 *
 * Service-NEUTRAL by construction: it renders whatever text it is handed and
 * knows nothing about rentals or flights. Which text that is was decided at
 * order creation (`policyForService`) and frozen onto `order.policy`, so a
 * flight order's policy describes fare rules and a car order's describes
 * pick-up windows, through the same markup.
 *
 * Mirrors `EmailTermsSection`, deliberately. The rental templates still carry
 * their own inline copy of this block: they are not refactored onto this
 * component because the requirement is that existing car email output stays
 * byte-identical, and an extraction — however faithful — cannot prove that as
 * cheaply as not touching them.
 */
export function EmailPolicySection({
  policyText,
  policyVersion,
}: EmailPolicySectionProps) {
  const paragraphs = policyText
    ? policyText.split(/\n+/).filter((p) => p.trim().length > 0)
    : [];
  if (paragraphs.length === 0) return null;

  return (
    <>
      <Hr
        style={{ margin: 0, borderColor: COLOR.borderSoft, borderTopWidth: 1 }}
      />
      <SummaryCard
        title="Cancellation &amp; refund policy"
        topPadding={SPACE.xl}
        bottomPadding={SPACE.xl}
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
        {policyVersion ? (
          <Text
            style={{
              ...typeStyle("legal"),
              margin: 0,
              marginTop: SPACE.md,
              color: COLOR.textMuted,
              letterSpacing: "0.04em",
            }}
          >
            Policy version {policyVersion}
          </Text>
        ) : null}
      </SummaryCard>
    </>
  );
}
