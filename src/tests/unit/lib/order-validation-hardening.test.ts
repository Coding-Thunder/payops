import { describe, expect, it } from "vitest";

import { PaymentTiming } from "@/lib/constants/enums";
import { summarizeCharges } from "@/lib/charges";
import { createOrderSchema, modifyOrderSchema } from "@/lib/validation";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * Input the operator-QA pass pushed through the create/edit schemas that
 * either reached the database malformed, or failed as an HTTP 500 instead of
 * a field error.
 */

const withCharges = (charges: Array<{ name: string; amount: number; timing: PaymentTiming }>) =>
  validCreateOrderInput({ charges });
const issues = (r: { success: boolean; error?: { issues: unknown[] } }) =>
  JSON.stringify(r.error?.issues ?? []);

describe("money", () => {
  it("refuses more than two decimal places", () => {
    const r = createOrderSchema.safeParse(
      withCharges([{ name: "Rental", amount: 10.005, timing: PaymentTiming.PREPAID }]),
    );
    expect(r.success).toBe(false);
    expect(issues(r)).toMatch(/2 decimal places/);
  });

  it("refuses a prepaid total under 0.50 as a field error", () => {
    const r = createOrderSchema.safeParse(
      withCharges([{ name: "Rental", amount: 0.3, timing: PaymentTiming.PREPAID }]),
    );
    expect(r.success).toBe(false);
    expect(issues(r)).toMatch(/at least 0\.50/);
  });

  it("applies the same floor to an edit", () => {
    const r = modifyOrderSchema.safeParse({
      charges: [{ name: "Rental", amount: 0.3, timing: PaymentTiming.PREPAID }],
    });
    expect(r.success).toBe(false);
  });

  it("charges exactly what the customer's lines add up to", () => {
    const s = summarizeCharges([
      { name: "a", amount: 10.005, timing: PaymentTiming.PREPAID },
      { name: "b", amount: 0.005, timing: PaymentTiming.PREPAID },
    ]);
    const shown = s.charges.reduce((sum, c) => sum + c.amount, 0);
    expect(s.prepaid).toBeCloseTo(shown, 10);
  });
});

describe("customer", () => {
  const customer = (over: Record<string, string>) =>
    validCreateOrderInput({
      customer: {
        name: "Ada Lovelace",
        email: "ada@payops.test",
        phone: "+15555550100",
        ...over,
      },
    });

  it("refuses an email over 254 characters as a field error", () => {
    const r = createOrderSchema.safeParse(
      customer({ email: `${"a".repeat(64)}@${"b".repeat(200)}.com` }),
    );
    expect(r.success).toBe(false);
    expect(issues(r)).toMatch(/too long|valid email/);
  });

  it("refuses control characters and invisible-only names", () => {
    expect(createOrderSchema.safeParse(customer({ name: "Bad\x00Name" })).success).toBe(false);
    expect(createOrderSchema.safeParse(customer({ name: "\u200b\u200b\u200b" })).success).toBe(false);
  });

  it("refuses a phone number made only of separators", () => {
    expect(createOrderSchema.safeParse(customer({ phone: "- - - - - - -" })).success).toBe(false);
  });

  it("still accepts accented and non-Latin names", () => {
    expect(createOrderSchema.safeParse(customer({ name: "José Ñúñez" })).success).toBe(true);
    expect(createOrderSchema.safeParse(customer({ name: "山田 太郎" })).success).toBe(true);
  });
});

describe("dates", () => {
  const trip = (pickupDate: string, dropoffDate: string) =>
    validCreateOrderInput({
      trip: {
        pickupDate,
        dropoffDate,
        pickupLocation: "LAX Airport",
        dropoffLocation: "San Diego",
      },
    });

  it("refuses an impossible calendar date instead of rolling it over", () => {
    expect(
      createOrderSchema.safeParse(trip("2027-02-30T10:00:00.000Z", "2027-03-05T10:00:00.000Z")).success,
    ).toBe(false);
  });

  it("refuses a bare number read as a year", () => {
    expect(createOrderSchema.safeParse(trip("1", "2")).success).toBe(false);
  });

  it("refuses absurd years", () => {
    expect(
      createOrderSchema.safeParse(trip("0001-01-01T10:00:00.000Z", "0001-01-02T10:00:00.000Z")).success,
    ).toBe(false);
  });
});

describe("edit precondition", () => {
  it("accepts the version the operator loaded", () => {
    expect(
      modifyOrderSchema.safeParse({
        customer: { name: "Ada Lovelace" },
        expectedUpdatedAt: new Date().toISOString(),
      }).success,
    ).toBe(true);
  });
});
