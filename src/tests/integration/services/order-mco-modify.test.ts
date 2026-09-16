import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuditAction, OrderStatus, PaymentGatewayKey, UserRole } from "@/lib/constants/enums";
import { AuditLog, Order } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { seedTestOrganization } from "@/tests/utils/organization";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * MCO — a customer rings up and asks for a change to a booking that already
 * exists. The order is amended IN PLACE.
 *
 * The rule that shapes every test here: lifecycle gating is per FIELD, not
 * per order. A blanket "NOT_INITIATED only" gate would defeat the
 * requirement, because the archetypal MCO — "extend my return date" —
 * happens mid-rental, after the money has moved. So descriptive fields stay
 * editable for the life of the booking, while the amount is refused once the
 * order is PAID, since this codebase has no refund or incremental-capture
 * path to reconcile a difference.
 */

const { createOrder, applyOrderModification, getOrderById } = await import(
  "@/server/services/order.service"
);

const admin = actorFor(UserRole.ADMIN);
const staff = actorFor(UserRole.STAFF);
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

const ctx = (actor = admin) => ({ actor, request: null });
const lines = (prepaid: number) => [
  { name: "Rental cost", amount: prepaid, timing: "PREPAID" as const },
];

async function makeOrder(prepaid = 500) {
  const { order } = await createOrder(
    validCreateOrderInput({ charges: lines(prepaid) }),
    ctx(),
  );
  return order;
}

async function withLiveSession(orderId: string) {
  await Order.updateOne(
    { _id: orderId },
    {
      $set: {
        status: OrderStatus.PAYMENT_PENDING,
        "payment.status": OrderStatus.PAYMENT_PENDING,
        "payment.gateway": PaymentGatewayKey.STRIPE,
        "payment.stripeSessionId": "cs_live",
        "payment.checkoutUrl": "https://checkout.stripe.com/c/pay/cs_live",
        "payment.initiatedAt": new Date(),
      },
    },
  );
}

async function markPaid(orderId: string) {
  await Order.updateOne(
    { _id: orderId },
    {
      $set: {
        status: OrderStatus.PAID,
        "payment.status": OrderStatus.PAID,
        "payment.amountReceived": 500,
        "payment.paidAt": new Date(),
      },
    },
  );
}

describe("MCO — individual field changes", () => {
  it("changes the customer name", async () => {
    const order = await makeOrder();
    const r = await applyOrderModification(
      order.id,
      { customer: { name: "Grace Hopper" } },
      ctx(),
    );
    expect(r.order.customer.name).toBe("Grace Hopper");
    expect(r.changes).toContainEqual({
      field: "customer.name",
      from: "Ada Lovelace",
      to: "Grace Hopper",
    });
  });

  it("changes the customer email", async () => {
    const order = await makeOrder();
    const r = await applyOrderModification(
      order.id,
      { customer: { email: "grace@payops.test" } },
      ctx(),
    );
    expect(r.order.customer.email).toBe("grace@payops.test");
  });

  it("changes the customer phone", async () => {
    const order = await makeOrder();
    const r = await applyOrderModification(
      order.id,
      { customer: { phone: "+15555550199" } },
      ctx(),
    );
    expect(r.order.customer.phone).toBe("+15555550199");
  });

  it("changes the vehicle", async () => {
    const order = await makeOrder();
    const r = await applyOrderModification(
      order.id,
      { vehicle: { company: "BMW", type: "X3" } },
      ctx(),
    );
    expect(r.order.vehicle.company).toBe("BMW");
    expect(r.order.vehicle.type).toBe("X3");
  });

  it("changes the pick-up date and time", async () => {
    const order = await makeOrder();
    const next = new Date(Date.now() + 36 * 3600_000).toISOString();
    const r = await applyOrderModification(
      order.id,
      { trip: { pickupDate: next } },
      ctx(),
    );
    expect(new Date(r.order.trip.pickupDate).toISOString()).toBe(
      new Date(next).toISOString(),
    );
  });

  it("changes the drop-off date and time — the archetypal MCO", async () => {
    const order = await makeOrder();
    const next = new Date(Date.now() + 5 * 24 * 3600_000).toISOString();
    const r = await applyOrderModification(
      order.id,
      { trip: { dropoffDate: next } },
      ctx(),
    );
    expect(new Date(r.order.trip.dropoffDate).toISOString()).toBe(
      new Date(next).toISOString(),
    );
  });

  it("changes pick-up and drop-off locations", async () => {
    const order = await makeOrder();
    const r = await applyOrderModification(
      order.id,
      {
        trip: {
          pickupLocation: "MCO Airport — Terminal B",
          dropoffLocation: "Tampa Downtown",
        },
      },
      ctx(),
    );
    expect(r.order.trip.pickupLocation).toBe("MCO Airport — Terminal B");
    expect(r.order.trip.dropoffLocation).toBe("Tampa Downtown");
  });

  it("changes several fields in one call", async () => {
    const order = await makeOrder();
    const r = await applyOrderModification(
      order.id,
      {
        customer: { name: "Grace Hopper", email: "grace@payops.test" },
        vehicle: { company: "BMW", type: "X3" },
      },
      ctx(),
    );
    expect(r.changes.map((c) => c.field).sort()).toEqual([
      "customer.email",
      "customer.name",
      "vehicle.company",
      "vehicle.type",
    ]);
  });
});

