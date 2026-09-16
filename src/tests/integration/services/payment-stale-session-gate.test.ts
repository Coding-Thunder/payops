import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuditAction, OrderStatus, PaymentGatewayKey, UserRole } from "@/lib/constants/enums";
import { AuditLog, Order } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { seedTestOrganization } from "@/tests/utils/organization";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * THE INVARIANT: no stale or superseded checkout session can produce an
 * incorrect successful payment state.
 *
 * This is asserted at the service layer, where the transition actually
 * happens, not just against the pure classifier — the classifier being right
 * is worth nothing if `applyCheckoutPaid` never consults it.
 *
 * The gate lives INSIDE `applyCheckoutPaid` rather than at each caller, so
 * every route to PAID inherits it: the Stripe webhook, the PayPal webhook
 * (both arrive through `processGatewayEvent` → `handleCheckoutCompleted`)
 * and the operator-facing reconcile endpoint.
 *
 * Money is never discarded. A competing payment is recorded as an attempt
 * and the order is flagged for a human, because `PaymentGateway` exposes no
 * refund method — resolution is an operator action.
 */

const { createOrder, repriceOrder } = await import(
  "@/server/services/order.service"
);
const { applyCheckoutPaid } = await import("@/server/services/webhook.service");

const admin = actorFor(UserRole.ADMIN);
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await seedTestOrganization();
  sessionMock = await mockSession(admin);
  return () => {
    sessionMock?.restore();
    sessionMock = null;
    vi.useRealTimers();
  };
});

const ctx = () => ({ actor: admin, request: null });
const lines = (n: number) => [
  { name: "Rental cost", amount: n, timing: "PREPAID" as const },
];

async function seedOrderWithSession(amount = 500, sessionId = "cs_A") {
  const { order } = await createOrder(
    validCreateOrderInput({ charges: lines(amount) }),
    ctx(),
  );
  await Order.updateOne(
    { _id: order.id },
    {
      $set: {
        status: OrderStatus.PAYMENT_PENDING,
        "payment.status": OrderStatus.PAYMENT_PENDING,
        "payment.gateway": PaymentGatewayKey.STRIPE,
        "payment.stripeSessionId": sessionId,
        "payment.checkoutUrl": `https://checkout.stripe.com/c/pay/${sessionId}`,
        "payment.initiatedAt": new Date(),
      },
    },
  );
  return order.id;
}

const paid = (over: Partial<{ eventId: string; sessionId: string; amountTotal: number | null }> = {}) => ({
  eventId: "evt_1",
  sessionId: "cs_A",
  paymentIntentId: "pi_1",
  amountTotal: 50_000,
  paidAtMs: Date.now(),
  source: "webhook" as const,
  ...over,
});

describe("current session — the ordinary path still works", () => {
  it("marks the order PAID", async () => {
    const id = await seedOrderWithSession();
    const doc = (await Order.findById(id))!;

    const r = await applyCheckoutPaid(doc, paid());

    expect(r.handled).toBe(true);
    const raw = await Order.findById(id).lean<{ status: string; payment: { amountReceived: number } }>();
    expect(raw!.status).toBe(OrderStatus.PAID);
    expect(raw!.payment.amountReceived).toBe(500);
  });

  it("is idempotent for a duplicate delivery of the same event", async () => {
    const id = await seedOrderWithSession();
    const doc = (await Order.findById(id))!;
    await applyCheckoutPaid(doc, paid());

    const again = (await Order.findById(id))!;
    const second = await applyCheckoutPaid(again, paid());

    expect(second.duplicate).toBe(true);
    const rows = await AuditLog.find({
      entityId: String(id),
      action: AuditAction.PAYMENT_SUCCEEDED,
    }).lean();
    expect(rows).toHaveLength(1);
  });
});

