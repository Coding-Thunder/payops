import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuditAction, OrderStatus, PaymentGatewayKey, UserRole } from "@/lib/constants/enums";
import { AuditLog, Order } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { seedTestOrganization } from "@/tests/utils/organization";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";
import { modifyOrderSchema } from "@/lib/validation";

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

/**
 * The MCO flow moved from a small bespoke modal to the full order form, which
 * changed what a save can contain: the form always carries the whole charge
 * breakdown, the vehicle photo and the provider, where the modal sent a
 * hand-built diff of four text fields. These cover what that newly reaches.
 */
describe("MCO — charge breakdown, independent of the total", () => {
  const withCounterLine = (prepaid: number, counter: number, label: string) => [
    { name: "Rental cost", amount: prepaid, timing: "PREPAID" as const },
    { name: label, amount: counter, timing: "DUE_AT_COUNTER" as const },
  ];

  it("persists a due-at-counter edit that leaves the prepaid total alone", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: withCounterLine(500, 40, "Child seat") }),
      ctx(),
    );

    const r = await applyOrderModification(
      order.id,
      { charges: withCounterLine(500, 65, "Child seat + fuel") },
      ctx(),
    );

    expect(r.amountChanged).toBe(false);
    // Read it back from Mongo, not from the response: the response is built
    // from the in-memory document and reported this as applied even when the
    // save never happened.
    const raw = await Order.findById(order.id).lean<{
      charges: Array<{ name: string; amount: number; timing: string }>;
      pricing: { amount: number };
    }>();
    expect(raw!.charges).toHaveLength(2);
    expect(raw!.charges[1].name).toBe("Child seat + fuel");
    expect(raw!.charges[1].amount).toBe(65);
    expect(raw!.pricing.amount).toBe(500);
  });

  it("persists a split of the prepaid total into two lines", async () => {
    const order = await makeOrder(500);

    await applyOrderModification(
      order.id,
      {
        charges: [
          { name: "Rental cost", amount: 300, timing: "PREPAID" },
          { name: "Insurance", amount: 200, timing: "PREPAID" },
        ],
      },
      ctx(),
    );

    const raw = await Order.findById(order.id).lean<{
      charges: Array<{ name: string }>;
      pricing: { amount: number };
    }>();
    expect(raw!.charges.map((c) => c.name)).toEqual(["Rental cost", "Insurance"]);
    expect(raw!.pricing.amount).toBe(500);
  });

  it("audits a breakdown-only change", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: withCounterLine(500, 40, "Child seat") }),
      ctx(),
    );

    const r = await applyOrderModification(
      order.id,
      { charges: withCounterLine(500, 40, "Booster seat") },
      ctx(),
    );

    expect(r.changes.map((c) => c.field)).toContain("charges");
    const audit = await AuditLog.findOne({
      action: AuditAction.ORDER_UPDATED,
      entityId: order.id,
    }).lean<{ metadata: { amountChanged: boolean } }>();
    expect(audit).not.toBeNull();
    expect(audit!.metadata.amountChanged).toBe(false);
  });

  it("does not stand down a live payment link for a breakdown-only change", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: withCounterLine(500, 40, "Child seat") }),
      ctx(),
    );
    await withLiveSession(order.id);

    await applyOrderModification(
      order.id,
      { charges: withCounterLine(500, 40, "Booster seat") },
      ctx(),
    );

    // The customer may be part-way through this checkout. Renaming a
    // counter line is not a reason to kill it.
    const raw = await Order.findById(order.id).lean<{
      payment: {
        attempts: unknown[];
        priceRevision: number;
        checkoutUrl: string | null;
      };
    }>();
    expect(raw!.payment.attempts ?? []).toHaveLength(0);
    expect(raw!.payment.priceRevision ?? 0).toBe(0);
    expect(raw!.payment.checkoutUrl).toBe(
      "https://checkout.stripe.com/c/pay/cs_live",
    );
  });

  it("is still a no-op when the breakdown is identical", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: withCounterLine(500, 40, "Child seat") }),
      ctx(),
    );

    const r = await applyOrderModification(
      order.id,
      { charges: withCounterLine(500, 40, "Child seat") },
      ctx(),
    );

    expect(r.changes).toEqual([]);
    const audit = await AuditLog.countDocuments({
      action: AuditAction.ORDER_UPDATED,
      entityId: order.id,
    });
    expect(audit).toBe(0);
  });

  it("refuses a breakdown change on a paid order", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: withCounterLine(500, 40, "Child seat") }),
      ctx(),
    );
    await markPaid(order.id);

    // The amount guard only ever covered the TOTAL. Making the lines behind
    // it savable must not make a settled order's breakdown rewritable.
    await expect(
      applyOrderModification(
        order.id,
        { charges: withCounterLine(500, 40, "Renamed after settlement") },
        ctx(),
      ),
    ).rejects.toThrow(/already paid/i);
  });
});

