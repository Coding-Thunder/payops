import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConsentStatus,
  OrderStatus,
  PaymentGatewayKey,
  UserRole,
} from "@/lib/constants/enums";
import { Order, PaymentConsent } from "@/server/db/models";
import { _setPayPalFetchForTesting } from "@/server/payments/gateways/paypal";
import { createPayPalStub } from "@/tests/mocks/paypal-stub";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import {
  TEST_ORG_SLUG,
  seedTestOrganization,
  setEnabledProviders,
} from "@/tests/utils/organization";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";
import { completedWebhook } from "@/tests/fixtures/webhook.fixture";

/**
 * Defects the operator journey pass found by driving the real UI:
 * Stripe → PayPal, Stripe/PayPal → Manual, and an amount change in between.
 * Each test failed before its fix.
 *
 * PayPal runs through the real adapter against the in-process PayPal stub.
 */

vi.mock("@/server/email/smtp", () => ({
  getMailer: () => ({
    sendMail: async () => ({ messageId: "<id>", response: "250 Accepted" }),
  }),
  verifyMailer: async () => {},
}));

const {
  createOrder,
  initiatePayment,
  switchOrderGateway,
  applyOrderModification,
  recordManualPayment,
  regeneratePaymentLink,
  setOrderRiskFlag,
} = await import("@/server/services/order.service");
const { processGatewayEvent, shouldCaptureApprovedOrder } = await import(
  "@/server/services/webhook.service"
);
const { requestConsent, recordConsentFromToken, getPublicConsentView } =
  await import("@/server/services/consent.service");

const admin = actorFor(UserRole.ADMIN);
const ctx = { actor: admin, request: null };
const prefix = `ORG_${TEST_ORG_SLUG.toUpperCase()}_PAYPAL_`;
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

beforeAll(() => {
  process.env[`${prefix}CLIENT_ID`] = "stub-client";
  process.env[`${prefix}CLIENT_SECRET`] = "stub-secret";
  process.env[`${prefix}WEBHOOK_ID`] = "stub-webhook";
  process.env[`${prefix}SANDBOX`] = "true";
});
afterAll(() => {
  for (const k of ["CLIENT_ID", "CLIENT_SECRET", "WEBHOOK_ID", "SANDBOX"]) {
    delete process.env[`${prefix}${k}`];
  }
});

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await seedTestOrganization();
  await setEnabledProviders([PaymentGatewayKey.STRIPE, PaymentGatewayKey.PAYPAL]);
  _setPayPalFetchForTesting(createPayPalStub({ appUrl: "http://127.0.0.1:3100" }).fetch);
  sessionMock = await mockSession(admin);
});
afterEach(() => {
  _setPayPalFetchForTesting(null);
  sessionMock?.restore();
  sessionMock = null;
});

const lines = (n: number) => [
  { name: "Rental cost", amount: n, timing: "PREPAID" as const },
];

type Raw = {
  status: string;
  risk?: { flagged?: boolean; flaggedNote?: string | null };
  consent: { status: string; collectionMethod?: string | null };
  payment: {
    gateway: string | null;
    stripeSessionId: string | null;
    checkoutUrl: string | null;
    failureReason: string | null;
    amountReceived: number | null;
    attempts: Array<{
      gateway: string;
      sessionId: string | null;
      status: string;
      held?: boolean;
      supersededReason: string | null;
      supersededAt: Date | null;
    }>;
  };
};
const raw = (id: string) => Order.findById(id).lean<Raw>();

async function ask(orderId: string, collection: "GATEWAY" | "MANUAL") {
  const o = (await Order.findById(orderId).lean<{
    customer: { name: string; email: string };
    bookingType: string;
    provider: { name: string };
    vehicle: { company: string; type: string };
    trip: { pickupDate: Date; dropoffDate: Date };
    pricing: { amount: number; currency: string };
    payment: { checkoutUrl: string | null };
  }>())!;
  return requestConsent(
    {
      orderId,
      customerEmail: o.customer.email,
      customerName: o.customer.name,
      consentMessage: "I agree to proceed with this booking.",
      consentEmailSubject: "Please confirm",
      collection,
      snapshot: {
        bookingType: o.bookingType as never,
        provider: o.provider.name,
        vehicle: `${o.vehicle.company} ${o.vehicle.type}`,
        pickupDate: o.trip.pickupDate.toISOString(),
        dropoffDate: o.trip.dropoffDate.toISOString(),
        amount: o.pricing.amount,
        currency: o.pricing.currency as never,
        paymentLinkRef: o.payment.checkoutUrl,
      },
    },
    { actor: admin, appUrl: "http://127.0.0.1:3100" },
  );
}
const confirm = (token: string) =>
  recordConsentFromToken(
    { token, acknowledgement: "I agree to proceed with this booking.", signedName: "Ada Lovelace" },
    { branding: { brandName: "Brand" }, request: null },
  );