describe("MCO — same order, always", () => {
  it("keeps the same order id and order number", async () => {
    const order = await makeOrder();
    const r = await applyOrderModification(
      order.id,
      { vehicle: { company: "BMW", type: "X3" } },
      ctx(),
    );
    expect(r.order.id).toBe(order.id);
    expect(r.order.orderNumber).toBe(order.orderNumber);
  });

  it("does not increase the number of orders", async () => {
    const order = await makeOrder();
    const before = await Order.countDocuments({});
    await applyOrderModification(
      order.id,
      { customer: { name: "Grace Hopper" }, vehicle: { company: "BMW", type: "X3" } },
      ctx(),
    );
    expect(await Order.countDocuments({})).toBe(before);
  });
});

describe("MCO — lifecycle is per field, not per order", () => {
  it("allows descriptive edits on an ONGOING (paid) order", async () => {
    // "Please change my return date from the 20th to the 22nd" — the
    // customer already has the car and the money has already moved.
    const order = await makeOrder();
    await markPaid(order.id);
    const next = new Date(Date.now() + 9 * 24 * 3600_000).toISOString();

    const r = await applyOrderModification(
      order.id,
      { trip: { dropoffDate: next }, vehicle: { company: "BMW", type: "X3" } },
      ctx(),
    );

    expect(new Date(r.order.trip.dropoffDate).toISOString()).toBe(
      new Date(next).toISOString(),
    );
    expect(r.order.vehicle.company).toBe("BMW");
  });

  it("allows descriptive edits after a payment link exists", async () => {
    const order = await makeOrder();
    await withLiveSession(order.id);

    const r = await applyOrderModification(
      order.id,
      { customer: { name: "Grace Hopper" } },
      ctx(),
    );

    expect(r.order.customer.name).toBe("Grace Hopper");
    // A name change does not re-price, so the live link stands.
    const raw = await Order.findById(order.id).lean<{
      payment: { checkoutUrl: string | null; priceRevision: number };
    }>();
    expect(raw!.payment.checkoutUrl).toBeTruthy();
    expect(raw!.payment.priceRevision ?? 0).toBe(0);
  });

  it("refuses an AMOUNT change on a paid order", async () => {
    const order = await makeOrder();
    await markPaid(order.id);

    await expect(
      applyOrderModification(order.id, { charges: lines(650) }, ctx()),
    ).rejects.toThrow(/already paid/i);
  });

  it("never rewrites a settled transaction", async () => {
    const order = await makeOrder();
    await markPaid(order.id);

    await expect(
      applyOrderModification(order.id, { charges: lines(650) }, ctx()),
    ).rejects.toThrow();

    const raw = await Order.findById(order.id).lean<{
      pricing: { amount: number };
      payment: { amountReceived: number };
    }>();
    expect(raw!.payment.amountReceived).toBe(500);
    expect(raw!.pricing.amount).toBe(500);
  });
});

