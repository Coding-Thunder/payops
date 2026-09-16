import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuditAction, OrderStatus, PaymentGatewayKey, UserRole } from "@/lib/constants/enums";
import { AuditLog, Order } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { seedTestOrganization, setEnabledProviders } from "@/tests/utils/organization";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * REQ-2 — Stripe declines, the operator offers PayPal, SAME order.
 *
 * The invariant that makes this safe is not in this file: a superseded
 * session's success is turned into a flagged competing payment by
 * `applyCheckoutPaid`'s gate (see payment-stale-session-gate.test.ts). What
 * is asserted here is that the switch itself keeps one order, preserves the
 * failed attempt, and cannot be used on a settled order.
 */

/**
 * The PayPal adapter talks to PayPal over the network and needs live
 * credentials, neither of which belongs in an integration test. What is under
 * test here is the SWITCH logic — same order, attempt history, refusals — so
 * the resolver is stubbed and the adapter is not exercised. The real adapter
 * has its own unit coverage in paypal-gateway.test.ts.
 */
const enabledForTest = new Set<string>(["STRIPE", "PAYPAL"]);

vi.mock("@/server/payments/resolve-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/payments/resolve-gateway")>();
  let counter = 0;
  return {
    ...actual,
    getGatewayForOrganization: vi.fn(async (_orgId: string | null, selection: { provider?: string | null }) => {
      const provider = selection?.provider ?? "STRIPE";
      if (!enabledForTest.has(provider)) {
        throw new actual.PaymentProviderNotEnabledError(
          provider,
          Array.from(enabledForTest),
        );
      }
      return {
        key: provider,
        label: provider === "PAYPAL" ? "PayPal" : "Stripe",
        enabled: true,
        sandbox: true,
        async createSession() {
          counter += 1;
          return {
            sessionId: `${provider.toLowerCase()}_session_${counter}`,
            url: `https://example.test/${provider.toLowerCase()}/checkout/${counter}`,
            paymentIntentId: null,
            expiresAt: new Date(Date.now() + 3600_000),
          };
        },
        async expireSession() {},
        async getSessionStatus() {
          return "open";
        },
        async verifyWebhook() {
          throw new Error("not used");
        },
      };
    }),
  };
});

const { createOrder, switchOrderGateway } = await import(
  "@/server/services/order.service"
);
const { applyCheckoutPaid } = await import("@/server/services/webhook.service");

const admin = actorFor(UserRole.ADMIN);
const staff = actorFor(UserRole.STAFF);
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  // Both gateways switched on for this brand — the switch must refuse a
  // provider the organization has not enabled, so the happy path needs it on.
  await seedTestOrganization();
  await setEnabledProviders([PaymentGatewayKey.STRIPE, PaymentGatewayKey.PAYPAL]);
  enabledForTest.clear();
  enabledForTest.add("STRIPE");
  enabledForTest.add("PAYPAL");
  sessionMock = await mockSession(admin);
  return () => {
    sessionMock?.restore();
    sessionMock = null;
    vi.useRealTimers();
  };
});

const ctx = (actor = admin) => ({ actor, request: null });
const lines = (n: number) => [
  { name: "Rental cost", amount: n, timing: "PREPAID" as const },
];

/** An order whose Stripe payment has declined — status FAILED, session still
 *  on record, which is exactly how `failOrder` leaves it. */
async function declinedStripeOrder(amount = 500) {
  const { order } = await createOrder(
    validCreateOrderInput({ charges: lines(amount) }),
    ctx(),
  );
  await Order.updateOne(
    { _id: order.id },
    {
      $set: {
        status: OrderStatus.FAILED,
        "payment.status": OrderStatus.FAILED,
        "payment.gateway": PaymentGatewayKey.STRIPE,
        "payment.stripeSessionId": "cs_declined",
        "payment.checkoutUrl": "https://checkout.stripe.com/c/pay/cs_declined",
        "payment.failureReason": "card_declined",
        "payment.initiatedAt": new Date(),
      },
    },
  );
  return order;
}

