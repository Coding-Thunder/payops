import { Column, Row, Text } from "@react-email/components";
import * as React from "react";

import { PaymentTiming, ServiceType } from "@/lib/constants/enums";
import { ServiceDueLabel, ServiceTotalLabel } from "@/lib/constants/labels";

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

/**
 * The three wording slots that used to be hardcoded rental copy.
 *
 * Every one of them DEFAULTS to the exact string this component emitted
 * before service types existed, so a caller that passes none renders
 * byte-identically — which is what every car-rental send does.
 */
export interface ChargeWording {
  /** Label on the due-later total row. */
  dueLabel?: string;
  /** Label on the grand-total row. */
  totalLabel?: string;
  /** Parenthetical appended to a DUE_AT_COUNTER line item. */
  dueSuffix?: string;
}

/** The literals this component shipped with. Named so the defaults are
 *  visible at a glance and can never drift from the prop defaults. */
export const RENTAL_CHARGE_WORDING: Required<ChargeWording> = {
  dueLabel: "Amount due at counter",
  totalLabel: "Total rental cost",
  dueSuffix: "(due at counter)",
};

/**
 * Service-appropriate wording for the charge block.
 *
 * CAR_RENTAL returns `RENTAL_CHARGE_WORDING` — the incumbent strings,
 * unchanged. A flight has no rental counter and neither does a cruise;
 * telling an RCR Cruise passenger about one is the kind of copy bug that
 * reads as a different company's email.
 */
export function chargeWordingFor(
  serviceType: ServiceType,
): Required<ChargeWording> {
  if (serviceType === ServiceType.CAR_RENTAL) return RENTAL_CHARGE_WORDING;
  return {
    dueLabel: ServiceDueLabel[serviceType],
    totalLabel: ServiceTotalLabel[serviceType],
    dueSuffix:
      serviceType === ServiceType.CRUISE
        ? "(due at the pier)"
        : "(due at the airport)",
  };
}

interface ChargeBreakdownProps extends ChargeWording {
  breakdown: EmailChargeBreakdown;
  title?: string;
  topPadding?: number;
  bottomPadding?: number;
}

/**
 * Shared charge-summary block used by BOTH the payment-request and
 * payment-confirmation emails so the breakdown renders identically. Lists
 * each charge line, then a Paid-online / Due-later / Total summary.
 */
export function ChargeBreakdown({
  breakdown,
  title = "Charge summary",
  topPadding = SPACE.xl,
  bottomPadding = SPACE.xs,
  dueLabel = RENTAL_CHARGE_WORDING.dueLabel,
  totalLabel = RENTAL_CHARGE_WORDING.totalLabel,
  dueSuffix = RENTAL_CHARGE_WORDING.dueSuffix,
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
                  ? `${line.name} ${dueSuffix}`
                  : line.name
              }
              value={line.amount}
            />
          ))
        : null}

      <TotalRow label="Amount paid online" value={breakdown.prepaid} />
      {breakdown.dueAtCounter ? (
        <TotalRow label={dueLabel} value={breakdown.dueAtCounter} />
      ) : null}
      <TotalRow label={totalLabel} value={breakdown.total} emphasise isLast />
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
