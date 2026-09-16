import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuditAction,
  OrderStatus,
  PaymentGatewayKey,
  UserRole,
} from "@/lib/constants/enums";
import { AuditLog, Order } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { seedTestOrganization } from "@/tests/utils/organization";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";
import {
  asyncPaymentFailedWebhook,
  completedWebhook,
  expiredWebhook,
} from "@/tests/fixtures/webhook.fixture";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";

/**
 * Regressions from the operator worst-case QA pass — the payment-state
 * defects. Every test here failed against the code before the fix.
 *
 * Common thread: an order moves through several checkout sessions (created,
 * replaced, re-priced, switched), and events for OLD sessions keep arriving.
 * Only the session the order is currently collecting on, for the amount it
 * is currently collecting, may settle it or change its status.
 */

const {
  createOrder,
  initiatePayment,
  regeneratePaymentLink,
  applyOrderModification,
} = await import("@/server/services/order.service");
const { processStripeEvent } = await import("@/server/services/webhook.service");

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

const ctx = { actor: admin, request: null };
const lines = (n: number) => [
  { name: "Rental cost", amount: n, timing: "PREPAID" as const },
];

type RawOrder = {
  status: string;
  pricing: { amount: number };
  risk?: { flagged?: boolean };
  consent: { status: string };
  payment: {
    stripeSessionId: string | null;
    checkoutUrl: string | null;
    amountReceived: number | null;
    priceRevision: number;
    attempts: Array<{
      sessionId: string | null;
      gateway: string;
      supersededReason: string | null;
      supersededAt: Date | null;
      amount: number;
      status: string;
    }>;
  };
};
const raw = (id: string) => Order.findById(id).lean<RawOrder>();

async function orderWithLink(amount = 500) {
  const { order } = await createOrder(
    validCreateOrderInput({ charges: lines(amount) }),
    ctx,
  );
  await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
  const r = await raw(order.id);
  return { order, sessionId: r!.payment.stripeSessionId! };
}

const paid = (
  order: { id: string; orderNumber: string },
  sessionId: string,
  amount: number,
) =>
  completedWebhook({
    orderId: order.id,
    orderNumber: order.orderNumber,
    sessionId,
    amount,
  });

describe("regenerating a link records the session it replaces", () => {
  it("a late success on the replaced session does not settle the order", async () => {
    const { order, sessionId: oldSession } = await orderWithLink(500);
    await regeneratePaymentLink(order.id, ctx);
    const after = await raw(order.id);
    expect(after!.payment.stripeSessionId).not.toBe(oldSession);
    expect(
      after!.payment.attempts.some(
        (a) => a.sessionId === oldSession && a.supersededReason === "REGENERATED",
      ),
    ).toBe(true);

    const r = await processStripeEvent(paid(order, oldSession, 500));
    expect(r.reason).toMatch(/competing_payment/);
    const now = await raw(order.id);
    expect(now!.status).not.toBe(OrderStatus.PAID);
    expect(now!.risk?.flagged).toBe(true);
  });

  it("the customer's payment on the NEW link still settles the order", async () => {
    const { order, sessionId: oldSession } = await orderWithLink(500);
    await regeneratePaymentLink(order.id, ctx);
    const newSession = (await raw(order.id))!.payment.stripeSessionId!;

    await processStripeEvent(paid(order, oldSession, 500));
    await processStripeEvent(paid(order, newSession, 500));

    const now = await raw(order.id);
    expect(now!.status).toBe(OrderStatus.PAID);
    expect(now!.payment.amountReceived).toBe(500);
  });

  it("gives every replacement session its own idempotency key", async () => {
    const { order } = await orderWithLink(500);
    await regeneratePaymentLink(order.id, ctx);
    await regeneratePaymentLink(order.id, ctx);
    const keys = getCurrentTestStripe().sessionsCreated.map(
      (s) => (s.options as { idempotencyKey?: string } | undefined)?.idempotencyKey,
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe(`order:${order.id}:checkout`);
  });
});

describe("a success must match the session and the amount being collected", () => {
  it("refuses to settle on a session this order never issued", async () => {
    const { order } = await orderWithLink(500);
    const r = await processStripeEvent(paid(order, "cs_never_issued", 500));
    expect(r.reason).toBe("competing_payment:unknown-session");
    expect((await raw(order.id))!.status).not.toBe(OrderStatus.PAID);
  });

  it("refuses to settle a $650 order on a $500 success", async () => {
    const { order, sessionId } = await orderWithLink(650);
    const r = await processStripeEvent(paid(order, sessionId, 500));
    expect(r.reason).toBe("competing_payment:amount-mismatch");
    const now = await raw(order.id);
    expect(now!.status).not.toBe(OrderStatus.PAID);
    expect(now!.risk?.flagged).toBe(true);
    expect(
      await AuditLog.countDocuments({
        action: AuditAction.PAYMENT_COMPETING_SESSION,
        entityId: order.id,
      }),
    ).toBe(1);
  });

  it("refuses to settle an overpayment as a normal payment", async () => {
    const { order, sessionId } = await orderWithLink(500);
    const r = await processStripeEvent(paid(order, sessionId, 5000));
    expect(r.reason).toBe("competing_payment:amount-mismatch");
    expect((await raw(order.id))!.status).not.toBe(OrderStatus.PAID);
  });

  it("still settles the matching session and amount exactly once", async () => {
    const { order, sessionId } = await orderWithLink(500);
    const event = paid(order, sessionId, 500);
    await processStripeEvent(event);
    await processStripeEvent(event);
    await processStripeEvent(paid(order, sessionId, 500));
    const now = await raw(order.id);
    expect(now!.status).toBe(OrderStatus.PAID);
    expect(now!.payment.amountReceived).toBe(500);
    expect(
      await AuditLog.countDocuments({
        action: AuditAction.PAYMENT_SUCCEEDED,
        entityId: order.id,
      }),
    ).toBe(1);
  });
});

describe("failure and expiry events only act on the current session", () => {
  it("an expiry for a replaced session leaves the live link alone", async () => {
    const { order, sessionId: oldSession } = await orderWithLink(500);
    await regeneratePaymentLink(order.id, ctx);

    const r = await processStripeEvent(
      expiredWebhook({
        orderId: order.id,
        orderNumber: order.orderNumber,
        sessionId: oldSession,
      }),
    );
    expect(r.reason).toBe("stale_session_expired");
    const now = await raw(order.id);
    expect(now!.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(now!.payment.checkoutUrl).toBeTruthy();
  });

  it("a failure for a re-priced session does not fail the new link", async () => {
    const { order, sessionId: oldSession } = await orderWithLink(500);
    await applyOrderModification(order.id, { charges: lines(650) }, ctx);
    await regeneratePaymentLink(order.id, ctx);

    await processStripeEvent(
      asyncPaymentFailedWebhook({
        orderId: order.id,
        orderNumber: order.orderNumber,
        sessionId: oldSession,
      }),
    );
    const now = await raw(order.id);
    expect(now!.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(now!.pricing.amount).toBe(650);
  });

  it("an expiry for the CURRENT session still expires the order", async () => {
    const { order, sessionId } = await orderWithLink(500);
    await processStripeEvent(
      expiredWebhook({
        orderId: order.id,
        orderNumber: order.orderNumber,
        sessionId,
      }),
    );
    expect((await raw(order.id))!.status).toBe(OrderStatus.EXPIRED);
  });
});
