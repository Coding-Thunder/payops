import { beforeEach, describe, expect, it, vi } from "vitest";

import { OrderStatus, PaymentGatewayKey, UserRole } from "@/lib/constants/enums";
import { Order } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { seedTestOrganization } from "@/tests/utils/organization";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * Editing the payable ("MCO") amount on an order that already exists.
 *
 * The collectable amount is `pricing.amount`, which is the sum of the
 * PREPAID lines in `charges[]`. Editing the amount is therefore editing the
 * breakdown — there is no second field to keep in step.
 *
 * What makes this dangerous is not the arithmetic but the link already in
 * the customer's inbox. Three verified facts:
 *   - `failOrder` never expires the gateway session, and a Stripe decline
 *     happens inside a session that stays open, so a FAILED order routinely
 *     still holds a payable link;
 *   - `expireSession` cannot report success (Stripe swallows errors, PayPal
 *     has no cancel for an unapproved order);
 *   - `applyCheckoutPaid`'s guard is `status: { $ne: PAID }`, which the old
 *     session passes cleanly.
 * So the old link cannot be reliably killed. These tests pin the behaviour
 * that makes it *identifiable* instead.
 */

const { createOrder, repriceOrder, getOrderById } = await import(
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

const lines = (prepaid: number, counter = 0) => [
  { name: "Rental cost", amount: prepaid, timing: "PREPAID" as const },
  ...(counter > 0
    ? [{ name: "Due at counter", amount: counter, timing: "DUE_AT_COUNTER" as const }]
    : []),
];

/** Put an order in the state a sent-but-unpaid link leaves it in. */
async function withLiveSession(orderId: string, sessionId = "cs_old") {
  await Order.updateOne(
    { _id: orderId },
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
}

describe("repriceOrder — same order, new amount", () => {
  it("changes the payable amount and keeps the SAME order id", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx(),
    );
    expect(order.pricing.amount).toBe(500);

    const updated = await repriceOrder(order.id, { charges: lines(650) }, ctx());

    expect(updated.id).toBe(order.id);
    expect(updated.orderNumber).toBe(order.orderNumber);
    expect(updated.pricing.amount).toBe(650);
  });

  it("creates no second order", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx(),
    );
    const before = await Order.countDocuments({});

    await repriceOrder(order.id, { charges: lines(650) }, ctx());

    expect(await Order.countDocuments({})).toBe(before);
  });

  it("keeps pricing.amount equal to the PREPAID total, ignoring counter lines", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx(),
    );

    const updated = await repriceOrder(
      order.id,
      { charges: lines(650, 120) },
      ctx(),
    );

    // The counter line is shown to the customer but never charged online.
    expect(updated.pricing.amount).toBe(650);
    const raw = await Order.findById(order.id).lean<{ charges: unknown[] }>();
    expect(raw!.charges).toHaveLength(2);
  });
});

