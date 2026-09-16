import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OrderStatus, PaymentGatewayKey, UserRole } from "@/lib/constants/enums";
import { DomainEventType, type DomainEvent } from "@/lib/constants/events";
import { Order } from "@/server/db/models";
import { subscribeEvents } from "@/server/events/bus";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { seedTestOrganization } from "@/tests/utils/organization";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * Operator-QA follow-ups: an edited order tells other open screens, the
 * operator hears when a live link still shows old details, the order page
 * knows a request went out for manual collection, and a manual payment
 * reference seen on another paid order is flagged.
 */

const {
  createOrder,
  initiatePayment,
  applyOrderModification,
  recordManualPayment,
  getOrderById,
} = await import("@/server/services/order.service");
const { requestConsent, recordConsentFromToken } = await import(
  "@/server/services/consent.service"
);

const admin = actorFor(UserRole.ADMIN);
const ctx = { actor: admin, request: null };
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await seedTestOrganization();
  sessionMock = await mockSession(admin);
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
});

const STATEMENT =
  "I confirm that I understand and agree to proceed with this booking.";

async function newOrder(email = "ada@payops.test") {
  const base = validCreateOrderInput();
  const { order } = await createOrder(
    validCreateOrderInput({ customer: { ...base.customer, email } }),
    ctx,
  );
  return order;
}

async function ask(orderId: string, collection: "GATEWAY" | "MANUAL") {
  const o = await getOrderById(orderId, ctx);
  return requestConsent(
    {
      orderId,
      customerEmail: o.customer.email,
      customerName: o.customer.name,
      consentMessage: STATEMENT,
      consentEmailSubject: "Please confirm",
      collection,
      snapshot: {
        bookingType: o.bookingType,
        provider: o.provider.name,
        vehicle: `${o.vehicle.company} • ${o.vehicle.type}`,
        pickupDate: o.trip.pickupDate,
        dropoffDate: o.trip.dropoffDate,
        amount: o.pricing.amount,
        currency: o.pricing.currency,
        paymentLinkRef: o.payment.paymentUrl ?? null,
      },
    },
    { actor: admin, appUrl: "http://127.0.0.1:3100" },
  );
}

const confirm = (token: string) =>
  recordConsentFromToken(
    { token, acknowledgement: STATEMENT, signedName: "Ada Lovelace" },
    { branding: { brandName: "Test Brand" }, request: null },
  );

describe("an edit tells other open screens", () => {
  it("publishes order:updated with the order id", async () => {
    const order = await newOrder();
    const seen: DomainEvent[] = [];
    const stop = subscribeEvents((e) => seen.push(e));
    try {
      await applyOrderModification(
        order.id,
        { customer: { name: "Grace Hopper" } },
        ctx,
      );
    } finally {
      stop();
    }
    const updated = seen.filter((e) => e.type === DomainEventType.ORDER_UPDATED);
    expect(updated).toHaveLength(1);
    expect(updated[0].payload).toMatchObject({
      orderId: order.id,
      orderNumber: order.orderNumber,
    });
  });

  it("publishes nothing when nothing changed", async () => {
    const order = await newOrder();
    const seen: DomainEvent[] = [];
    const stop = subscribeEvents((e) => seen.push(e));
    try {
      await applyOrderModification(
        order.id,
        { customer: { name: order.customer.name } },
        ctx,
      );
    } finally {
      stop();
    }
    expect(seen.some((e) => e.type === DomainEventType.ORDER_UPDATED)).toBe(false);
  });
});

describe("a live link that still shows the old details", () => {
  it("is reported when the trip changes under an open link", async () => {
    const order = await newOrder();
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    const r = await applyOrderModification(
      order.id,
      { vehicle: { type: "Camry Hybrid" } },
      ctx,
    );
    expect(r.amountChanged).toBe(false);
    expect(r.checkoutDetailsChanged).toBe(true);
  });

  it("is not reported for a phone number, which the checkout never shows", async () => {
    const order = await newOrder();
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    const r = await applyOrderModification(
      order.id,
      { customer: { phone: "+15555550199" } },
      ctx,
    );
    expect(r.checkoutDetailsChanged).toBe(false);
  });

  it("is not reported when there is no link yet", async () => {
    const order = await newOrder();
    const r = await applyOrderModification(
      order.id,
      { vehicle: { type: "Camry Hybrid" } },
      ctx,
    );
    expect(r.checkoutDetailsChanged).toBe(false);
  });
});

describe("the order remembers how payment was requested", () => {
  it("records a manual request on the order", async () => {
    const order = await newOrder();
    expect((await getOrderById(order.id, ctx)).consent.collectionMethod).toBeNull();
    await ask(order.id, "MANUAL");
    expect((await getOrderById(order.id, ctx)).consent.collectionMethod).toBe("MANUAL");
  });

  it("follows the latest request, including after consent was given", async () => {
    const order = await newOrder();
    await confirm((await ask(order.id, "MANUAL")).token);
    await initiatePayment(order.id, ctx, { gateway: PaymentGatewayKey.STRIPE });
    await ask(order.id, "GATEWAY");
    expect((await getOrderById(order.id, ctx)).consent.collectionMethod).toBe("GATEWAY");
  });
});

describe("a manual payment reference already used on another order", () => {
  it("is recorded but flags the order for review", async () => {
    const first = await newOrder("first@payops.test");
    const second = await newOrder("second@payops.test");
    await confirm((await ask(first.id, "MANUAL")).token);
    await confirm((await ask(second.id, "MANUAL")).token);

    const same = { method: "Card terminal", reference: "AUTH-777001" };
    const a = await recordManualPayment(first.id, same, ctx);
    expect(a.risk.flagged).toBe(false);

    const b = await recordManualPayment(second.id, same, ctx);
    expect(b.status).toBe(OrderStatus.PAID);
    expect(b.risk.flagged).toBe(true);
    expect(b.risk.flaggedNote).toContain(first.orderNumber);
  });

  it("leaves a distinct reference alone", async () => {
    const first = await newOrder("first@payops.test");
    const second = await newOrder("second@payops.test");
    await confirm((await ask(first.id, "MANUAL")).token);
    await confirm((await ask(second.id, "MANUAL")).token);

    await recordManualPayment(first.id, { method: "Cash", reference: "RCPT-1" }, ctx);
    const b = await recordManualPayment(
      second.id,
      { method: "Cash", reference: "RCPT-2" },
      ctx,
    );
    expect(b.risk.flagged).toBe(false);
    const raw = await Order.findById(second.id).lean<{ risk?: { flagged?: boolean } }>();
    expect(raw!.risk?.flagged ?? false).toBe(false);
  });
});
