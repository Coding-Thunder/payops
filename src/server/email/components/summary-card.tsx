import { Heading, Section } from "@react-email/components";
import * as React from "react";

import { COLOR, SPACE, typeStyle } from "./tokens";

interface SummaryCardProps {
  /** Optional uppercase eyebrow above the row group. */
  title?: string;
  /** Padding above the section. Defaults to "lg" to match neighboring blocks. */
  topPadding?: number;
  /** Padding below the section. */
  bottomPadding?: number;
  children: React.ReactNode;
}

/**
 * Section wrapper for metadata groups (booking details, payment details).
 * Renders as a plain padded block, NOT a colored card — the visual
 * separation comes from spacing + the per-row dividers in MetadataRow.
 */
export function SummaryCard({
  title,
  topPadding = SPACE.xl,
  bottomPadding = SPACE.xs,
  children,
}: SummaryCardProps) {
  return (
    <Section
      style={{
        paddingTop: topPadding,
        paddingBottom: bottomPadding,
        paddingLeft: SPACE.xxxl,
        paddingRight: SPACE.xxxl,
      }}
    >
      {title ? (
        <Heading
          as="h2"
          style={{
            ...typeStyle("micro"),
            margin: 0,
            marginBottom: 6,
            color: COLOR.textMuted,
            textTransform: "uppercase",
          }}
        >
          {title}
        </Heading>
      ) : null}
      {children}
    </Section>
  );
}
