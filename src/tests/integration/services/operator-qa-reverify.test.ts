import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OrderStatus, PaymentGatewayKey, UserRole } from "@/lib/constants/enums";
import { Order } from "@/server/db/models";
import { POST as sendRoute } from "@/app/api/orders/[id]/send-payment-request/route";
import { POST as modifyRoute } from "@/app/api/orders/[id]/modify/route";
import { _resetRateLimitsForTests } from "@/server/api/security";
import { env } from "@/lib/env";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { mockNextHeaders } from "@/tests/utils/next-headers";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { seedTestOrganization } from "@/tests/utils/organization";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";
import {
  completedWebhook,
  paymentIntentFailedWebhook,
} from "@/tests/fixtures/webhook.fixture";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";

/**
 * Defects the post-fix re-verification pass still found, with the checks
 * that keep each fix from over-reaching (the unaffected path still works).
 */

vi.mock("@/server/email/smtp", () => ({
  getMailer: () => ({
    sendMail: async () => ({ messageId: "<id>", response: "250 Accepted" }),
  }),
  verifyMailer: async () => {},
}));

const { drainOnePendingEmail } = await import(
  "@/server/services/email-outbox.service"
);
const {
  createOrder,
  initiatePayment,
  applyOrderModification,
  regeneratePaymentLink,
  resendConfirmationEmail,
  recordManualPayment,
  setOrderRiskFlag,
} = await import("@/server/services/order.service");
const { processStripeEvent } = await import("@/server/services/webhook.service");
const { toPublicConsentPayload, recordConsentFromToken } = await import(
  "@/server/services/consent.service"
);

const admin = actorFor(UserRole.ADMIN);
const ctx = { actor: admin, request: null };
let headersMock: Awaited<ReturnType<typeof mockNextHeaders>>;
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await seedTestOrganization();
  headersMock = await mockNextHeaders();
  sessionMock = await mockSession(admin);
});

afterEach(async () => {
  await headersMock.restore();
  sessionMock?.restore();
  sessionMock = null;
});

const lines = (n: number) => [
  { name: "Rental cost", amount: n, timing: "PREPAID" as const },
];
const params = (id: string) => ({ params: Promise.resolve({ id }) });

type Raw = {
  status: string;
  risk?: { flagged?: boolean };
  payment: { checkoutUrl: string | null; stripeSessionId: string | null };
};
const raw = (id: string) => Order.findById(id).lean<Raw>();

describe("a mismatched payment on the link the order is presenting", () => {
  it("retires that link instead of offering it again", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx,
    );
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    await applyOrderModification(order.id, { charges: lines(650) }, ctx);
    await regeneratePaymentLink(order.id, ctx);
    const current = (await raw(order.id))!.payment.stripeSessionId!;

    const r = await processStripeEvent(
      completedWebhook({
        orderId: order.id,
        orderNumber: order.orderNumber,
        sessionId: current,
        amount: 500,
      }),
    );
    expect(r.reason).toBe("competing_payment:amount-mismatch");

    const after = (await raw(order.id))!;
    expect(after.status).toBe(OrderStatus.FAILED);
    expect(after.payment.checkoutUrl).toBeNull();
    expect(after.risk?.flagged).toBe(true);

    // No new link while that payment is unreconciled…
    await expect(regeneratePaymentLink(order.id, ctx)).rejects.toThrow(
      /Reconcile it first/,
    );
    // …once it is (refunded, flag cleared), a fresh link can be made for the
    // amount actually owed.
    await setOrderRiskFlag(order.id, { flagged: false }, ctx);
    await regeneratePaymentLink(order.id, ctx);
    const next = (await raw(order.id))!;
    expect(next.payment.checkoutUrl).toBeTruthy();
    expect(next.payment.stripeSessionId).not.toBe(current);
  });

  it("stops the live link when an old session is paid, so the customer is not charged twice", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx,
    );
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    const old = (await raw(order.id))!.payment.stripeSessionId!;
    await regeneratePaymentLink(order.id, ctx);
    const live = (await raw(order.id))!.payment.stripeSessionId!;

    await processStripeEvent(
      completedWebhook({
        orderId: order.id,
        orderNumber: order.orderNumber,
        sessionId: old,
        amount: 500,
      }),
    );
    const after = (await raw(order.id))!;
    expect(after.status).toBe(OrderStatus.FAILED);
    expect(after.payment.checkoutUrl).toBeNull();
    // The live session was asked to close at the gateway.
    expect(getCurrentTestStripe().sessionsExpired).toContain(live);
  });
});

