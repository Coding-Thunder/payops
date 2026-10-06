import { Column, Row, Text } from "@react-email/components";
import * as React from "react";

import { flightAmountLabels, type FlightAmountLabels } from "@/lib/charges";
import { PaymentTiming } from "@/lib/constants/enums";

import {
  type EmailChargeLine,
  FLIGHT_CHARGE_WORDING,
  TotalRow,
} from "./charge-breakdown";
import { MetadataRow } from "./metadata-row";
import { SummaryCard } from "./summary-card";
import { COLOR, SPACE, typeStyle } from "./tokens";

/**
 * Pre-formatted FLIGHT money — email.service builds it from
 * `summarizeFlightAmounts` and formats it in the order currency, so the
 * template stays presentation-only.
 */
export interface EmailFlightAmounts {
  /** The charge lines as entered — the service charge on an itinerary
   *  flight, all PREPAID. A flight created before prepaid-only may also
   *  carry one due later. */
  lines: EmailChargeLine[];
  /** The airline fare, or null when none was recorded — the row is then
   *  left out rather than printed as $0.00. */
  airlineFare: string | null;
  /** Sum of the prepaid lines — ALL the payment link ever collects: the
   *  service charge, on an itinerary flight. */
  serviceCharge: string;
  /** Legacy flights only: the balance due later, else null. */
  dueLater: string | null;
  /** Airline fare + service charge (+ any legacy balance). */
  bookingTotal: string;
  /**
   * From `flightMoneyWording(order.flight)`: true when the charge lines are
   * the operator's service charge (every itinerary flight). False for a
   * flight created before itineraries, whose lines were usually the whole
   * fare — every label and sentence about the money is then neutral.
   */
  serviceChargeModel: boolean;
}

/**
 * The sentence flight emails use, next to the amount, so the service charge
 * can never read as the price of the trip. Says what is true about this
 * payment without claiming who collects the fare — the same stance as
 * `FLIGHT_AMOUNT_LABELS.airlineFareNote`. Itinerary flights only
 * (`serviceChargeModel`): on a legacy flight the payment usually WAS the fare.
 */
export const AIRLINE_FARE_NOT_INCLUDED =
  "The airline fare is charged separately and is not part of this payment.";

interface FlightChargeBreakdownProps {
  amounts: EmailFlightAmounts;
  /**
   * Label on the final, emphasised row: what this email says about the
   * amount charged online — payable now (request), paid (confirmation) or on
   * hold (authorization), from the flight's own label set.
   */
  settledLabel: string;
  /** Defaults to the flight label set's `breakdownTitle`. */
  title?: string;
  topPadding?: number;
  bottomPadding?: number;
}

/**
 * The FLIGHT money block:
 *
 *   Airline fare                         $1,240.00
 *   Charged separately — not part of this payment
 *   Service charge                          $95.00
 *   Total booking value                  $1,335.00
 *   Amount payable now                      $95.00
 *
 * Takes the place of `ChargeBreakdown` for a flight, whose prepaid / due /
 * total rows have no way to show a fare the payment link never collects.
 * Built from the same row primitives so the two blocks read as one design.
 */
export function FlightChargeBreakdown({
  amounts,
  settledLabel,
  title,
  topPadding = SPACE.md,
  bottomPadding = SPACE.xs,
}: FlightChargeBreakdownProps) {
  const labels = flightAmountLabels(amounts.serviceChargeModel);
  return (
    <SummaryCard
      title={title ?? labels.breakdownTitle}
      topPadding={topPadding}
      bottomPadding={bottomPadding}
    >
      {amounts.airlineFare ? (
        <FareRow value={amounts.airlineFare} labels={labels} />
      ) : null}
      {amounts.lines.map((line, idx) => (
        <MetadataRow
          key={idx}
          label={
            line.timing === PaymentTiming.DUE_AT_COUNTER
              ? `${line.name} ${FLIGHT_CHARGE_WORDING.dueSuffix}`
              : line.name
          }
          value={line.amount}
        />
      ))}
      <TotalRow label={labels.bookingTotal} value={amounts.bookingTotal} />
      {amounts.dueLater ? (
        <TotalRow label={labels.dueLater} value={amounts.dueLater} />
      ) : null}
      <TotalRow
        label={settledLabel}
        value={amounts.serviceCharge}
        emphasise
        isLast
      />
    </SummaryCard>
  );
}

/**
 * The airline-fare line: a MetadataRow look, with the "not part of this
 * payment" note on a full-width line beneath it — too long for the label
 * column on a phone.
 */
function FareRow({
  value,
  labels,
}: {
  value: string;
  labels: FlightAmountLabels;
}) {
  const cellStyle: React.CSSProperties = {
    paddingTop: 10,
    paddingBottom: 2,
    verticalAlign: "middle",
  };
  return (
    <>
      <Row>
        <Column style={{ ...cellStyle, width: "40%" }}>
          <Text
            style={{
              ...typeStyle("label"),
              margin: 0,
              color: COLOR.textMuted,
            }}
          >
            {labels.airlineFare}
          </Text>
        </Column>
        <Column style={{ ...cellStyle, textAlign: "right" }}>
          <Text
            style={{
              ...typeStyle("meta"),
              margin: 0,
              color: COLOR.textPrimary,
            }}
          >
            {value}
          </Text>
        </Column>
      </Row>
      <Row>
        <Column
          style={{
            paddingBottom: 10,
            borderBottom: `1px solid ${COLOR.borderSoft}`,
          }}
        >
          <Text
            style={{
              ...typeStyle("legal"),
              margin: 0,
              color: COLOR.textMuted,
              fontSize: 11,
              lineHeight: "16px",
            }}
          >
            {labels.airlineFareNote}
          </Text>
        </Column>
      </Row>
    </>
  );
}