function paypalEvent(
  type: "checkout.completed",
  order: { id: string },
  sessionId: string,
  amount: number,
) {
  return {
    eventId: `WH-${Math.random().toString(36).slice(2)}`,
    type,
    sessionId,
    orderId: order.id,
    paymentIntentId: `CAPTURE-${Math.random().toString(36).slice(2)}`,
    amountTotalMinor: Math.round(amount * 100),
    occurredAtMs: Date.now(),
    raw: {},
  };
}

async function stripeThenPayPal(amount = 500) {
  const { order } = await createOrder(
    validCreateOrderInput({ charges: lines(amount) }),
    ctx,
  );
  await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
  const stripeSession = (await raw(order.id))!.payment.stripeSessionId!;
  await switchOrderGateway(order.id, { gateway: PaymentGatewayKey.PAYPAL }, ctx);
  const paypalSession = (await raw(order.id))!.payment.stripeSessionId!;
  return { order, stripeSession, paypalSession };
}

describe("a payment already taken on the old link is never taken again", () => {
  it("stands the live PayPal link down and withholds its capture", async () => {
    const { order, stripeSession, paypalSession } = await stripeThenPayPal(500);
    expect(paypalSession).toMatch(/^PAYPAL-STUB-/);

    // The customer pays the old Stripe tab in full.
    const late = await processGatewayEvent(
      completedWebhook({
        orderId: order.id,
        orderNumber: order.orderNumber,
        sessionId: stripeSession,
        amount: 500,
      }),
    );
    expect(late.reason).toBe("competing_payment:superseded-session");

    const after = (await raw(order.id))!;
    expect(after.status).toBe(OrderStatus.FAILED);
    expect(after.payment.checkoutUrl).toBeNull();
    expect(
      after.payment.attempts.some(
        (a) => a.sessionId === paypalSession && a.supersededReason === "PAYMENT_HELD",
      ),
    ).toBe(true);

    // Before: the server captured the PayPal approval — a second $500.
    const decision = await shouldCaptureApprovedOrder(
      {
        eventId: "WH-approved",
        type: "unhandled",
        sessionId: paypalSession,
        orderId: order.id,
        paymentIntentId: null,
        amountTotalMinor: null,
        occurredAtMs: Date.now(),
        raw: {},
      },
      null,
    );
    expect(decision.capture).toBe(false);
  });

  it("makes the operator review the held payment before recording a manual one", async () => {
    const { order, stripeSession } = await stripeThenPayPal(500);
    await confirm((await ask(order.id, "MANUAL")).token);
    await processGatewayEvent(
      completedWebhook({
        orderId: order.id,
        orderNumber: order.orderNumber,
        sessionId: stripeSession,
        amount: 500,
      }),
    );
    const good = { method: "Card terminal", reference: "AUTH-HELD-1" };
    await expect(recordManualPayment(order.id, good, ctx)).rejects.toThrow(
      /already received on an earlier link/i,
    );
    const paid = await recordManualPayment(
      order.id,
      { ...good, heldPaymentReviewed: true },
      ctx,
    );
    expect(paid.status).toBe(OrderStatus.PAID);
  });

  it("still captures the current PayPal checkout when nothing is held", async () => {
    const { order, paypalSession } = await stripeThenPayPal(500);
    const decision = await shouldCaptureApprovedOrder(
      {
        eventId: "WH-ok",
        type: "unhandled",
        sessionId: paypalSession,
        orderId: order.id,
        paymentIntentId: null,
        amountTotalMinor: null,
        occurredAtMs: Date.now(),
        raw: {},
      },
      null,
    );
    expect(decision).toMatchObject({ capture: true });
  });
});

describe("a wrong-amount capture on the current link does not block the right one", () => {
  it("settles the 575 capture after a 500 capture was held", async () => {
    const { order } = await stripeThenPayPal(500);
    await applyOrderModification(order.id, { charges: lines(575) }, ctx);
    await regeneratePaymentLink(order.id, ctx);
    const current = (await raw(order.id))!.payment.stripeSessionId!;

    const wrong = await processGatewayEvent(paypalEvent("checkout.completed", order, current, 500));
    expect(wrong.reason).toBe("competing_payment:amount-mismatch");

    // Before: this was filed as a payment on a superseded session.
    const right = await processGatewayEvent(paypalEvent("checkout.completed", order, current, 575));
    expect(right.reason).toBeUndefined();
    const after = (await raw(order.id))!;
    expect(after.status).toBe(OrderStatus.PAID);
    expect(after.payment.amountReceived).toBe(575);
    expect(after.risk?.flagged).toBe(true);
  });
});