describe("the customer's live link is cancelled only once the change is saved", () => {
  it("a re-price that loses a race leaves the live session payable", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx,
    );
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    const live = (await raw(order.id))!.payment.stripeSessionId!;
    const stripe = getCurrentTestStripe();

    // Another write lands between the read and the conditional save.
    const lost = Object.assign(new Error("No document found"), {
      name: "DocumentNotFoundError",
    });
    const spy = vi.spyOn(Order.prototype, "save").mockRejectedValueOnce(lost);
    try {
      await expect(
        applyOrderModification(order.id, { charges: lines(650) }, ctx),
      ).rejects.toThrow(/changed after you opened it/i);
    } finally {
      spy.mockRestore();
    }

    // Before: the session was expired at the gateway while the order still
    // presented it as the customer's link.
    expect(stripe.sessionsExpired).not.toContain(live);
    const now = (await raw(order.id))!;
    expect(now.payment.stripeSessionId).toBe(live);
    expect(now.payment.checkoutUrl).toBeTruthy();
  });

  it("a re-price that saves still cancels the old session", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx,
    );
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    const live = (await raw(order.id))!.payment.stripeSessionId!;
    await applyOrderModification(order.id, { charges: lines(650) }, ctx);
    expect(getCurrentTestStripe().sessionsExpired).toContain(live);
  });
});

describe("background bookkeeping does not block an operator's edit", () => {
  it("sending the confirmation email leaves an open edit form current", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx,
    );
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    const sessionId = (await raw(order.id))!.payment.stripeSessionId!;
    await processStripeEvent(
      completedWebhook({
        orderId: order.id,
        orderNumber: order.orderNumber,
        sessionId,
        amount: 500,
      }),
    );
    // The operator opens the edit page for the just-paid order…
    const loaded = (await Order.findById(order.id).lean<{ updatedAt: Date }>())!
      .updatedAt.toISOString();

    // …and the outbox sends the confirmation meanwhile.
    const drained = await drainOnePendingEmail();
    expect(drained).not.toBeNull();
    const after = await Order.findById(order.id).lean<{
      updatedAt: Date;
      payment: { confirmationEmailSentAt: Date | null };
    }>();
    expect(after!.payment.confirmationEmailSentAt).toBeTruthy();

    // Before: this save was refused as "changed after you opened it".
    const r = await applyOrderModification(
      order.id,
      { customer: { phone: "+15555550199" }, expectedUpdatedAt: loaded },
      ctx,
    );
    expect(r.order.customer.phone).toBe("+15555550199");
  });
});

describe("resending a confirmation that is still queued", () => {
  it("sends it once, not twice", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx,
    );
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    const sessionId = (await raw(order.id))!.payment.stripeSessionId!;
    await processStripeEvent(
      completedWebhook({
        orderId: order.id,
        orderNumber: order.orderNumber,
        sessionId,
        amount: 500,
      }),
    );
    const { PendingEmail } = await import("@/server/db/models");
    expect(
      await PendingEmail.countDocuments({ orderId: order.id, status: "PENDING" }),
    ).toBe(1);

    await resendConfirmationEmail(order.id, ctx);

    // The queued automatic copy is settled by the resend…
    expect(
      await PendingEmail.countDocuments({ orderId: order.id, status: "PENDING" }),
    ).toBe(0);
    // …so the background drain has nothing left to send for this order.
    expect(await drainOnePendingEmail()).toBeNull();
  });
});

