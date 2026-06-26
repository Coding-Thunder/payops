import { describe, expect, it } from "vitest";

import {
  archiveOrderSchema,
  changePasswordSchema,
  createOrderSchema,
  createUserSchema,
  flagOrderSchema,
  loginSchema,
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

  it("accepts a near-floor amount (>= $0.50) that still has cents", () => {
    // Sub-50¢ inputs fail at the Stripe boundary, not the schema —
    // the schema only enforces > 0, so this stays here as a guard.
    const r = createOrderSchema.safeParse(belowMinimumAmountInput());
    expect(r.success).toBe(true);
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
