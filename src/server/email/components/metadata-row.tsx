import { Column, Row, Text } from "@react-email/components";
import * as React from "react";

import { COLOR, typeStyle } from "./tokens";

interface MetadataRowProps {
  label: string;
  value: React.ReactNode;
  /** Suppress the bottom divider on the final row in a group. */
  isLast?: boolean;
}

/**
 * A two-column label/value row used across summary cards.
 * Labels render muted-left, values render emphasised-right with a
 * 1px hairline separator between rows.
 */
export function MetadataRow({ label, value, isLast }: MetadataRowProps) {
  const cellStyle: React.CSSProperties = {
    paddingTop: 10,
    paddingBottom: 10,
    borderBottom: isLast ? "none" : `1px solid ${COLOR.borderSoft}`,
    verticalAlign: "middle",
  };
  return (
    <Row>
      <Column style={{ ...cellStyle, width: "40%" }}>
        <Text
          style={{
            ...typeStyle("label"),
            margin: 0,
            color: COLOR.textMuted,
          }}
        >
          {label}
        </Text>
      </Column>
      <Column style={{ ...cellStyle, textAlign: "right" }}>
        <Text
          style={{
            ...typeStyle("meta"),
            margin: 0,
            color: COLOR.textPrimary,
            wordBreak: "break-word",
          }}
        >
          {value}
        </Text>
      </Column>
    </Row>
  );
}