describe("a card decline that names no checkout session", () => {
  // Real Stripe Checkout sessions carry no payment-intent id until the
  // customer pays, so the order has none recorded — as here.
  async function liveOrderWithoutIntent() {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx,
    );
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    await Order.updateOne(
      { _id: order.id },
      { $set: { "payment.paymentIntentId": null } },
    );
    return order;
  }

  it("records the checkout key on the order and on the Stripe payment", async () => {
    const order = await liveOrderWithoutIntent();
    const key = (await Order.findById(order.id).lean<{
      payment: { checkoutKey: string | null };
    }>())!.payment.checkoutKey;
    expect(key).toBe(`order:${order.id}:checkout`);
    const created = getCurrentTestStripe().sessionsCreated.at(-1)!;
    const params = created.params as {
      payment_intent_data?: { metadata?: Record<string, string> };
    };
    expect(params.payment_intent_data?.metadata?.checkoutKey).toBe(key);
  });

  it("a late decline from a replaced link leaves the live link alone", async () => {
    const order = await liveOrderWithoutIntent();
    const oldKey = `order:${order.id}:checkout`;
    await regeneratePaymentLink(order.id, ctx);
    const before = (await raw(order.id))!;

    const r = await processStripeEvent(
      paymentIntentFailedWebhook({
        paymentIntentId: "pi_late_decline",
        orderId: order.id,
        checkoutKey: oldKey,
        message: "Your card was declined.",
      }),
    );
    expect(r.reason).toBe("stale_session_failed");
    const after = (await raw(order.id))!;
    expect(after.status).toBe(before.status);
    expect(after.payment.checkoutUrl).toBe(before.payment.checkoutUrl);
  });

  it("a decline on the current link still shows the payment failed", async () => {
    const order = await liveOrderWithoutIntent();
    await processStripeEvent(
      paymentIntentFailedWebhook({
        paymentIntentId: "pi_current_decline",
        orderId: order.id,
        checkoutKey: `order:${order.id}:checkout`,
        message: "Your card was declined.",
      }),
    );
    expect((await raw(order.id))!.status).toBe(OrderStatus.FAILED);
  });
});

describe("switching to manual collection stops the gateway link", () => {
  const sendManual = (id: string) =>
    sendRoute(
      buildRequest(`/api/orders/${id}/send-payment-request`, {
        method: "POST",
        body: { collection: "MANUAL" },
      }),
      params(id) as never,
    );

  it("a payment on the old Stripe link is flagged, and the manual payment settles the order", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx,
    );
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    const stripeSession = (await raw(order.id))!.payment.stripeSessionId!;

    const res = await sendManual(order.id);
    const { status, body } = await jsonBody(res);
    expect(status).toBe(200);
    const token = (body as { data: { sent: { consentToken: string } } }).data.sent
      .consentToken;

    const stood = await Order.findById(order.id).lean<{
      status: string;
      payment: {
        checkoutUrl: string | null;
        failureReason: string | null;
        attempts: Array<{ sessionId: string; supersededAt: Date | null }>;
      };
    }>();
    expect(stood!.status).toBe(OrderStatus.FAILED);
    expect(stood!.payment.checkoutUrl).toBeNull();
    expect(stood!.payment.failureReason).toBe("Replaced by a manual payment request");
    expect(
      stood!.payment.attempts.some((a) => a.sessionId === stripeSession && a.supersededAt),
    ).toBe(true);

    // The customer pays the old Stripe tab anyway. Before: this settled the
    // order as its current session, silently, while the operator was
    // charging the terminal.
    const r = await processStripeEvent(
      completedWebhook({
        orderId: order.id,
        orderNumber: order.orderNumber,
        sessionId: stripeSession,
        amount: 500,
      }),
    );
    expect(r.reason).toMatch(/competing_payment/);
    const afterLate = (await raw(order.id))!;
    expect(afterLate.status).not.toBe(OrderStatus.PAID);
    expect(afterLate.risk?.flagged).toBe(true);

    // The manual path still completes on the same order.
    // The statement is whatever the send asked the customer to confirm.
    const { PaymentConsent } = await import("@/server/db/models");
    const request = await PaymentConsent.findOne({ orderId: order.id })
      .sort({ requestedAt: -1 })
      .lean<{ consentMessage: string }>();
    await recordConsentFromToken(
      {
        token,
        acknowledgement: request!.consentMessage,
        signedName: "Ada Lovelace",
      },
      { branding: { brandName: "Test Brand" }, request: null },
    );
    // Money is already held on the old link: the operator must review it.
    await expect(
      recordManualPayment(
        order.id,
        { method: "Card terminal", reference: "AUTH-MANUAL-01" },
        ctx,
      ),
    ).rejects.toThrow(/already received on an earlier link/i);
    const paid = await recordManualPayment(
      order.id,
      { method: "Card terminal", reference: "AUTH-MANUAL-01", heldPaymentReviewed: true },
      ctx,
    );
    expect(paid.status).toBe(OrderStatus.PAID);
    expect(paid.id).toBe(order.id);
    expect(paid.orderNumber).toBe(order.orderNumber);
  });

  it("an order with no link is left as it is", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx,
    );
    expect((await sendManual(order.id)).status).toBe(200);
    expect((await raw(order.id))!.status).toBe(OrderStatus.NOT_INITIATED);
  });
});

