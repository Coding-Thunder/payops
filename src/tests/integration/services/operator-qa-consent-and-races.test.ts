import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuditAction,
  ConsentStatus,
  OrderStatus,
  PaymentGatewayKey,
  UserRole,
} from "@/lib/constants/enums";
import { AuditLog, Order } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import {
  seedTestOrganization,
  setEnabledProviders,
} from "@/tests/utils/organization";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";
import { completedWebhook } from "@/tests/fixtures/webhook.fixture";

/**
 * Regressions from the operator worst-case QA pass — consent, manual
 * collection, concurrent edits and races. Each failed before its fix.
 */

const {
  createOrder,
  initiatePayment,
  applyOrderModification,
  recordManualPayment,
  getOrderGatewayOptions,
  reconcileOrderPayment,
} = await import("@/server/services/order.service");
const { processStripeEvent } = await import("@/server/services/webhook.service");
const { requestConsent, recordConsentFromToken, getPublicConsentView } =
  await import("@/server/services/consent.service");

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
const good = { method: "Card terminal", reference: "AUTH-004521" };
const BRAND = { brandName: "Test Brand" };
const STATEMENT =
  "I confirm that I understand and agree to proceed with this booking.";

async function newOrder(amount = 500) {
  const { order } = await createOrder(
    validCreateOrderInput({ charges: lines(amount) }),
    ctx,
  );
  return order;
}

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
      consentMessage: STATEMENT,
      consentEmailSubject: "Please confirm",
      collection,
      snapshot: {
        bookingType: o.bookingType as never,
        provider: o.provider.name,
        vehicle: `${o.vehicle.company} • ${o.vehicle.type}`,
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
    { token, acknowledgement: STATEMENT, signedName: "Ada Lovelace" },
    { branding: BRAND, request: null },
  );

const raw = (id: string) =>
  Order.findById(id).lean<{
    status: string;
    consent: { status: string };
    payment: { amountReceived: number | null; checkoutUrl: string | null };
    customer: { name: string; email: string };
    updatedAt: Date;
  }>();

describe("consent covers the amount it was given for", () => {
  it("an amount change retires the customer's confirmation", async () => {
    const order = await newOrder(500);
    const req = await ask(order.id, "MANUAL");
    await confirm(req.token);
    expect((await raw(order.id))!.consent.status).toBe(ConsentStatus.VERIFIED);

    const r = await applyOrderModification(order.id, { charges: lines(650) }, ctx);
    expect(r.consentReset).toBe(true);
    expect((await raw(order.id))!.consent.status).toBe(
      ConsentStatus.NOT_REQUESTED,
    );
    // …so a manual payment at the new amount needs a fresh confirmation.
    await expect(recordManualPayment(order.id, good, ctx)).rejects.toThrow(
      /consent/i,
    );
  });

  it("a descriptive change keeps the confirmation", async () => {
    const order = await newOrder(500);
    await confirm((await ask(order.id, "MANUAL")).token);
    const r = await applyOrderModification(
      order.id,
      { customer: { phone: "+15555550199" } },
      ctx,
    );
    expect(r.consentReset).toBe(false);
    expect((await raw(order.id))!.consent.status).toBe(ConsentStatus.VERIFIED);
  });

  it("an old confirmation page no longer forwards to the new-amount checkout", async () => {
    const order = await newOrder(500);
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    const req = await ask(order.id, "GATEWAY");
    await confirm(req.token);

    await applyOrderModification(order.id, { charges: lines(650) }, ctx);
    const { regeneratePaymentLink } = await import(
      "@/server/services/order.service"
    );
    await regeneratePaymentLink(order.id, ctx);

    const view = await getPublicConsentView(req.token, BRAND);
    expect(view.outdated).toBe(true);
    expect(view.paymentUrl).toBeNull();
  });

  it("an outdated request cannot be confirmed", async () => {
    const order = await newOrder(500);
    const req = await ask(order.id, "GATEWAY");
    await applyOrderModification(order.id, { charges: lines(650) }, ctx);
    await expect(confirm(req.token)).rejects.toThrow(/updated/i);
  });

  it("a paid booking's request cannot be confirmed again", async () => {
    const order = await newOrder(500);
    const req = await ask(order.id, "MANUAL");
    await Order.updateOne(
      { _id: order.id },
      { $set: { status: OrderStatus.PAID, "payment.status": OrderStatus.PAID } },
    );
    await expect(confirm(req.token)).rejects.toThrow(/already been paid/i);
    expect((await getPublicConsentView(req.token, BRAND)).orderPaid).toBe(true);
  });
});

