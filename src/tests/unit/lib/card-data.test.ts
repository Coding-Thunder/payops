import { describe, expect, it } from "vitest";

import { containsCardData } from "@/lib/validation/card-data";
import {
  modifyOrderSchema,
  recordManualPaymentSchema,
} from "@/lib/validation";

/**
 * Card details must never be entered into, or stored in, PayOps.
 *
 * Before this, only a manual-payment reference made ENTIRELY of digits was
 * refused. The QA pass stored full card numbers, expiry dates and security
 * codes through every other shape and field.
 */

describe("containsCardData", () => {
  it.each([
    "4111111111111111",
    "4111 1111 1111 1111",
    "4111-1111-1111-1111",
    "4111.1111.1111.1111",
    "card 4111111111111111",
    "PAN 4111-1111-1111-1111 exp 12/29",
    "5555555555554444 12/27 737",
    "1234567890123",
  ])("refuses a card number: %s", (value) => {
    expect(containsCardData(value)).toBe(true);
  });

  it.each(["cvv 123", "CVC: 4567", "security code 999", "123", "1234"])(
    "refuses a security code: %s",
    (value) => {
      expect(containsCardData(value)).toBe(true);
    },
  );

  it.each(["exp 12/29", "Expiry: 01/2030", "valid thru 11/28"])(
    "refuses an expiry date: %s",
    (value) => {
      expect(containsCardData(value)).toBe(true);
    },
  );

  it.each([
    "AUTH-004521",
    "TXN 99887766",
    "Card terminal",
    "RRN 123456789012",
    "Approval 88213",
    "Bank transfer ref 20260916-0042",
    "Customer requested a later return date",
    "",
  ])("lets a real reference or note through: %s", (value) => {
    expect(containsCardData(value)).toBe(false);
  });
});

describe("recordManualPaymentSchema", () => {
  const good = { method: "Card terminal", reference: "AUTH-004521" };

  it("accepts a normal recording", () => {
    expect(recordManualPaymentSchema.safeParse(good).success).toBe(true);
  });

  it.each([
    ["method", { ...good, method: "4111 1111 1111 1111" }],
    ["reference", { ...good, reference: "card 4111111111111111" }],
    ["notes", { ...good, notes: "Visa 4111111111111111 exp 12/29 cvv 123" }],
  ])("refuses card data in %s", (_field, body) => {
    expect(recordManualPaymentSchema.safeParse(body).success).toBe(false);
  });

  it("refuses an amount — a manual payment always settles the full total", () => {
    expect(
      recordManualPaymentSchema.safeParse({ ...good, amount: 10 }).success,
    ).toBe(false);
  });
});

describe("modifyOrderSchema change note", () => {
  it("refuses card data in the change note", () => {
    const r = modifyOrderSchema.safeParse({
      customer: { name: "Ada Lovelace" },
      reason: "customer read out 4111 1111 1111 1111",
    });
    expect(r.success).toBe(false);
  });
});