describe("MCO — amount impact", () => {
  it("leaves payment state alone when the amount does not change", async () => {
    const order = await makeOrder();
    await withLiveSession(order.id);

    const r = await applyOrderModification(
      order.id,
      { customer: { email: "grace@payops.test" } },
      ctx(),
    );

    expect(r.amountChanged).toBe(false);
    const raw = await Order.findById(order.id).lean<{
      status: string;
      payment: { checkoutUrl: string | null; attempts: unknown[] };
    }>();
    expect(raw!.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(raw!.payment.attempts ?? []).toHaveLength(0);
  });

  it("applies the re-price rules when a vehicle change moves the price", async () => {
    const order = await makeOrder();
    await withLiveSession(order.id);

    const r = await applyOrderModification(
      order.id,
      { vehicle: { company: "BMW", type: "X3" }, charges: lines(650) },
      ctx(),
    );

    expect(r.amountChanged).toBe(true);
    expect(r.order.pricing.amount).toBe(650);

    const raw = await Order.findById(order.id).lean<{
      payment: {
        attempts: Array<{ amount: number; supersededReason: string }>;
        priceRevision: number;
        checkoutUrl: string | null;
      };
    }>();
    // The stale link is recorded with the amount it was for, and stood down.
    expect(raw!.payment.attempts).toHaveLength(1);
    expect(raw!.payment.attempts[0].amount).toBe(500);
    expect(raw!.payment.attempts[0].supersededReason).toBe("REPRICED");
    expect(raw!.payment.priceRevision).toBe(1);
    expect(raw!.payment.checkoutUrl).toBeNull();
  });

  it("preserves payment history across the change", async () => {
    const order = await makeOrder();
    await withLiveSession(order.id);
    await applyOrderModification(order.id, { charges: lines(650) }, ctx());
    await applyOrderModification(order.id, { charges: lines(700) }, ctx());

    const raw = await Order.findById(order.id).lean<{
      payment: { attempts: unknown[]; priceRevision: number };
    }>();
    // History is append-only: the first supersede is still there.
    expect(raw!.payment.attempts.length).toBeGreaterThanOrEqual(1);
    expect(raw!.payment.priceRevision).toBe(2);
  });
});

describe("MCO — audit, authorization and validation", () => {
  it("writes an audit row naming the real operator and every change", async () => {
    const order = await makeOrder();
    await applyOrderModification(
      order.id,
      {
        vehicle: { company: "BMW", type: "X3" },
        reason: "Customer requested a larger car",
      },
      ctx(),
    );

    const rows = await AuditLog.find({
      entityId: String(order.id),
      action: AuditAction.ORDER_UPDATED,
    }).lean<Array<{ metadata: Record<string, unknown>; actor: { userId: string } }>>();
    const mco = rows.find((r) => r.metadata?.action === "mco_modified");
    expect(mco).toBeTruthy();
    expect(String(mco!.actor.userId)).toBe(admin.id);
    expect(mco!.metadata.reason).toBe("Customer requested a larger car");
    expect(mco!.metadata.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "vehicle.company", from: "Toyota", to: "BMW" }),
      ]),
    );
  });

  it("records whether the amount moved", async () => {
    const order = await makeOrder();
    await applyOrderModification(order.id, { charges: lines(650) }, ctx());

    const rows = await AuditLog.find({ entityId: String(order.id) }).lean<
      Array<{ metadata: Record<string, unknown> }>
    >();
    const mco = rows.find((r) => r.metadata?.action === "mco_modified");
    expect(mco!.metadata.amountChanged).toBe(true);
  });

  it("rejects an unauthorized operator", async () => {
    const order = await makeOrder();
    await expect(
      applyOrderModification(order.id, { customer: { name: "X Y" } }, ctx(staff)),
    ).rejects.toThrow();
  });

  it("rejects a drop-off that would precede pick-up", async () => {
    const order = await makeOrder();
    const earlier = new Date(Date.now() - 48 * 3600_000).toISOString();
    await expect(
      applyOrderModification(order.id, { trip: { dropoffDate: earlier } }, ctx()),
    ).rejects.toThrow(/after pick-up/i);
  });

  it("rejects a breakdown with nothing to collect online", async () => {
    const order = await makeOrder();
    await expect(
      applyOrderModification(
        order.id,
        { charges: [{ name: "Counter", amount: 90, timing: "DUE_AT_COUNTER" }] },
        ctx(),
      ),
    ).rejects.toThrow(/prepaid/i);
  });

  it("is a no-op when nothing actually differs", async () => {
    const order = await makeOrder();
    const r = await applyOrderModification(
      order.id,
      { customer: { name: "Ada Lovelace" } },
      ctx(),
    );
    expect(r.changes).toHaveLength(0);
    expect(r.amountChanged).toBe(false);
  });

  it("leaves the order readable and intact afterwards", async () => {
    const order = await makeOrder();
    await applyOrderModification(
      order.id,
      { vehicle: { company: "BMW", type: "X3" } },
      ctx(),
    );
    const fetched = await getOrderById(order.id, ctx());
    expect(fetched.id).toBe(order.id);
    expect(fetched.vehicle.company).toBe("BMW");
    expect(fetched.pricing.amount).toBe(500);
  });
});
