import { describe, expect, it } from "vitest";

import { summarizeCharges } from "@/lib/charges";
import { PaymentTiming } from "@/lib/constants/enums";

const PREPAID = PaymentTiming.PREPAID;
const COUNTER = PaymentTiming.DUE_AT_COUNTER;

describe("summarizeCharges", () => {
  it("splits prepaid vs due-at-counter and totals them", () => {
    const s = summarizeCharges([
      { name: "Rental", amount: 150, timing: PREPAID },
      { name: "Counter balance", amount: 350, timing: COUNTER },
    ]);
    expect(s.prepaid).toBe(150);
    expect(s.dueAtCounter).toBe(350);
    expect(s.total).toBe(500);
    expect(s.charges).toHaveLength(2);
  });

  it("sums multiple prepaid lines into the online amount", () => {
    const s = summarizeCharges([
      { name: "Base", amount: 100, timing: PREPAID },
      { name: "Insurance", amount: 49.5, timing: PREPAID },
      { name: "Young driver fee", amount: 200, timing: COUNTER },
    ]);
    expect(s.prepaid).toBe(149.5);
    expect(s.dueAtCounter).toBe(200);
    expect(s.total).toBe(349.5);
  });

  it("kills floating-point dust (0.1 + 0.2 === 0.3)", () => {
    const s = summarizeCharges([
      { name: "a", amount: 0.1, timing: PREPAID },
      { name: "b", amount: 0.2, timing: PREPAID },
    ]);
    expect(s.prepaid).toBe(0.3);
    expect(s.total).toBe(0.3);
  });

  it("treats a legacy order (no charges) as one prepaid line from pricing.amount", () => {
    const s = summarizeCharges([], 249.99);
    expect(s.prepaid).toBe(249.99);
    expect(s.dueAtCounter).toBe(0);
    expect(s.total).toBe(249.99);
    expect(s.charges).toEqual([
      { name: "Rental cost", amount: 249.99, timing: PREPAID },
    ]);
  });

  it("never sends due-at-counter into the prepaid (online/Stripe) figure", () => {
    const s = summarizeCharges([
      { name: "Counter only", amount: 500, timing: COUNTER },
    ]);
    // Prepaid is what Stripe is asked to charge — must exclude counter dues.
    expect(s.prepaid).toBe(0);
    expect(s.dueAtCounter).toBe(500);
    expect(s.total).toBe(500);
  });

  it("handles an empty list with no fallback as all-zero", () => {
    const s = summarizeCharges([]);
    expect(s).toEqual({ charges: [], prepaid: 0, dueAtCounter: 0, total: 0 });
  });
});