describe("POST /api/orders/[id]/send-payment-request", () => {
  async function liveOrder() {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx,
    );
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    return order;
  }
  const send = (id: string, body: unknown) =>
    sendRoute(
      buildRequest(`/api/orders/${id}/send-payment-request`, {
        method: "POST",
        body,
      }),
      params(id) as never,
    );

  it("names the problem with an override address", async () => {
    const order = await liveOrder();
    const res = await send(order.id, {
      collection: "GATEWAY",
      customer: { email: "not-an-email" },
    });
    const { status, body } = await jsonBody(res);
    expect(status).toBe(422);
    expect(JSON.stringify(body)).toMatch(/Enter a valid email/);
    expect(JSON.stringify(body)).not.toMatch(/"message":"Invalid request data"/);
  });

  it("refuses a local part longer than 64 characters and stores nothing", async () => {
    const order = await liveOrder();
    const res = await send(order.id, {
      collection: "GATEWAY",
      customer: { email: `${"z".repeat(65)}@payops.test` },
    });
    expect(res.status).toBe(422);
    const now = await Order.findById(order.id).lean<{ customer: { email: string } }>();
    expect(now!.customer.email).toBe(order.customer.email);
  });

  it("refuses an over-long address with a plain message", async () => {
    const order = await liveOrder();
    const res = await send(order.id, {
      collection: "GATEWAY",
      customer: { email: `${"a".repeat(60)}@${"b".repeat(250)}.com` },
    });
    const { status, body } = await jsonBody(res);
    expect(status).toBe(422);
    expect(JSON.stringify(body)).not.toMatch(/Path `email`/);
  });

  it("stops the same operator re-sending one order more than 3 times a minute", async () => {
    // A well-formed request that is refused later (no link yet) still
    // counts, so this exercises the limit without sending any email.
    // Orders are created first: test mode also switches transactions off.
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx,
    );
    const other = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx,
    );
    const mode = process.env.PAYOPS_TEST_MODE;
    delete process.env.PAYOPS_TEST_MODE;
    // Outside test mode the same-origin guard runs too.
    headersMock.headerMap.set("origin", env.server.APP_URL);
    _resetRateLimitsForTests();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await send(order.id, { collection: "GATEWAY" })).status);
      }
      expect(statuses).toEqual([409, 409, 409, 429]);
      // Another order is not affected.
      expect((await send(other.order.id, { collection: "GATEWAY" })).status).toBe(409);
    } finally {
      process.env.PAYOPS_TEST_MODE = mode;
      _resetRateLimitsForTests();
    }
  });
});

describe("POST /api/orders/[id]/modify", () => {
  const modify = (id: string, body: unknown) =>
    modifyRoute(
      buildRequest(`/api/orders/${id}/modify`, { method: "POST", body }),
      params(id) as never,
    );

  it("refuses an edit that does not say which version it was made against", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx,
    );
    await applyOrderModification(order.id, { charges: lines(650) }, ctx);
    // A stale tab from before the check would send the old amount back.
    const res = await modify(order.id, { charges: lines(500) });
    expect(res.status).toBe(409);
    const now = await Order.findById(order.id).lean<{ pricing: { amount: number } }>();
    expect(now!.pricing.amount).toBe(650);
  });

  it("applies an edit made against the current version", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx,
    );
    const loaded = (await Order.findById(order.id).lean<{ updatedAt: Date }>())!
      .updatedAt.toISOString();
    const res = await modify(order.id, {
      customer: { phone: "+15555550177" },
      expectedUpdatedAt: loaded,
    });
    expect(res.status).toBe(200);
  });
});

describe("public consent payload", () => {
  it("never carries the organization id", () => {
    const payload = toPublicConsentPayload({
      status: "REQUESTED",
      customerName: "Ada",
      customerEmail: "ada@payops.test",
      brandName: "Brand",
      organizationId: "6aaa00000000000000000001",
      consentMessage: "x",
      snapshot: {} as never,
      paymentUrl: null,
      alreadyConfirmedAt: null,
      collection: "GATEWAY",
      outdated: false,
      orderPaid: false,
    } as never);
    expect("organizationId" in payload).toBe(false);
  });

  it("never carries the link the request was sent with", () => {
    const payload = toPublicConsentPayload({
      status: "VERIFIED",
      customerName: "Ada",
      customerEmail: "ada@payops.test",
      brandName: "Brand",
      consentMessage: "x",
      snapshot: { paymentLinkRef: "https://pay.example/cs_old" } as never,
      paymentUrl: null,
      alreadyConfirmedAt: null,
      collection: "GATEWAY",
      outdated: false,
      orderPaid: true,
    } as never);
    expect(payload.snapshot.paymentLinkRef).toBeNull();
  });
});
