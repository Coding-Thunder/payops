import { describe, expect, it } from "vitest";

import { PaymentTiming } from "@/lib/constants/enums";

import {
  archiveOrderSchema,
  changePasswordSchema,
  chargesEditArraySchema,
  createOrderSchema,
  createUserSchema,
  flagOrderSchema,
  loginSchema,
  recordManualPaymentSchema,
  resetUserPasswordSchema,
  updateSettingsSchema,
} from "@/lib/validation";
import {
  belowMinimumAmountInput,
  invalidTripDatesInput,
  validCreateOrderInput,
} from "@/tests/fixtures/order-input.fixture";

describe("loginSchema", () => {
  it("accepts a valid email + password", () => {
    const r = loginSchema.safeParse({
      email: "ada@payops.test",
      password: "Hunter2!ok",
    });
    expect(r.success).toBe(true);
  });

  it("rejects malformed emails", () => {
    const r = loginSchema.safeParse({ email: "nope", password: "Hunter2!ok" });
    expect(r.success).toBe(false);
  });

  it("rejects passwords shorter than 8 chars", () => {
    const r = loginSchema.safeParse({
      email: "a@b.co",
      password: "short",
    });
    expect(r.success).toBe(false);
  });
});

describe("changePasswordSchema", () => {
  it("requires uppercase + lowercase + digit + length", () => {
    const ok = changePasswordSchema.safeParse({
      currentPassword: "anything",
      newPassword: "Hunter2Hunter2",
      confirmPassword: "Hunter2Hunter2",
    });
    expect(ok.success).toBe(true);
  });

  it("rejects mismatched confirmation", () => {
    const bad = changePasswordSchema.safeParse({
      currentPassword: "x",
      newPassword: "Hunter2Hunter2",
      confirmPassword: "Different1234",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects new passwords missing complexity", () => {
    const bad = changePasswordSchema.safeParse({
      currentPassword: "x",
      newPassword: "alllowercase",
      confirmPassword: "alllowercase",
    });
    expect(bad.success).toBe(false);
  });
});

describe("createUserSchema", () => {
  it("normalises emails to lowercase", () => {
    const r = createUserSchema.safeParse({
      name: "Jane Doe",
      email: "Jane@PayOps.Test",
      role: "ADMIN",
      password: "Hunter2Hunter2",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe("jane@payops.test");
  });

  it("rejects an unknown role", () => {
    const r = createUserSchema.safeParse({
      name: "Jane",
      email: "j@x.co",
      role: "OWNER",
      password: "Hunter2Hunter2",
    });
    expect(r.success).toBe(false);
  });
});

describe("createOrderSchema", () => {
  it("accepts the canonical valid input fixture", () => {
    const r = createOrderSchema.safeParse(validCreateOrderInput());
    expect(r.success).toBe(true);
  });

  it("rejects trips where dropoff is not after pickup", () => {
    const r = createOrderSchema.safeParse(invalidTripDatesInput());
    expect(r.success).toBe(false);
    if (!r.success) {
      const messages = r.error.issues.map((i) => i.message);
      expect(messages.some((m) => /Drop-off must be after pick-up/.test(m))).toBe(
        true,
      );
    }
  });

  it("rejects amounts <= 0", () => {
    const r = createOrderSchema.safeParse(
      validCreateOrderInput({
        charges: [{ name: "Rental cost", amount: 0, timing: "PREPAID" }],
      }),
    );
    expect(r.success).toBe(false);
  });

  it("rejects unrealistically large amounts", () => {
    const r = createOrderSchema.safeParse(
      validCreateOrderInput({
        charges: [
          { name: "Rental cost", amount: 5_000_000, timing: "PREPAID" },
        ],
      }),
    );
    expect(r.success).toBe(false);
  });

  it("trims customer + vehicle names", () => {
    const r = createOrderSchema.safeParse(
      validCreateOrderInput({
        customer: {
          name: "   Ada   ",
          email: "ada@payops.test",
          phone: "+15555550100",
        },
      }),
    );
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.customer.name).toBe("Ada");
  });

  it("refuses a prepaid total below the 0.50 floor with a field error", () => {
    // This used to be accepted here and refused by the order model's own
    // minimum, which surfaced to the operator as an HTTP 500 "Something went
    // wrong". The floor is now a validation rule with a real message.
    const r = createOrderSchema.safeParse(belowMinimumAmountInput());
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/at least 0\.50/);
  });

  it("accepts a prepaid total exactly at, or just above, the floor", () => {
    for (const amount of [0.5, 0.51]) {
      const r = createOrderSchema.safeParse(
        validCreateOrderInput({
          charges: [{ name: "Rental cost", amount, timing: PaymentTiming.PREPAID }],
        }),
      );
      expect(r.success).toBe(true);
    }
  });

  it("requires a well-formed rental provider key (existence is enforced server-side)", () => {
    const { provider: _drop, ...rest } = validCreateOrderInput();
    void _drop;
    // Missing → reject
    expect(createOrderSchema.safeParse(rest).success).toBe(false);
    // Malformed (lowercase / starts with digit / too short) → reject
    expect(
      createOrderSchema.safeParse({ ...rest, provider: "h" }).success,
    ).toBe(false);
    expect(
      createOrderSchema.safeParse({ ...rest, provider: "9ABC" }).success,
    ).toBe(false);
    // Well-formed (whether or not the DB knows about it) → accept;
    // the order service rejects unknown keys at runtime.
    expect(
      createOrderSchema.safeParse({ ...rest, provider: "HERTZ" }).success,
    ).toBe(true);
    expect(
      createOrderSchema.safeParse({ ...rest, provider: "SIXT" }).success,
    ).toBe(true);
  });
});

describe("updateSettingsSchema", () => {
  it("uppercases order prefix and accepts a valid payload", () => {
    const r = updateSettingsSchema.safeParse({
      paymentExpiryHours: 12,
      orderPrefix: "ord",
      allowedBookingTypes: ["NEW_BOOKING"],
      defaultCurrency: "USD",
      successRedirectUrl: "https://example.com/s",
      cancelRedirectUrl: "https://example.com/c",
      cancellationPolicy: "x".repeat(100),
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.orderPrefix).toBe("ORD");
  });

  it("rejects a prefix with digits", () => {
    const r = updateSettingsSchema.safeParse({
      paymentExpiryHours: 12,
      orderPrefix: "OR1",
      allowedBookingTypes: ["NEW_BOOKING"],
      defaultCurrency: "USD",
      successRedirectUrl: "https://example.com/s",
      cancelRedirectUrl: "https://example.com/c",
      cancellationPolicy: "x".repeat(100),
    });
    expect(r.success).toBe(false);
  });

  it("requires a non-empty allowedBookingTypes list", () => {
    const r = updateSettingsSchema.safeParse({
      paymentExpiryHours: 12,
      orderPrefix: "ORD",
      allowedBookingTypes: [],
      defaultCurrency: "USD",
      successRedirectUrl: "https://example.com/s",
      cancelRedirectUrl: "https://example.com/c",
      cancellationPolicy: "x".repeat(100),
    });
    expect(r.success).toBe(false);
  });
});

describe("misc order schemas", () => {
  it("archiveOrderSchema accepts an empty body", () => {
    expect(archiveOrderSchema.safeParse({}).success).toBe(true);
  });

  it("flagOrderSchema requires the boolean flag", () => {
    expect(flagOrderSchema.safeParse({}).success).toBe(false);
    expect(flagOrderSchema.safeParse({ flagged: true }).success).toBe(true);
  });

  it("resetUserPasswordSchema enforces complexity", () => {
    expect(
      resetUserPasswordSchema.safeParse({ newPassword: "weak" }).success,
    ).toBe(false);
    expect(
      resetUserPasswordSchema.safeParse({ newPassword: "Hunter2Hunter2" })
        .success,
    ).toBe(true);
  });
});

/**
 * Second-and-later charge lines default to DUE_AT_COUNTER.
 *
 * The default lives in the schema rather than only in the form because the
 * form is not the only writer: an API client, an importer or a replayed
 * request all reach `createOrderSchema` directly. Production shows operators
 * doing this by hand today — counter lines typed across four different
 * spellings of "Due at Counter" — so the rule is being followed manually
 * already; this only writes it down.
 */
describe("charge timing defaults by position", () => {
  const line = (name: string, amount: number, timing?: string) =>
    timing === undefined ? { name, amount } : { name, amount, timing };

  function parseCharges(charges: unknown[]) {
    const result = createOrderSchema.safeParse({
      ...validCreateOrderInput(),
      charges,
    });
    if (!result.success) return { ok: false as const, error: result.error };
    return { ok: true as const, charges: result.data.charges };
  }

  it("defaults the FIRST line to PREPAID when timing is omitted", () => {
    const r = parseCharges([line("Rental cost", 249.99)]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.charges[0].timing).toBe("PREPAID");
  });

  it("defaults the SECOND and later lines to DUE_AT_COUNTER", () => {
    const r = parseCharges([
      line("Rental cost", 249.99),
      line("Fuel option", 40),
      line("Extra driver", 25),
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.charges.map((c) => c.timing)).toEqual([
        "PREPAID",
        "DUE_AT_COUNTER",
        "DUE_AT_COUNTER",
      ]);
    }
  });

  it("never overrides an explicit choice — a prepaid second line survives", () => {
    // The whole point of a default: the operator can always say otherwise.
    const r = parseCharges([
      line("Rental cost", 249.99, "PREPAID"),
      line("Insurance", 60, "PREPAID"),
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.charges.map((c) => c.timing)).toEqual(["PREPAID", "PREPAID"]);
  });

  it("leaves the first charge's existing behaviour untouched", () => {
    // An explicitly counter-billed first line stays counter-billed, and is
    // then correctly rejected for having nothing to collect online.
    const r = parseCharges([line("Rental cost", 249.99, "DUE_AT_COUNTER")]);
    expect(r.ok).toBe(false);
  });

  it("still requires one positive prepaid line after defaulting", () => {
    // Defaulting runs BEFORE the refine, so a lone omitted-timing line is
    // resolved to PREPAID and passes, while a counter-only set does not.
    const counterOnly = parseCharges([
      line("Rental cost", 249.99, "DUE_AT_COUNTER"),
      line("Fuel option", 40),
    ]);
    expect(counterOnly.ok).toBe(false);
  });
});

describe("chargesEditArraySchema (the edit path)", () => {
  it("requires an explicit timing — it must NOT re-default by position", () => {
    // This is the interaction guard. If the edit path reused the create
    // array, removing a line above would silently reclassify the lines below
    // it by their new index. Editing must say what it means.
    const r = chargesEditArraySchema.safeParse([
      { name: "Rental cost", amount: 249.99, timing: "PREPAID" },
      { name: "Insurance", amount: 60 },
    ]);
    expect(r.success).toBe(false);
  });

  it("keeps an explicitly prepaid second line prepaid", () => {
    const r = chargesEditArraySchema.safeParse([
      { name: "Rental cost", amount: 249.99, timing: "PREPAID" },
      { name: "Insurance", amount: 60, timing: "PREPAID" },
    ]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.map((c) => c.timing)).toEqual(["PREPAID", "PREPAID"]);
  });

  it("enforces the same prepaid-line requirement as create", () => {
    const r = chargesEditArraySchema.safeParse([
      { name: "Counter only", amount: 60, timing: "DUE_AT_COUNTER" },
    ]);
    expect(r.success).toBe(false);
  });
});

/**
 * PayOps must never hold a card number, and the likeliest way one arrives is
 * an operator pasting it into a free-text reference box. The guard strips
 * separators before counting, and only rejects all-digit strings — a
 * terminal auth code must still be accepted, or operators will leave the
 * field blank instead.
 */
describe("recordManualPaymentSchema — the reference must not be a card number", () => {
  const base = { method: "Card terminal" };
  const ok = (reference: string) =>
    recordManualPaymentSchema.safeParse({ ...base, reference }).success;

  it("rejects a bare 16-digit PAN", () => {
    expect(ok("4111111111111111")).toBe(false);
  });

  it("rejects a PAN with spaces or dashes", () => {
    expect(ok("4111 1111 1111 1111")).toBe(false);
    expect(ok("4111-1111-1111-1111")).toBe(false);
  });

  it("rejects across the whole 13–19 digit card range", () => {
    expect(ok("4".repeat(13))).toBe(false);
    expect(ok("4".repeat(19))).toBe(false);
  });

  it("accepts a terminal authorisation code", () => {
    expect(ok("AUTH-004521")).toBe(true);
    expect(ok("TXN 99887766")).toBe(true);
  });

  it("accepts a short numeric receipt number", () => {
    // 6 digits is not a card number and is a perfectly ordinary reference.
    expect(ok("004521")).toBe(true);
  });

  it("requires a reference at all", () => {
    expect(recordManualPaymentSchema.safeParse({ ...base, reference: "" }).success).toBe(false);
  });
});
