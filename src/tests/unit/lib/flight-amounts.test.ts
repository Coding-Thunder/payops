import { describe, expect, it } from "vitest";

import { summarizeCharges, summarizeFlightAmounts } from "@/lib/charges";
import { PaymentTiming } from "@/lib/constants/enums";

const PREPAID = PaymentTiming.PREPAID;

/**
 * Flight money rule: airline fare + service charge = booking value, and the
 * payment link collects ONLY the service charge. `payableNow` and
 * `summarizeCharges(...).prepaid` are what `pricing.amount` — and therefore
 * the gateway — is built from, so the fare must never appear in either.
 */
describe("summarizeFlightAmounts", () => {
  it.each([
    { fare: 400, service: 100, total: 500 },
    { fare: 825, service: 75, total: 900 },
    { fare: 1234.56, service: 49.99, total: 1284.55 },
  ])(
    "fare $fare + service charge $service → booking value $total, payable now $service",
    ({ fare, service, total }) => {
      const charges = [{ name: "Service charge", amount: service, timing: PREPAID }];
      const s = summarizeFlightAmounts(charges, fare);
      expect(s.airlineFare).toBe(fare);
      expect(s.serviceCharge).toBe(service);
      expect(s.payableNow).toBe(service);
      expect(s.bookingTotal).toBe(total);
      // The gateway amount is the prepaid total of the charge lines.
      expect(summarizeCharges(charges).prepaid).toBe(service);
    },
  );

  it("adds several service-charge lines but never the fare", () => {
    const s = summarizeFlightAmounts(
      [
        { name: "Service charge", amount: 60, timing: PREPAID },
        { name: "Seat selection", amount: 15.5, timing: PREPAID },
      ],
      300,
    );
    expect(s.payableNow).toBe(75.5);
    expect(s.bookingTotal).toBe(375.5);
  });

  it("treats a blank fare as zero", () => {
    const s = summarizeFlightAmounts(
      [{ name: "Service charge", amount: 40, timing: PREPAID }],
      null,
    );
    expect(s.airlineFare).toBe(0);
    expect(s.bookingTotal).toBe(40);
  });

  it("still adds up for a pre-existing flight that carried a due-later line", () => {
    const s = summarizeFlightAmounts(
      [
        { name: "Airfare", amount: 200, timing: PREPAID },
        { name: "Balance", amount: 300, timing: PaymentTiming.DUE_AT_COUNTER },
      ],
      undefined,
    );
    expect(s.payableNow).toBe(200);
    expect(s.dueLater).toBe(300);
    expect(s.bookingTotal).toBe(500);
  });
});