describe("a confirmation covers the way the customer was told they would pay", () => {
  it("a manual request after a confirmed gateway request needs a new confirmation", async () => {
    const { order } = await createOrder(validCreateOrderInput({ charges: lines(500) }), ctx);
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    const gateway = await ask(order.id, "GATEWAY");
    await confirm(gateway.token);
    expect((await raw(order.id))!.consent.status).toBe(ConsentStatus.VERIFIED);

    const manual = await ask(order.id, "MANUAL");
    const now = (await raw(order.id))!;
    expect(now.consent.status).toBe(ConsentStatus.REQUESTED);
    expect(now.consent.collectionMethod).toBe("MANUAL");
    // Before: the gateway confirmation let this through at once.
    await expect(
      recordManualPayment(order.id, { method: "Card terminal", reference: "AUTH-M-1" }, ctx),
    ).rejects.toThrow(/consent/i);

    // The old gateway page no longer forwards anywhere, and cannot stand in.
    const oldView = await getPublicConsentView(gateway.token, { brandName: "Brand" });
    expect(oldView.outdated).toBe(true);
    expect(oldView.paymentUrl).toBeNull();

    await confirm(manual.token);
    const paid = await recordManualPayment(
      order.id,
      { method: "Card terminal", reference: "AUTH-M-1" },
      ctx,
    );
    expect(paid.status).toBe(OrderStatus.PAID);
  });

  it("a resend for the same way of paying keeps the confirmation", async () => {
    const { order } = await createOrder(validCreateOrderInput({ charges: lines(500) }), ctx);
    await confirm((await ask(order.id, "MANUAL")).token);
    await ask(order.id, "MANUAL");
    expect((await raw(order.id))!.consent.status).toBe(ConsentStatus.VERIFIED);
  });

  it("a gateway switch asks the customer to confirm again", async () => {
    const { order } = await createOrder(validCreateOrderInput({ charges: lines(500) }), ctx);
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    const stripeRequest = await ask(order.id, "GATEWAY");
    await confirm(stripeRequest.token);

    await switchOrderGateway(order.id, { gateway: PaymentGatewayKey.PAYPAL }, ctx);
    expect((await raw(order.id))!.consent.status).toBe(ConsentStatus.NOT_REQUESTED);

    // Before: the Stripe confirmation page forwarded to the new PayPal link.
    const oldView = await getPublicConsentView(stripeRequest.token, { brandName: "Brand" });
    expect(oldView.paymentUrl).toBeNull();

    const paypalRequest = await ask(order.id, "GATEWAY");
    const view = await confirm(paypalRequest.token);
    expect(view.paymentUrl).toMatch(/PAYPAL-STUB-/);
    expect(
      await PaymentConsent.countDocuments({ orderId: order.id, status: ConsentStatus.VERIFIED }),
    ).toBe(2);
  });
});

