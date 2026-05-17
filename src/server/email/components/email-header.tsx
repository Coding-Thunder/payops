import { Section, Text } from "@react-email/components";
import * as React from "react";

import { COLOR, SPACE, typeStyle } from "./tokens";

interface EmailHeaderProps {
  /** Workspace / company name. */
  brandName: string;
  /** Subtle small caps under the brand (e.g. "Payment receipt"). */
  eyebrow?: string;
}

/**
 * Top of the email — workspace name + a single eyebrow label. Borrowed
 * from Stripe's receipts: typographic, no logo, no color band.
 */
export function EmailHeader({
  brandName,
  eyebrow = "Payment receipt",
}: EmailHeaderProps) {
  return (
    <Section
      style={{
        padding: `${SPACE.xl}px ${SPACE.xxxl}px`,
        borderBottom: `1px solid ${COLOR.border}`,
      }}
    >
      <Text
        style={{
          ...typeStyle("heading"),
          margin: 0,
          color: COLOR.textPrimary,
        }}
      >
        {brandName}
      </Text>
      <Text
        style={{
          ...typeStyle("micro"),
          margin: 0,
          marginTop: SPACE.xs,
          color: COLOR.textMuted,
          textTransform: "uppercase",
        }}
      >
        {eyebrow}
      </Text>
    </Section>
  );
}
