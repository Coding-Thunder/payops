import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import {
  AuditAction,
  OrderStatus,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { HOTEL_MIN_ONE_NIGHT } from "@/lib/validation/order";
import {
  AuditLog,
  Order,
  Organization,
  OrganizationMember,
} from "@/server/db/models";
import { orgCookieName } from "@/server/auth/org-cookie";
import {
  archiveOrder,
  createOrder,
  getOrderById,
  listOrders,
  regeneratePaymentLink,
} from "@/server/services/order.service";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";
import {
  buildOrder,
  createOrder as factoryCreateOrder,
} from "@/tests/factories/order.factory";
import { createSettings } from "@/tests/factories/settings.factory";
import {
  validCreateOrderInput,
  validHotelOrderInput,
} from "@/tests/fixtures/order-input.fixture";
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
  it("persists an order in NOT_INITIATED state without contacting Stripe", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const stripe = getCurrentTestStripe();

    const result = await createOrder(validCreateOrderInput(), { actor });

    expect(result.order.id).toMatch(/^[a-f0-9]{24}$/);
    expect(result.order.status).toBe(OrderStatus.NOT_INITIATED);
    expect(result.checkoutUrl).toBeNull();

    // Persisted state — no Stripe fields at all yet.
    const stored = await Order.findById(result.order.id).lean();
    expect(stored?.status).toBe(OrderStatus.NOT_INITIATED);
    expect(stored?.payment.status).toBe(OrderStatus.NOT_INITIATED);
    expect(stored?.payment.stripeSessionId ?? null).toBeNull();
    expect(stored?.payment.checkoutUrl ?? null).toBeNull();
    expect(stored?.payment.initiatedAt ?? null).toBeNull();
    expect(stored?.payment.expiresAt ?? null).toBeNull();
    expect(stored?.policy.text.length).toBeGreaterThan(20);
    expect(stored?.policy.version).toBe("v1");

    // Stripe was NOT called — the whole point of decoupling creation.
    expect(stripe.sessionsCreated).toHaveLength(0);
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

  it("rejects amounts below the model's 50-cent floor at creation", async () => {
    // Mongoose `min: 0.5` validator fires synchronously inside create().
    // Stripe is no longer involved here — order persistence simply
    // refuses to save.
    await expect(
      createOrder(
        validCreateOrderInput({
          charges: [{ name: "Rental cost", amount: 0.4, timing: "PREPAID" }],
        }),
        { actor: actorFor(UserRole.ADMIN) },
      ),
    ).rejects.toThrow();

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

/* ------------------------------------------------------------------ *
 * Hotel dates are CALENDAR DAYS — the order model's half
 *
 * A stay is at least one night by the calendar. The model enforces it on a
 * NEW order (the last line behind the schema); a stay stored before dates
 * were days — two clock times on one UTC day — must still save when a
 * webhook or the customer's acknowledgement touches it later.
 * ------------------------------------------------------------------ */

describe("hotel dates are calendar days", () => {
  const sameDay = {
    checkInDate: new Date("2026-10-17T09:00:00.000Z"),
    checkOutDate: new Date("2026-10-17T21:00:00.000Z"),
  };

  it("refuses a NEW zero-night stay even at a later clock time, written straight to the model", async () => {
    await expect(
      factoryCreateOrder({
        serviceType: ServiceType.HOTEL,
        hotel: { destination: "Paris", ...sameDay } as never,
      }),
    ).rejects.toThrow(HOTEL_MIN_ONE_NIGHT);
    expect(await Order.countDocuments({ serviceType: ServiceType.HOTEL })).toBe(0);
  });

  it("accepts a NEW one-night stay stored as two UTC midnights", async () => {
    const order = await factoryCreateOrder({
      serviceType: ServiceType.HOTEL,
      hotel: {
        destination: "Paris",
        checkInDate: new Date("2026-10-17"),
        checkOutDate: new Date("2026-10-18"),
      } as never,
    });
    expect(order.hotel!.checkInDate.toISOString()).toBe("2026-10-17T00:00:00.000Z");
  });

  it("still saves a zero-night stay stored before dates were days, when a later write touches it", async () => {
    const legacy = buildOrder({
      serviceType: ServiceType.HOTEL,
      hotel: { destination: "Paris", ...sameDay } as never,
    });
    await Order.collection.insertOne(legacy as never);

    const doc = await Order.findById(legacy._id);
    doc!.status = OrderStatus.PAID;
    doc!.payment.status = OrderStatus.PAID;
    await expect(doc!.save()).resolves.toBeTruthy();
  });

  it("keeps refusing a check-out before check-in on every save, as it always did", async () => {
    const order = await factoryCreateOrder({ serviceType: ServiceType.HOTEL });
    const doc = await Order.findById(order._id);
    doc!.hotel!.checkOutDate = new Date(doc!.hotel!.checkInDate.getTime() - 86_400_000);
    await expect(doc!.save()).rejects.toThrow("Check-out date must be after check-in date");
  });

  describe("through createOrder", () => {
    const actor = actorFor(UserRole.ADMIN);
    let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

    beforeEach(async () => {
      sessionMock = await mockSession(actor);
      const org = await Organization.create({
        slug: "staybrand",
        name: "staybrand",
        brandName: "Stay Brand",
        isDefault: false,
        serviceTypes: [ServiceType.HOTEL],
      });
      await OrganizationMember.create({
        organizationId: org._id,
        userId: new Types.ObjectId(actor.id),
        role: UserRole.ADMIN,
        status: RecordState.ACTIVE,
      });
      setNextHeaders({ cookies: { [orgCookieName()]: String(org._id) } });
    });

    afterEach(() => {
      sessionMock?.restore();
      sessionMock = null;
      setNextHeaders({});
    });

    it("stores the create form's date-only days as their UTC midnights", async () => {
      const base = validHotelOrderInput();
      const { order } = await createOrder(
        { ...base, hotel: { ...base.hotel, checkInDate: "2026-10-17", checkOutDate: "2026-10-20" } },
        { actor },
      );
      expect(order.hotel!.checkInDate).toBe("2026-10-17T00:00:00.000Z");
      expect(order.hotel!.checkOutDate).toBe("2026-10-20T00:00:00.000Z");
    });

    it("refuses — and stores nothing for — a zero-night stay that bypassed the schema", async () => {
      const base = validHotelOrderInput();
      await expect(
        createOrder(
          {
            ...base,
            hotel: {
              ...base.hotel,
              checkInDate: sameDay.checkInDate.toISOString(),
              checkOutDate: sameDay.checkOutDate.toISOString(),
            },
          },
          { actor },
        ),
      ).rejects.toThrow(HOTEL_MIN_ONE_NIGHT);
      expect(await Order.countDocuments({})).toBe(0);
    });
  });
});
