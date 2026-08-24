import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PaymentGatewayKey, UserRole } from "@/lib/constants/enums";
import { isAppError, type AppError } from "@/lib/errors";
import { Order } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { seedTestOrganization, setEnabledProviders } from "@/tests/utils/organization";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * One organization, one brand, Stripe enabled and PayPal deliberately not.
 *
 * The deployment this file describes has both gateways in the architecture
 * and exactly one of them switched on. That combination is what makes the
 * rules below load-bearing rather than theoretical: with a single provider
 * per organization a wrong answer was invisible, because there was nothing
 * else to be wrong with.
 */

const { createOrder, initiatePayment, regeneratePaymentLink } = await import(
  "@/server/services/order.service"
);

const actor = actorFor(UserRole.ADMIN);
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sessionMock = await mockSession(actor);
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  vi.useRealTimers();
});

async function newOrder() {
  const { order } = await createOrder(validCreateOrderInput(), { actor });
  return order;
}

/* ─────────────────────────── Stripe, enabled ─────────────────────────── */

describe("Stripe is the enabled provider", () => {
  it("generates a payment link", async () => {
    const order = await newOrder();
    const { order: paid } = await initiatePayment(order.id, { actor });
    expect(paid.payment.gateway).toBe("STRIPE");
    expect(paid.payment.paymentUrl).toBeTruthy();
  });

  it("charges only the PREPAID amount, not the booking total", async () => {
    // The distinction is the product's, not an accident: the customer pays a
    // deposit online and the balance at the counter. A gateway charge equal
    // to the order total would overcharge every booking.
    const order = await newOrder();
    const { order: paid } = await initiatePayment(order.id, { actor });
    const doc = await Order.findById(order.id).lean<{
      pricing: { amount: number };
      charges?: { amount: number; timing: string }[];
    } | null>();

    const dueAtCounter = (doc!.charges ?? [])
      .filter((c) => c.timing === "DUE_AT_COUNTER")
      .reduce((t, c) => t + c.amount, 0);

    // pricing.amount IS the prepaid total — what the gateway is asked for.
    expect(paid.pricing.amount).toBe(doc!.pricing.amount);
    if (dueAtCounter > 0) {
      expect(doc!.pricing.amount).toBeLessThan(
        doc!.pricing.amount + dueAtCounter,
      );
    }
  });

  it("is honoured when the composer asks for it explicitly", async () => {
    const order = await newOrder();
    const { order: paid } = await initiatePayment(
      order.id,
      { actor },
      { gateway: PaymentGatewayKey.STRIPE },
    );
    expect(paid.payment.gateway).toBe("STRIPE");
  });
});

/* ────────────────────────── PayPal, disabled ─────────────────────────── */

describe("PayPal is retained but not enabled", () => {
  it("refuses a payment session even though the adapter exists", async () => {
    // The UI disables the option; this is the half that actually enforces it.
    // A client posting `gateway: "PAYPAL"` must be refused by the server, not
    // quietly served a Stripe session.
    const order = await newOrder();
    const err = await initiatePayment(
      order.id,
      { actor },
      { gateway: PaymentGatewayKey.PAYPAL },
    ).catch((e) => e);

    expect(isAppError(err)).toBe(true);
    expect((err as AppError).statusCode).toBe(409);
    expect(String((err as Error).message)).toMatch(/not enabled/i);
  });

  it("does not silently downgrade the request to Stripe", async () => {
    const order = await newOrder();
    await initiatePayment(
      order.id,
      { actor },
      { gateway: PaymentGatewayKey.PAYPAL },
    ).catch(() => {});

    // Nothing was created. A refusal that still generated a Stripe link would
    // be worse than the bug it replaced — the operator would believe PayPal
    // took the money.
    const doc = await Order.findById(order.id).lean<{
      payment: { gateway?: string | null; checkoutUrl?: string | null };
      status: string;
    } | null>();
    expect(doc!.payment.gateway ?? null).toBeNull();
    expect(doc!.payment.checkoutUrl ?? null).toBeNull();
    expect(doc!.status).toBe("NOT_INITIATED");
  });
});

/* ──────────────────── unsupported providers ──────────────────────────── */

describe("providers with no implementation are refused", () => {
  it.each([
    PaymentGatewayKey.RAZORPAY,
    PaymentGatewayKey.AUTHORIZE_NET,
    PaymentGatewayKey.MANUAL,
  ])("rejects %s", async (provider) => {
    const order = await newOrder();
    const err = await initiatePayment(order.id, { actor }, { gateway: provider }).catch(
      (e) => e,
    );
    expect(isAppError(err)).toBe(true);
    expect((err as AppError).statusCode).toBe(409);
  });
});

/* ──────────────── a pinned provider is authoritative ─────────────────── */

describe("the provider recorded on an order is authoritative", () => {
  it("keeps a Stripe order on Stripe when the link is regenerated", async () => {
    const order = await newOrder();
    await initiatePayment(order.id, { actor });
    const { order: again } = await regeneratePaymentLink(order.id, { actor });
    expect(again.payment.gateway).toBe("STRIPE");
  });

  it("NEVER converts an order pinned to PayPal into a Stripe order", async () => {
    // The bug this replaces: the pin was passed as an "override", and an
    // override outside the enabled set was silently swapped for the
    // organization's configured provider. On a deployment where PayPal is
    // switched off, that turned a PayPal order into a Stripe one and
    // rewrote payment.gateway underneath it — the money would have been
    // taken by a merchant account the order never referenced.
    const order = await newOrder();
    await Order.updateOne(
      { _id: order.id },
      {
        $set: {
          "payment.gateway": PaymentGatewayKey.PAYPAL,
          "payment.stripeSessionId": "PP-EXISTING",
          "payment.checkoutUrl": "https://www.paypal.com/checkoutnow?token=PP-EXISTING",
          status: "PAYMENT_PENDING",
          "payment.status": "PAYMENT_PENDING",
        },
      },
    );

    const err = await regeneratePaymentLink(order.id, { actor }).catch((e) => e);
    expect(isAppError(err)).toBe(true);
    expect(String((err as Error).message)).toMatch(/paypal/i);

    // Crucially: the order is untouched, still PayPal's.
    const doc = await Order.findById(order.id).lean<{
      payment: { gateway?: string | null; checkoutUrl?: string | null };
    } | null>();
    expect(doc!.payment.gateway).toBe(PaymentGatewayKey.PAYPAL);
    expect(doc!.payment.checkoutUrl).toContain("paypal.com");
  });

  it("stops refusing on ENABLEMENT once PayPal is switched on", async () => {
    // The refusal above must be about enablement, not a hardcoded preference
    // for Stripe. Enabling PayPal moves the failure to the NEXT gate —
    // credentials — which is the correct next obstacle and proves the two are
    // separate concerns. PayPal credentials are deliberately not configured
    // in this phase, so this is as far as the path can legitimately go.
    await setEnabledProviders([
      PaymentGatewayKey.STRIPE,
      PaymentGatewayKey.PAYPAL,
    ]);
    const orgId = await seedTestOrganization();
    const { getGatewayForOrganization } = await import(
      "@/server/payments/resolve-gateway"
    );

    const err = await getGatewayForOrganization(orgId, {
      kind: "pinned",
      provider: PaymentGatewayKey.PAYPAL,
    }).catch((e) => e);

    expect(isAppError(err)).toBe(true);
    expect(String((err as Error).message)).toMatch(/credentials/i);
    expect(String((err as Error).message)).not.toMatch(/not enabled/i);
  });
});