describe("superseded session — the invariant", () => {
  it("does NOT mark the order PAID at the stale amount", async () => {
    // $500 link goes out, operator re-prices to $650, customer pays the
    // OLD link anyway.
    const id = await seedOrderWithSession(500, "cs_A");
    await repriceOrder(id, { charges: lines(650) }, ctx());

    const doc = (await Order.findById(id))!;
    const r = await applyCheckoutPaid(
      doc,
      paid({ sessionId: "cs_A", amountTotal: 50_000 }),
    );

    const raw = await Order.findById(id).lean<{
      status: string;
      pricing: { amount: number };
      payment: { amountReceived: number | null; paidAt: Date | null };
    }>();

    // The order must NOT be settled by a payment for an amount nobody owes.
    expect(raw!.status).not.toBe(OrderStatus.PAID);
    expect(raw!.payment.amountReceived).toBeNull();
    expect(raw!.payment.paidAt).toBeNull();
    // ...and the current amount is untouched.
    expect(raw!.pricing.amount).toBe(650);
    expect(r.reason).toContain("competing_payment");
  });

  it("preserves the money as a recorded attempt rather than discarding it", async () => {
    const id = await seedOrderWithSession(500, "cs_A");
    await repriceOrder(id, { charges: lines(650) }, ctx());
    const doc = (await Order.findById(id))!;

    await applyCheckoutPaid(doc, paid({ sessionId: "cs_A", amountTotal: 50_000 }));

    const raw = await Order.findById(id).lean<{
      payment: { attempts: Array<{ sessionId: string; amount: number; status: string }> };
    }>();
    // Two entries: the superseded link, and the payment that landed on it.
    const settled = raw!.payment.attempts.filter((a) => a.status === OrderStatus.PAID);
    expect(settled).toHaveLength(1);
    expect(settled[0].sessionId).toBe("cs_A");
    expect(settled[0].amount).toBe(500);
  });

  it("flags the order so an operator actually sees it", async () => {
    const id = await seedOrderWithSession(500, "cs_A");
    await repriceOrder(id, { charges: lines(650) }, ctx());
    const doc = (await Order.findById(id))!;

    await applyCheckoutPaid(doc, paid({ sessionId: "cs_A" }));

    const raw = await Order.findById(id).lean<{
      risk: { flagged: boolean; flaggedNote: string };
    }>();
    expect(raw!.risk.flagged).toBe(true);
    expect(raw!.risk.flaggedNote).toMatch(/superseded/i);
  });

  it("writes an audit row naming the competing session", async () => {
    const id = await seedOrderWithSession(500, "cs_A");
    await repriceOrder(id, { charges: lines(650) }, ctx());
    const doc = (await Order.findById(id))!;

    await applyCheckoutPaid(doc, paid({ sessionId: "cs_A" }));

    const rows = await AuditLog.find({
      entityId: String(id),
      action: AuditAction.PAYMENT_COMPETING_SESSION,
    }).lean<Array<{ metadata: Record<string, unknown> }>>();
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.kind).toBe("superseded-session");
    expect(rows[0].metadata.sessionId).toBe("cs_A");
    expect(rows[0].metadata.currentOrderAmount).toBe(650);
  });

  it("is idempotent — a retried stale webhook records once", async () => {
    const id = await seedOrderWithSession(500, "cs_A");
    await repriceOrder(id, { charges: lines(650) }, ctx());

    for (const _ of [1, 2, 3]) {
      const doc = (await Order.findById(id))!;
      await applyCheckoutPaid(doc, paid({ sessionId: "cs_A", eventId: "evt_stale" }));
    }

    const rows = await AuditLog.find({
      entityId: String(id),
      action: AuditAction.PAYMENT_COMPETING_SESSION,
    }).lean();
    expect(rows).toHaveLength(1);
  });
});

describe("competing gateway success — the double-charge case", () => {
  it("a late Stripe success after the order is settled cannot double-pay", async () => {
    // PayPal settles the order; the old Stripe link then also succeeds.
    const id = await seedOrderWithSession(500, "PAYPAL-1");
    const doc = (await Order.findById(id))!;
    await applyCheckoutPaid(doc, paid({ sessionId: "PAYPAL-1", eventId: "evt_pp" }));

    const settled = await Order.findById(id).lean<{
      payment: { amountReceived: number; paidAt: Date };
    }>();

    const again = (await Order.findById(id))!;
    const r = await applyCheckoutPaid(
      again,
      paid({ sessionId: "cs_A", eventId: "evt_stripe_late", amountTotal: 50_000 }),
    );

    const after = await Order.findById(id).lean<{
      status: string;
      risk: { flagged: boolean };
      payment: { amountReceived: number; paidAt: Date };
    }>();

    // Still exactly one successful payment on the order.
    expect(after!.status).toBe(OrderStatus.PAID);
    expect(after!.payment.amountReceived).toBe(settled!.payment.amountReceived);
    expect(after!.payment.paidAt!.getTime()).toBe(settled!.payment.paidAt!.getTime());
    // But the second real payment is surfaced, not swallowed.
    expect(after!.risk.flagged).toBe(true);
    expect(r.reason).toContain("competing_payment");
  });

  it("records the second payment for reconciliation", async () => {
    const id = await seedOrderWithSession(500, "PAYPAL-1");
    const doc = (await Order.findById(id))!;
    await applyCheckoutPaid(doc, paid({ sessionId: "PAYPAL-1", eventId: "evt_pp" }));
    const again = (await Order.findById(id))!;
    await applyCheckoutPaid(
      again,
      paid({ sessionId: "cs_A", eventId: "evt_late", amountTotal: 50_000 }),
    );

    const rows = await AuditLog.find({
      entityId: String(id),
      action: AuditAction.PAYMENT_COMPETING_SESSION,
    }).lean<Array<{ metadata: Record<string, unknown> }>>();
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.kind).toBe("already-settled");
  });
});