describe("while a payment is held, nothing asks the customer to pay again", () => {
  async function heldOrder() {
    const { order, stripeSession } = await stripeThenPayPal(500);
    await processGatewayEvent(
      completedWebhook({
        orderId: order.id,
        orderNumber: order.orderNumber,
        sessionId: stripeSession,
        amount: 500,
      }),
    );
    return { order, stripeSession };
  }

  it("refuses a new link, a switch and a new request", async () => {
    const { order } = await heldOrder();
    await expect(regeneratePaymentLink(order.id, ctx)).rejects.toThrow(/Reconcile it first/);
    await expect(
      switchOrderGateway(order.id, { gateway: PaymentGatewayKey.STRIPE }, ctx),
    ).rejects.toThrow(/Reconcile it first/);
  });

  it("lets the operator record the held payment even though the switch retired the confirmation", async () => {
    const { order } = await createOrder(validCreateOrderInput({ charges: lines(500) }), ctx);
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    const stripeSession = (await raw(order.id))!.payment.stripeSessionId!;
    await confirm((await ask(order.id, "GATEWAY")).token);
    await switchOrderGateway(order.id, { gateway: PaymentGatewayKey.PAYPAL }, ctx);
    await processGatewayEvent(
      completedWebhook({
        orderId: order.id,
        orderNumber: order.orderNumber,
        sessionId: stripeSession,
        amount: 500,
      }),
    );
    const paid = await recordManualPayment(
      order.id,
      { method: "Stripe (earlier link)", reference: "cs-held-accepted", heldPaymentReviewed: true },
      ctx,
    );
    expect(paid.status).toBe(OrderStatus.PAID);
    // Dealt with: re-flagging the order later does not bring it back.
    await setOrderRiskFlag(order.id, { flagged: true, note: "other reason" }, ctx);
    const { outstandingHeldPayments } = await import("@/lib/payment-state");
    expect(outstandingHeldPayments((await raw(order.id)) as never)).toHaveLength(0);
  });

  it("clearing the flag after a refund allows collecting again", async () => {
    const { order } = await heldOrder();
    await setOrderRiskFlag(order.id, { flagged: false }, ctx);
    await regeneratePaymentLink(order.id, ctx);
    expect((await raw(order.id))!.payment.checkoutUrl).toBeTruthy();
  });

  it("records one held payment when a session reports success twice", async () => {
    const { order, stripeSession } = await stripeThenPayPal(500);
    const first = completedWebhook({
      orderId: order.id,
      orderNumber: order.orderNumber,
      sessionId: stripeSession,
      amount: 500,
    });
    await processGatewayEvent(first);
    await processGatewayEvent({ ...first, eventId: `${first.eventId}-async` });
    const held = (await raw(order.id))!.payment.attempts.filter((a) => a.held);
    expect(held).toHaveLength(1);
  });
});

describe("consent requests keep to their own way of paying", () => {
  it("a manual request does not reuse an unanswered gateway request", async () => {
    const { order } = await createOrder(validCreateOrderInput({ charges: lines(500) }), ctx);
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    const gateway = await ask(order.id, "GATEWAY");
    const manual = await ask(order.id, "MANUAL");
    expect(manual.consent.id).not.toBe(gateway.consent.id);
    // The earlier gateway email's link cannot confirm the manual request.
    await expect(confirm(gateway.token)).rejects.toThrow(/updated/i);
  });

  it("a new gateway link retires a manual confirmation", async () => {
    const { order } = await createOrder(validCreateOrderInput({ charges: lines(500) }), ctx);
    await confirm((await ask(order.id, "MANUAL")).token);
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    const now = (await raw(order.id))!;
    expect(now.consent.status).toBe(ConsentStatus.NOT_REQUESTED);
  });
});

describe("a second capture after settlement", () => {
  it("is flagged, not ignored as a duplicate", async () => {
    const { order, paypalSession } = await stripeThenPayPal(500);
    await processGatewayEvent(paypalEvent("checkout.completed", order, paypalSession, 500));
    expect((await raw(order.id))!.status).toBe(OrderStatus.PAID);
    const again = await processGatewayEvent(
      paypalEvent("checkout.completed", order, paypalSession, 500),
    );
    expect(again.reason).toBe("competing_payment:already-settled");
    const after = (await raw(order.id))!;
    expect(after.risk?.flagged).toBe(true);
    // The session that paid is still the order's session, not a stood-down
    // one — and the extra money is recorded as what it is.
    const extra = after.payment.attempts.filter((a) => a.held);
    expect(extra).toHaveLength(1);
    expect(extra[0].supersededAt).toBeNull();
    expect((extra[0] as { heldKind?: string }).heldKind).toBe("already-settled");
    // A third capture is flagged the same way, not as a stood-down link.
    const third = await processGatewayEvent(
      paypalEvent("checkout.completed", order, paypalSession, 500),
    );
    expect(third.reason).toBe("competing_payment:already-settled");
  });
});

describe("a PayPal approval after the order was settled another way", () => {
  it("is matched to its order and not captured", async () => {
    const { order, paypalSession } = await stripeThenPayPal(500);
    await confirm((await ask(order.id, "MANUAL")).token);
    await recordManualPayment(
      order.id,
      { method: "Card terminal", reference: "AUTH-SETTLED-1" },
      ctx,
    );
    // The order no longer points at the PayPal checkout, and the approval
    // carries no order id.
    const decision = await shouldCaptureApprovedOrder(
      {
        eventId: "WH-late-approval",
        type: "unhandled",
        sessionId: paypalSession,
        orderId: null,
        paymentIntentId: null,
        amountTotalMinor: null,
        occurredAtMs: Date.now(),
        raw: {},
      },
      null,
    );
    expect(decision).toMatchObject({
      capture: false,
      reason: "order_already_paid",
      orderId: order.id,
    });
  });
});