describe("repriceOrder — the stale link problem", () => {
  it("preserves the superseded attempt WITH the amount it was for", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx(),
    );
    await withLiveSession(order.id);

    await repriceOrder(order.id, { charges: lines(650) }, ctx());

    const raw = await Order.findById(order.id).lean<{
      payment: {
        attempts: Array<{
          sessionId: string;
          amount: number;
          supersededReason: string;
          supersededAt: Date;
        }>;
        priceRevision: number;
        checkoutUrl: string | null;
      };
    }>();

    expect(raw!.payment.attempts).toHaveLength(1);
    const [old] = raw!.payment.attempts;
    // The amount is the point: a late webhook on cs_old is for 500, not 650.
    expect(old.amount).toBe(500);
    expect(old.sessionId).toBe("cs_old");
    expect(old.supersededReason).toBe("REPRICED");
    expect(old.supersededAt).toBeTruthy();
  });

  it("bumps priceRevision so the next session cannot replay the old one", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx(),
    );
    await withLiveSession(order.id);

    await repriceOrder(order.id, { charges: lines(650) }, ctx());

    const raw = await Order.findById(order.id).lean<{
      payment: { priceRevision: number };
    }>();
    // Stripe's idempotency key is derived from the order id, which does not
    // change when the price does. Without this bump, asking for a new
    // session replays the original at the ORIGINAL amount.
    expect(raw!.payment.priceRevision).toBe(1);
  });

  it("drops the customer-facing checkout URL", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx(),
    );
    await withLiveSession(order.id);

    await repriceOrder(order.id, { charges: lines(650) }, ctx());

    const raw = await Order.findById(order.id).lean<{
      payment: { checkoutUrl: string | null; stripeSessionId: string | null };
    }>();
    // No surface may keep advertising a URL that collects the old amount...
    expect(raw!.payment.checkoutUrl).toBeNull();
    // ...but the session id is KEPT, so a late webhook or a dispute is still
    // routable to the attempt that produced it.
    expect(raw!.payment.stripeSessionId).toBe("cs_old");
  });

  it("does NOT reset status to NOT_INITIATED while an old link is in the wild", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx(),
    );
    await withLiveSession(order.id);

    await repriceOrder(order.id, { charges: lines(650) }, ctx());

    const raw = await Order.findById(order.id).lean<{ status: string }>();
    // NOT_INITIATED would re-open initiatePayment's filter and make the order
    // read as never-billed while a payable link still exists.
    expect(raw!.status).not.toBe(OrderStatus.NOT_INITIATED);
  });

  it("records no attempt when there was never a live session", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx(),
    );

    await repriceOrder(order.id, { charges: lines(650) }, ctx());

    const raw = await Order.findById(order.id).lean<{
      payment: { attempts: unknown[]; priceRevision: number };
    }>();
    expect(raw!.payment.attempts ?? []).toHaveLength(0);
    // Still bumped: the amount genuinely changed.
    expect(raw!.payment.priceRevision).toBe(1);
  });
});

describe("repriceOrder — refusals", () => {
  it("refuses to re-price a PAID order", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx(),
    );
    await Order.updateOne(
      { _id: order.id },
      { $set: { status: OrderStatus.PAID, "payment.status": OrderStatus.PAID } },
    );

    await expect(
      repriceOrder(order.id, { charges: lines(650) }, ctx()),
    ).rejects.toThrow(/already paid/i);
  });

  it("never rewrites a settled transaction's amount", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx(),
    );
    await Order.updateOne(
      { _id: order.id },
      {
        $set: {
          status: OrderStatus.PAID,
          "payment.status": OrderStatus.PAID,
          "payment.amountReceived": 500,
        },
      },
    );

    await expect(
      repriceOrder(order.id, { charges: lines(650) }, ctx()),
    ).rejects.toThrow();

    const raw = await Order.findById(order.id).lean<{
      pricing: { amount: number };
      payment: { amountReceived: number };
    }>();
    expect(raw!.payment.amountReceived).toBe(500);
    expect(raw!.pricing.amount).toBe(500);
  });

  it("refuses a breakdown with nothing to collect online", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx(),
    );

    await expect(
      repriceOrder(
        order.id,
        { charges: [{ name: "Counter only", amount: 90, timing: "DUE_AT_COUNTER" }] },
        ctx(),
      ),
    ).rejects.toThrow(/prepaid/i);
  });

  it("refuses a non-admin operator", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx(),
    );

    await expect(
      repriceOrder(order.id, { charges: lines(650) }, ctx(staff)),
    ).rejects.toThrow();
  });

  it("is a no-op for an unchanged breakdown — no revision burned", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx(),
    );
    await withLiveSession(order.id);

    await repriceOrder(order.id, { charges: lines(500) }, ctx());

    const raw = await Order.findById(order.id).lean<{
      payment: { priceRevision: number; checkoutUrl: string | null };
    }>();
    // A no-op must not supersede a session the customer may be mid-checkout on.
    expect(raw!.payment.priceRevision ?? 0).toBe(0);
    expect(raw!.payment.checkoutUrl).toBeTruthy();
  });
});