describe("MCO — vehicle photo travels with the vehicle", () => {
  it("updates the photo alongside the make and model", async () => {
    const order = await makeOrder();

    const r = await applyOrderModification(
      order.id,
      {
        vehicle: {
          company: "BMW",
          type: "3 Series",
          imageUrl: "https://cdn.example.com/bmw-3.jpg",
        },
      },
      ctx(),
    );

    expect(r.order.vehicle.imageUrl).toBe("https://cdn.example.com/bmw-3.jpg");
    const raw = await Order.findById(order.id).lean<{
      vehicle: { company: string; imageUrl: string | null };
    }>();
    expect(raw!.vehicle.company).toBe("BMW");
    expect(raw!.vehicle.imageUrl).toBe("https://cdn.example.com/bmw-3.jpg");
  });

  it("leaves the photo alone when the vehicle group does not mention it", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({
        vehicle: {
          company: "Toyota",
          type: "Camry",
          imageUrl: "https://cdn.example.com/camry.jpg",
        },
      }),
      ctx(),
    );

    await applyOrderModification(
      order.id,
      { vehicle: { company: "Toyota", type: "Camry Hybrid" } },
      ctx(),
    );

    const raw = await Order.findById(order.id).lean<{
      vehicle: { imageUrl: string | null };
    }>();
    expect(raw!.vehicle.imageUrl).toBe("https://cdn.example.com/camry.jpg");
  });

  it("clears the photo on an empty string", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({
        vehicle: {
          company: "Toyota",
          type: "Camry",
          imageUrl: "https://cdn.example.com/camry.jpg",
        },
      }),
      ctx(),
    );

    // Through the route's own schema: that is the step that turns the form's
    // empty input into `null`. Calling the service with a raw "" skips it.
    const input = modifyOrderSchema.parse({ vehicle: { imageUrl: "" } });
    await applyOrderModification(order.id, input, ctx());

    const raw = await Order.findById(order.id).lean<{
      vehicle: { imageUrl: string | null };
    }>();
    expect(raw!.vehicle.imageUrl).toBeNull();
  });
});

describe("MCO — rental provider is branding, and re-snapshotted", () => {
  it("moves the order to another provider and re-snapshots it", async () => {
    const order = await makeOrder();
    expect(order.provider.id).toBe("BUDGET");

    const r = await applyOrderModification(
      order.id,
      { provider: "HERTZ" },
      ctx(),
    );

    expect(r.order.provider.id).toBe("HERTZ");
    // Name and logo come from the catalog, not from the request.
    expect(r.order.provider.name).toMatch(/hertz/i);
    expect(r.changes.map((c) => c.field)).toContain("provider");
  });

  it("does not touch payment state", async () => {
    const order = await makeOrder();
    await withLiveSession(order.id);

    const r = await applyOrderModification(
      order.id,
      { provider: "HERTZ" },
      ctx(),
    );

    // The gateway resolves from the ORGANIZATION, never from this field, so
    // re-branding an order must leave the money machinery untouched.
    expect(r.amountChanged).toBe(false);
    const raw = await Order.findById(order.id).lean<{
      payment: {
        attempts: unknown[];
        priceRevision: number;
        checkoutUrl: string | null;
        gateway: string | null;
      };
    }>();
    expect(raw!.payment.attempts ?? []).toHaveLength(0);
    expect(raw!.payment.priceRevision ?? 0).toBe(0);
    expect(raw!.payment.gateway).toBe(PaymentGatewayKey.STRIPE);
    expect(raw!.payment.checkoutUrl).toBe(
      "https://checkout.stripe.com/c/pay/cs_live",
    );
  });

  it("refuses an unknown provider key", async () => {
    const order = await makeOrder();
    await expect(
      applyOrderModification(order.id, { provider: "NOT_A_BRAND" }, ctx()),
    ).rejects.toThrow(/unknown rental provider/i);
  });

  it("refuses a provider change once the order is paid", async () => {
    const order = await makeOrder();
    await markPaid(order.id);

    // The snapshot on a paid order is what the customer saw on their
    // receipt, and that receipt is dispute evidence.
    await expect(
      applyOrderModification(order.id, { provider: "HERTZ" }, ctx()),
    ).rejects.toThrow(/already paid/i);
  });

  it("is a no-op when the provider is resubmitted unchanged", async () => {
    const order = await makeOrder();
    const r = await applyOrderModification(
      order.id,
      { provider: "BUDGET", customer: { name: "Ada Lovelace" } },
      ctx(),
    );
    expect(r.changes).toEqual([]);
  });
});
