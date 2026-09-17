import { describe, expect, it } from "vitest";

import { isOperatorSupersede, isSessionSuperseded } from "@/lib/payment-state";
import { paymentRequestSubject } from "@/lib/payment-request-subject";
import { createOrderSchema, sendPaymentRequestSchema } from "@/lib/validation";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";
import type { OrderDTO } from "@/types";

describe("isOperatorSupersede", () => {
  it("recognises the reasons PayOps writes when an operator stands a link down", () => {
    expect(isOperatorSupersede("Superseded by an amount change")).toBe(true);
    expect(isOperatorSupersede("Replaced by a regenerated link")).toBe(true);
    expect(isOperatorSupersede("Superseded by a gateway change")).toBe(true);
  });

  it("leaves gateway-reported failures alone", () => {
    expect(isOperatorSupersede("Insufficient funds")).toBe(false);
    expect(isOperatorSupersede(null)).toBe(false);
  });
});

describe("isSessionSuperseded", () => {
  const payment = (over: Partial<OrderDTO["payment"]>) =>
    ({ paymentSessionId: "cs_a", attempts: [], ...over }) as OrderDTO["payment"];

  it("is true when the recorded session was stood down", () => {
    expect(
      isSessionSuperseded(
        payment({
          attempts: [{ sessionId: "cs_a", supersededAt: "2026-09-16T00:00:00Z" }] as never,
        }),
      ),
    ).toBe(true);
  });

  it("is false for the live session and for no session", () => {
    expect(isSessionSuperseded(payment({}))).toBe(false);
    expect(isSessionSuperseded(payment({ paymentSessionId: null }))).toBe(false);
  });
});

describe("paymentRequestSubject", () => {
  it("asks a manual customer to confirm, not to pay", () => {
    expect(paymentRequestSubject("Dollar", "ORD-1", true)).toBe(
      "Please confirm your Dollar booking • ORD-1",
    );
    expect(paymentRequestSubject("Dollar", "ORD-1", false)).toBe(
      "Complete your Dollar payment • ORD-1",
    );
  });
});

describe("email local part", () => {
  const withEmail = (email: string) =>
    validCreateOrderInput({
      customer: { name: "Ada Lovelace", email, phone: "+15555550100" },
    });

  it("refuses more than 64 characters before @ everywhere", () => {
    const email = `${"z".repeat(65)}@payops.test`;
    expect(createOrderSchema.safeParse(withEmail(email)).success).toBe(false);
    expect(
      sendPaymentRequestSchema.safeParse({ customer: { email } }).success,
    ).toBe(false);
  });

  it("accepts exactly 64", () => {
    const email = `${"z".repeat(64)}@payops.test`;
    expect(createOrderSchema.safeParse(withEmail(email)).success).toBe(true);
    expect(
      sendPaymentRequestSchema.safeParse({ customer: { email } }).success,
    ).toBe(true);
  });

  it("applies the order form's name rules to a send-time name change", () => {
    expect(
      sendPaymentRequestSchema.safeParse({ customer: { name: "\u200b\u200b" } }).success,
    ).toBe(false);
  });
});