describe("a manual request never hands out a checkout link", () => {
  it("even when the order still holds a Stripe link", async () => {
    const order = await newOrder(500);
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    expect((await raw(order.id))!.payment.checkoutUrl).toBeTruthy();

    const req = await ask(order.id, "MANUAL");
    expect(req.consent.snapshot.paymentLinkRef).toBeNull();
    const after = await confirm(req.token);
    expect(after.collection).toBe("MANUAL");
    expect(after.paymentUrl).toBeNull();
  });

  it("nor does a gateway request whose link is dead", async () => {
    const order = await newOrder(500);
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    const req = await ask(order.id, "GATEWAY");
    await Order.updateOne(
      { _id: order.id },
      { $set: { status: OrderStatus.FAILED, "payment.status": OrderStatus.FAILED } },
    );
    const view = await getPublicConsentView(req.token, BRAND);
    expect(view.paymentUrl).toBeNull();
  });

  it("while a live gateway request still gets its link", async () => {
    const order = await newOrder(500);
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    const req = await ask(order.id, "GATEWAY");
    const view = await confirm(req.token);
    expect(view.paymentUrl).toBeTruthy();
  });
});

describe("edits made against a stale copy of the order are refused", () => {
  it("refuses an edit whose expected version is out of date", async () => {
    const order = await newOrder(500);
    const loaded = (await raw(order.id))!.updatedAt.toISOString();
    // A colleague changes the order first.
    await applyOrderModification(order.id, { charges: lines(700) }, ctx);

    await expect(
      applyOrderModification(
        order.id,
        { charges: lines(500), expectedUpdatedAt: loaded },
        ctx,
      ),
    ).rejects.toThrow(/changed after you opened it/i);
    const now = await Order.findById(order.id).lean<{ pricing: { amount: number } }>();
    expect(now!.pricing.amount).toBe(700);
  });

  it("accepts an edit made against the current version", async () => {
    const order = await newOrder(500);
    const loaded = (await raw(order.id))!.updatedAt.toISOString();
    const r = await applyOrderModification(
      order.id,
      { customer: { name: "Grace Hopper" }, expectedUpdatedAt: loaded },
      ctx,
    );
    expect(r.order.customer.name).toBe("Grace Hopper");
  });
});

describe("concurrent settlement never double-settles or un-pays", () => {
  it("manual recording racing a gateway success settles exactly once", async () => {
    for (let i = 0; i < 6; i++) {
      const order = await newOrder(500);
      await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
      await confirm((await ask(order.id, "GATEWAY")).token);
      const sessionId = (await Order.findById(order.id).lean<{
        payment: { stripeSessionId: string };
      }>())!.payment.stripeSessionId;

      await Promise.allSettled([
        recordManualPayment(order.id, good, ctx),
        processStripeEvent(
          completedWebhook({
            orderId: order.id,
            orderNumber: order.orderNumber,
            sessionId,
            amount: 500,
          }),
        ),
      ]);

      const now = await raw(order.id);
      expect(now!.status).toBe(OrderStatus.PAID);
      expect(
        await AuditLog.countDocuments({
          action: AuditAction.PAYMENT_SUCCEEDED,
          entityId: order.id,
        }),
      ).toBe(1);
    }
  });

  it("two simultaneous manual recordings leave the order PAID once", async () => {
    for (let i = 0; i < 6; i++) {
      const order = await newOrder(500);
      await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
      await confirm((await ask(order.id, "GATEWAY")).token);

      await Promise.allSettled([
        recordManualPayment(order.id, good, ctx),
        recordManualPayment(order.id, good, ctx),
      ]);

      const now = await raw(order.id);
      expect(now!.status).toBe(OrderStatus.PAID);
      expect(now!.payment.amountReceived).toBe(500);
    }
  });
});

describe("gateway choices and scope", () => {
  it("offers PayPal on 'Try another gateway' when the organization enables it", async () => {
    await setEnabledProviders([PaymentGatewayKey.STRIPE, PaymentGatewayKey.PAYPAL]);
    const order = await newOrder(500);
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    const opts = await getOrderGatewayOptions(order.id);
    expect(opts.options).toContain(PaymentGatewayKey.PAYPAL);
  });

  it("refuses to quietly return a Stripe link when PayPal was asked for", async () => {
    await setEnabledProviders([PaymentGatewayKey.STRIPE, PaymentGatewayKey.PAYPAL]);
    const order = await newOrder(500);
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    await expect(
      initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.PAYPAL }),
    ).rejects.toThrow(/Try another gateway/);
  });

  it("reconcile refuses an order outside the organization's scope", async () => {
    const order = await newOrder(500);
    await Order.updateOne(
      { _id: order.id },
      { $set: { organizationId: "6aaa00000000000000000999" } },
    );
    await expect(reconcileOrderPayment(order.id, ctx)).rejects.toThrow(/not found/i);
  });
});
