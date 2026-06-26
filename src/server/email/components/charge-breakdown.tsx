import { Column, Row, Text } from "@react-email/components";
import * as React from "react";

import { PaymentTiming } from "@/lib/constants/enums";

import { MetadataRow } from "./metadata-row";
import { SummaryCard } from "./summary-card";
import { COLOR, SPACE, typeStyle } from "./tokens";

/** Pre-formatted (currency-string) charge line for email rendering. */
export interface EmailChargeLine {
  name: string;
  amount: string;
  timing: PaymentTiming;
}

/** Pre-formatted breakdown — the caller (email.service) formats the numbers
 *  with the order currency so the template stays presentation-only. */
export interface EmailChargeBreakdown {
  lines: EmailChargeLine[];
  /** Formatted prepaid (online) total. */
  prepaid: string;
  /** Formatted due-at-counter total, or null when there's nothing due. */
  dueAtCounter: string | null;
  /** Formatted grand total. */
  total: string;
}

interface ChargeBreakdownProps {
  breakdown: EmailChargeBreakdown;
  title?: string;
  topPadding?: number;
  bottomPadding?: number;
}

/**
 * Shared charge-summary block used by BOTH the payment-request and
 * payment-confirmation emails so the breakdown renders identically. Lists
 * each charge line, then a Paid-online / Due-at-counter / Total summary.
 */
export function ChargeBreakdown({
  breakdown,
  title = "Charge summary",
  topPadding = SPACE.xl,
  bottomPadding = SPACE.xs,
}: ChargeBreakdownProps) {
  const showLines = breakdown.lines.length > 0;
  return (
    <SummaryCard
      title={title}
      topPadding={topPadding}
      bottomPadding={bottomPadding}
    >
      {showLines
        ? breakdown.lines.map((line, idx) => (
            <MetadataRow
              key={idx}
              label={
                line.timing === PaymentTiming.DUE_AT_COUNTER
                  ? `${line.name} (due at counter)`
                  : line.name
              }
              value={line.amount}
            />
          ))
        : null}

      <TotalRow label="Amount paid online" value={breakdown.prepaid} />
      {breakdown.dueAtCounter ? (
        <TotalRow
          label="Amount due at counter"
          value={breakdown.dueAtCounter}
        />
      ) : null}
      <TotalRow label="Total rental cost" value={breakdown.total} emphasise isLast />
    </SummaryCard>
  );
}

/** Like MetadataRow but the value can be emphasised (used for the total). */
function TotalRow({
  label,
  value,
  emphasise,
  isLast,
}: {
  label: string;
  value: string;
  emphasise?: boolean;
  isLast?: boolean;
}) {
  const cellStyle: React.CSSProperties = {
    paddingTop: 10,
    paddingBottom: 10,
    borderBottom: isLast ? "none" : `1px solid ${COLOR.borderSoft}`,
    verticalAlign: "middle",
  };
  return (
    <Row>
      <Column style={{ ...cellStyle, width: "60%" }}>
        <Text
          style={{
            ...typeStyle("label"),
            margin: 0,
            color: emphasise ? COLOR.textPrimary : COLOR.textMuted,
            fontWeight: emphasise ? 600 : 400,
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
            fontWeight: emphasise ? 700 : 500,
          }}
        >
          {value}
        </Text>
      </Column>
    </Row>
  );
}
