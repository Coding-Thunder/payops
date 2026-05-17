import { beforeEach, describe, expect, it } from "vitest";

import {
  AuditAction,
  OrderStatus,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PaymentError,
  ValidationError,
} from "@/lib/errors";
import { AuditLog, Order } from "@/server/db/models";
import {
  archiveOrder,
  createOrder,
  getOrderById,
  listOrders,
  regeneratePaymentLink,
} from "@/server/services/order.service";
import { actorFor } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { createOrder as factoryCreateOrder } from "@/tests/factories/order.factory";
import { createSettings } from "@/tests/factories/settings.factory";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";

/**
 * Order service — full integration. Stripe is stubbed by the per-test
 * integration setup so calls are observable and offline.
 */

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
});

describe("createOrder", () => {
  it("persists an order, asks Stripe for a session, and snapshots the policy", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const stripe = getCurrentTestStripe();

    const result = await createOrder(validCreateOrderInput(), { actor });

    expect(result.order.id).toMatch(/^[a-f0-9]{24}$/);
    expect(result.order.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(result.checkoutUrl).toMatch(/^http/);

    // Persisted state
    const stored = await Order.findById(result.order.id).lean();
    expect(stored?.payment.stripeSessionId).toMatch(/^cs_test_stub_/);
    expect(stored?.payment.checkoutUrl).toBe(result.checkoutUrl);
    expect(stored?.policy.text.length).toBeGreaterThan(20);
    expect(stored?.policy.version).toBe("v1");

    // Stripe was actually called with the expected payload
    expect(stripe.sessionsCreated).toHaveLength(1);
    const call = stripe.sessionsCreated[0];
    expect(call.params.mode).toBe("payment");
    expect(call.params.customer_email).toBe("ada@payops.test");
    expect(call.params.line_items?.[0].price_data?.unit_amount).toBe(24999);
    expect(call.params.metadata?.orderId).toBe(result.order.id);
    expect(call.options?.idempotencyKey).toMatch(/^order:.*:checkout$/);
  });

  it("emits an ORDER_CREATED audit row tagged with the actor", async () => {
    const actor = actorFor(UserRole.STAFF, { name: "Sara Staff" });
    const { order } = await createOrder(validCreateOrderInput(), { actor });
    const audit = await AuditLog.findOne({
      action: AuditAction.ORDER_CREATED,
      entityId: order.id,
    });
    expect(audit).not.toBeNull();
    expect(audit?.actor.userId?.toString()).toBe(actor.id);
    expect(audit?.metadata).toMatchObject({ orderNumber: order.orderNumber });
  });

  it("rejects a booking type not in the active settings", async () => {
    await createSettings({ allowedBookingTypes: ["NEW_BOOKING"] });
    await expect(
      createOrder(validCreateOrderInput({ bookingType: "MODIFICATION" }), {
        actor: actorFor(UserRole.ADMIN),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("marks the order FAILED and throws PaymentError if Stripe rejects", async () => {
    const stripe = getCurrentTestStripe();
    stripe.failNextCreate({ code: "card_error", message: "Boom" });

    await expect(
      createOrder(validCreateOrderInput(), {
        actor: actorFor(UserRole.ADMIN),
      }),
    ).rejects.toBeInstanceOf(PaymentError);

    const failed = await Order.findOne({
      status: OrderStatus.FAILED,
    }).lean();
    expect(failed).not.toBeNull();
    expect(failed?.payment.failureReason).toMatch(/Boom/);
  });

  it("rejects amounts below Stripe's 50-cent floor", async () => {
    // The Mongoose model's `min: 0.5` validator fires first and surfaces
    // a generic error before the Stripe boundary is reached. Either way
    // the order is not created — assert on that strong invariant.
    await expect(
      createOrder(
        validCreateOrderInput({ pricing: { amount: 0.4, currency: "USD" } }),
        { actor: actorFor(UserRole.ADMIN) },
      ),
    ).rejects.toThrow();

    // No PENDING/PAID order should have been created for that amount.
    const stranded = await Order.findOne({ "pricing.amount": 0.4 });
    expect(stranded).toBeNull();
  });
});

describe("listOrders RBAC", () => {
  it("STAFF sees only their own orders", async () => {
    const me = actorFor(UserRole.STAFF);
    const other = actorFor(UserRole.STAFF);

    await factoryCreateOrder({ createdBy: { userId: me.id, name: me.name } });
    await factoryCreateOrder({
      createdBy: { userId: other.id, name: other.name },
    });

    const mine = await listOrders(
      { state: RecordState.ACTIVE, page: 1, pageSize: 50 },
      { actor: me },
    );
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0].createdBy.userId).toBe(me.id);
  });

  it("ADMIN sees everyone's orders by default", async () => {
    const admin = actorFor(UserRole.ADMIN);
    const a = actorFor(UserRole.STAFF);
    const b = actorFor(UserRole.STAFF);
    await factoryCreateOrder({ createdBy: { userId: a.id, name: a.name } });
    await factoryCreateOrder({ createdBy: { userId: b.id, name: b.name } });

    const list = await listOrders(
      { state: RecordState.ACTIVE, page: 1, pageSize: 50 },
      { actor: admin },
    );
    expect(list.items.length).toBeGreaterThanOrEqual(2);
  });

  it("ADMIN can scope to their own with mine=true", async () => {
    const admin = actorFor(UserRole.ADMIN);
    const someone = actorFor(UserRole.STAFF);
    await factoryCreateOrder({
      createdBy: { userId: admin.id, name: admin.name },
    });
    await factoryCreateOrder({
      createdBy: { userId: someone.id, name: someone.name },
    });

    const list = await listOrders(
      { state: RecordState.ACTIVE, page: 1, pageSize: 50, mine: true },
      { actor: admin },
    );
    expect(list.items.every((o) => o.createdBy.userId === admin.id)).toBe(true);
  });
});

describe("getOrderById", () => {
  it("returns 404 for a non-existent id", async () => {
    await expect(
      getOrderById("507f1f77bcf86cd799439011", {
        actor: actorFor(UserRole.ADMIN),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("returns 404 for an invalid id string", async () => {
    await expect(
      getOrderById("not-a-mongo-id", { actor: actorFor(UserRole.ADMIN) }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("blocks STAFF from reading another staffer's order", async () => {
    const owner = actorFor(UserRole.STAFF);
    const intruder = actorFor(UserRole.STAFF);
    const order = await factoryCreateOrder({
      createdBy: { userId: owner.id, name: owner.name },
    });
    await expect(
      getOrderById(String(order._id), { actor: intruder }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("archiveOrder", () => {
  it("archives a pending order and marks payment EXPIRED", async () => {
    const admin = actorFor(UserRole.ADMIN);
    const order = await factoryCreateOrder({});
    const result = await archiveOrder(
      String(order._id),
      { reason: "test" },
      { actor: admin },
    );
    expect(result.state).toBe(RecordState.ARCHIVED);
    expect(result.status).toBe(OrderStatus.EXPIRED);

    const audit = await AuditLog.findOne({
      action: AuditAction.ORDER_ARCHIVED,
      entityId: String(order._id),
    });
    expect(audit).not.toBeNull();
  });

  it("refuses to archive a paid order", async () => {
    const admin = actorFor(UserRole.ADMIN);
    const order = await factoryCreateOrder({
      status: OrderStatus.PAID,
      payment: {
        status: OrderStatus.PAID,
        paidAt: new Date(),
        amountReceived: 199,
        processedWebhookEventIds: [],
      },
    });
    await expect(
      archiveOrder(String(order._id), {}, { actor: admin }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses to archive twice", async () => {
    const admin = actorFor(UserRole.ADMIN);
    const order = await factoryCreateOrder({});
    await archiveOrder(String(order._id), {}, { actor: admin });
    await expect(
      archiveOrder(String(order._id), {}, { actor: admin }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("regeneratePaymentLink", () => {
  it("issues a new Stripe session and replaces the old session id", async () => {
    const admin = actorFor(UserRole.ADMIN);
    const order = await factoryCreateOrder({
      payment: {
        status: OrderStatus.PAYMENT_PENDING,
        stripeSessionId: "cs_test_old",
        checkoutUrl: "https://old",
        processedWebhookEventIds: [],
      },
    });

    const result = await regeneratePaymentLink(String(order._id), {
      actor: admin,
    });

    expect(result.checkoutUrl).not.toBe("https://old");
    const stripe = getCurrentTestStripe();
    expect(stripe.sessionsExpired).toContain("cs_test_old");

    const reloaded = await Order.findById(order._id);
    expect(reloaded?.payment.stripeSessionId).toMatch(/^cs_test_stub_/);
  });

  it("refuses to regenerate a paid order", async () => {
    const admin = actorFor(UserRole.ADMIN);
    const order = await factoryCreateOrder({
      status: OrderStatus.PAID,
      payment: {
        status: OrderStatus.PAID,
        paidAt: new Date(),
        amountReceived: 199,
        processedWebhookEventIds: [],
      },
    });
    await expect(
      regeneratePaymentLink(String(order._id), { actor: admin }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