describe("switchOrderGateway — Stripe declined → PayPal", () => {
  it("issues a PayPal link on the SAME order", async () => {
    const order = await declinedStripeOrder();
    const before = await Order.countDocuments({});

    const r = await switchOrderGateway(
      order.id,
      { gateway: PaymentGatewayKey.PAYPAL },
      ctx(),
    );

    expect(r.order.id).toBe(order.id);
    expect(r.order.orderNumber).toBe(order.orderNumber);
    expect(r.checkoutUrl).toBeTruthy();
    // No duplicate order.
    expect(await Order.countDocuments({})).toBe(before);
  });

  it("keeps the same outstanding amount", async () => {
    const order = await declinedStripeOrder(500);
    const r = await switchOrderGateway(
      order.id,
      { gateway: PaymentGatewayKey.PAYPAL },
      ctx(),
    );
    expect(r.order.pricing.amount).toBe(500);
  });

  it("preserves the failed Stripe attempt and appends the PayPal one", async () => {
    const order = await declinedStripeOrder(500);
    await switchOrderGateway(order.id, { gateway: PaymentGatewayKey.PAYPAL }, ctx());

    const raw = await Order.findById(order.id).lean<{
      payment: {
        gateway: string;
        attempts: Array<{
          gateway: string;
          sessionId: string | null;
          amount: number;
          supersededReason: string | null;
        }>;
      };
    }>();

    const stripeAttempt = raw!.payment.attempts.find((a) => a.gateway === "STRIPE");
    const paypalAttempt = raw!.payment.attempts.find((a) => a.gateway === "PAYPAL");

    // The declined Stripe try is history, not overwritten.
    expect(stripeAttempt).toBeTruthy();
    expect(stripeAttempt!.sessionId).toBe("cs_declined");
    expect(stripeAttempt!.amount).toBe(500);
    expect(stripeAttempt!.supersededReason).toBe("GATEWAY_SWITCHED");
    // The live PayPal try sits alongside it.
    expect(paypalAttempt).toBeTruthy();
    expect(paypalAttempt!.supersededReason).toBeNull();
    // And the order now collects through PayPal.
    expect(raw!.payment.gateway).toBe("PAYPAL");
  });

  it("lets a PayPal success settle the SAME order", async () => {
    const order = await declinedStripeOrder(500);
    await switchOrderGateway(order.id, { gateway: PaymentGatewayKey.PAYPAL }, ctx());

    const doc = (await Order.findById(order.id))!;
    await applyCheckoutPaid(doc, {
      eventId: "evt_pp_1",
      sessionId: doc.payment.stripeSessionId!,
      paymentIntentId: null,
      amountTotal: 50_000,
      paidAtMs: Date.now(),
      source: "webhook",
    });

    const raw = await Order.findById(order.id).lean<{
      status: string;
      payment: { amountReceived: number };
    }>();
    expect(raw!.status).toBe(OrderStatus.PAID);
    expect(raw!.payment.amountReceived).toBe(500);
    expect(await Order.countDocuments({})).toBe(1);
  });

  it("a late Stripe success after PayPal settled cannot double-pay", async () => {
    const order = await declinedStripeOrder(500);
    await switchOrderGateway(order.id, { gateway: PaymentGatewayKey.PAYPAL }, ctx());

    const doc = (await Order.findById(order.id))!;
    await applyCheckoutPaid(doc, {
      eventId: "evt_pp_1",
      sessionId: doc.payment.stripeSessionId!,
      paymentIntentId: null,
      amountTotal: 50_000,
      paidAtMs: Date.now(),
      source: "webhook",
    });
    const settled = await Order.findById(order.id).lean<{
      payment: { amountReceived: number; paidAt: Date };
    }>();

    // The old Stripe link was never reliably killable — the customer pays it.
    const again = (await Order.findById(order.id))!;
    const r = await applyCheckoutPaid(again, {
      eventId: "evt_stripe_late",
      sessionId: "cs_declined",
      paymentIntentId: "pi_late",
      amountTotal: 50_000,
      paidAtMs: Date.now(),
      source: "webhook",
    });

    const after = await Order.findById(order.id).lean<{
      status: string;
      risk: { flagged: boolean };
      payment: { amountReceived: number; paidAt: Date };
    }>();

    // Exactly one successful payment stands on the order...
    expect(after!.payment.amountReceived).toBe(settled!.payment.amountReceived);
    expect(after!.payment.paidAt!.getTime()).toBe(settled!.payment.paidAt!.getTime());
    // ...and the second real charge is surfaced for reconciliation, not lost.
    expect(after!.risk.flagged).toBe(true);
    expect(r.reason).toContain("competing_payment");
  });

  it("is idempotent for a duplicate PayPal webhook", async () => {
    const order = await declinedStripeOrder(500);
    await switchOrderGateway(order.id, { gateway: PaymentGatewayKey.PAYPAL }, ctx());
    const sid = (await Order.findById(order.id))!.payment.stripeSessionId!;

    for (const _ of [1, 2]) {
      const doc = (await Order.findById(order.id))!;
      await applyCheckoutPaid(doc, {
        eventId: "evt_pp_dup",
        sessionId: sid,
        paymentIntentId: null,
        amountTotal: 50_000,
        paidAtMs: Date.now(),
        source: "webhook",
      });
    }

    const rows = await AuditLog.find({
      entityId: String(order.id),
      action: AuditAction.PAYMENT_SUCCEEDED,
    }).lean();
    expect(rows).toHaveLength(1);
  });

  it("writes an audit row naming the real operator and both gateways", async () => {
    const order = await declinedStripeOrder();
    await switchOrderGateway(order.id, { gateway: PaymentGatewayKey.PAYPAL }, ctx());

    const rows = await AuditLog.find({
      entityId: String(order.id),
      action: AuditAction.ORDER_PAYMENT_LINK_REGENERATED,
    }).lean<Array<{ metadata: Record<string, unknown>; actor: { userId: string } }>>();
    const sw = rows.find((r) => r.metadata?.action === "gateway_switched");
    expect(sw).toBeTruthy();
    expect(String(sw!.actor.userId)).toBe(admin.id);
    expect(sw!.metadata.fromGateway).toBe("STRIPE");
    expect(sw!.metadata.toGateway).toBe("PAYPAL");
  });
});

