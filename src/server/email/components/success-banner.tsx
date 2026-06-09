import { Heading, Section, Text } from "@react-email/components";
import * as React from "react";

import { COLOR, SPACE, typeStyle } from "./tokens";

interface SuccessBannerProps {
  /** Uppercase micro-label above the title (e.g. "Payment confirmed"). */
  label?: string;
  /** Main heading line (e.g. "Thank you, Vinay."). */
  title: string;
  /** Calm body paragraph below the heading. */
  description: React.ReactNode;
}

/**
 * Calm success state. No checkmark icon, no pill, just a typographic
 * eyebrow plus a heading and short paragraph. The "premium fintech"
 * version of "🎉 booking complete".
 */
export function SuccessBanner({
  label = "Payment confirmed",
  title,
  description,
}: SuccessBannerProps) {
  return (
    <Section
      style={{
        padding: `${SPACE.xxxl}px ${SPACE.xxxl}px ${SPACE.md}px`,
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
        {label}
      </Text>
      <Heading
        as="h1"
        style={{
          ...typeStyle("display"),
          margin: 0,
          marginTop: 10,
          color: COLOR.textPrimary,
        }}
      >
        {title}
      </Heading>
      <Text
        style={{
          ...typeStyle("body"),
          margin: 0,
          marginTop: 10,
          color: COLOR.textSecondary,
        }}
      >
        {description}
      </Text>
    </Section>
  );
}