describe("switchOrderGateway — refusals", () => {
  it("refuses an order that is already paid", async () => {
    const order = await declinedStripeOrder();
    await Order.updateOne(
      { _id: order.id },
      { $set: { status: OrderStatus.PAID, "payment.status": OrderStatus.PAID } },
    );

    await expect(
      switchOrderGateway(order.id, { gateway: PaymentGatewayKey.PAYPAL }, ctx()),
    ).rejects.toThrow(/already paid/i);
  });

  it("refuses switching to the gateway it is already on", async () => {
    const order = await declinedStripeOrder();
    await expect(
      switchOrderGateway(order.id, { gateway: PaymentGatewayKey.STRIPE }, ctx()),
    ).rejects.toThrow(/already on/i);
  });

  it("refuses a gateway the organization has not enabled", async () => {
    await setEnabledProviders([PaymentGatewayKey.STRIPE]);
    enabledForTest.delete("PAYPAL");
    const order = await declinedStripeOrder();
    await expect(
      switchOrderGateway(order.id, { gateway: PaymentGatewayKey.PAYPAL }, ctx()),
    ).rejects.toThrow();
  });

  it("refuses an unauthorized operator", async () => {
    const order = await declinedStripeOrder();
    await expect(
      switchOrderGateway(order.id, { gateway: PaymentGatewayKey.PAYPAL }, ctx(staff)),
    ).rejects.toThrow();
  });
});
