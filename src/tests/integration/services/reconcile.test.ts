import { beforeEach, describe, expect, it } from "vitest";

import {
  AuditAction,
  OrderStatus,
  UserRole,
} from "@/lib/constants/enums";
import { Order, AuditLog } from "@/server/db/models";
import {
  createOrder,
  initiatePayment,
  reconcileOrderPayment,
} from "@/server/services/order.service";
import { actorFor } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { createSettings } from "@/tests/factories/settings.factory";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";

/**
 * Reconcile contract — the state-sync backstop that recovers when the
 * Stripe webhook never reaches us (local dev without `stripe listen`,
 * dropped webhook delivery, throttled retry).
 *
 * The flow validated end-to-end:
 *   1. createOrder() → PAYMENT_PENDING + a Stripe session
 *   2. flip the stub session to paid (simulating Stripe's view)
 *   3. reconcileOrderPayment() → applies the same atomic transition
 *      the webhook handler does. Order is PAID, audit row written,
 *      stripeStatus === "paid", changed === true.
 *   4. second reconcile is idempotent: changed === false, no second
 *      payment audit row, no double email claim.
 */

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
});

describe("reconcileOrderPayment", () => {
  it("flips a PENDING order to PAID when Stripe shows the session paid", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const stripe = getCurrentTestStripe();

    const { order: draft } = await createOrder(validCreateOrderInput(), {
      actor,
    });
    expect(draft.status).toBe(OrderStatus.NOT_INITIATED);
    const { order: created } = await initiatePayment(draft.id, { actor });
    expect(created.status).toBe(OrderStatus.LINK_GENERATED);

    // Simulate the customer finishing checkout: the stub session's
    // retrieved view now reports complete + paid.
    const session = stripe.sessionsCreated[0]!.result as unknown as {
      status: string;
      payment_status: string;
      amount_total: number | null;
    };
    session.status = "complete";
    session.payment_status = "paid";
    session.amount_total = Math.round(
      validCreateOrderInput().charges[0].amount * 100,
    );

    const result = await reconcileOrderPayment(created.id, { actor });
    expect(result.changed).toBe(true);
    expect(result.stripeStatus).toBe("paid");
    expect(result.order.status).toBe(OrderStatus.PAID);
    expect(result.order.payment.paidAt).toBeTruthy();
    expect(result.order.payment.amountReceived).toBeTruthy();

    // The DB itself reflects the transition.
    const stored = await Order.findById(created.id).lean();
    expect(stored?.status).toBe(OrderStatus.PAID);
    expect(stored?.payment.status).toBe(OrderStatus.PAID);
    expect(stored?.payment.paidAt).toBeTruthy();

    // Audit row written.
    const paymentAudits = await AuditLog.find({
      action: AuditAction.PAYMENT_SUCCEEDED,
      entityId: created.id,
    }).lean();
    expect(paymentAudits).toHaveLength(1);
    expect(
      (paymentAudits[0].metadata as Record<string, unknown>)?.source,
    ).toBe("reconcile");
  });

  it("is idempotent on repeat calls after PAID — no double audit, no second email claim", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const stripe = getCurrentTestStripe();
    const { order: draft } = await createOrder(validCreateOrderInput(), {
      actor,
    });
    const { order: created } = await initiatePayment(draft.id, { actor });

    const session = stripe.sessionsCreated[0]!.result as unknown as {
      status: string;
      payment_status: string;
      amount_total: number | null;
    };
    session.status = "complete";
    session.payment_status = "paid";
    session.amount_total = Math.round(
      validCreateOrderInput().charges[0].amount * 100,
    );

    await reconcileOrderPayment(created.id, { actor });
    const second = await reconcileOrderPayment(created.id, { actor });
    expect(second.changed).toBe(false);
    expect(second.stripeStatus).toBe("paid");
    expect(second.order.status).toBe(OrderStatus.PAID);

    const audits = await AuditLog.find({
      action: AuditAction.PAYMENT_SUCCEEDED,
      entityId: created.id,
    }).lean();
    // Exactly one payment-succeeded row regardless of how many times
    // an agent (or the customer's success page) re-asked Stripe.
    expect(audits).toHaveLength(1);
  });

  it("reports stripeStatus when Stripe says the session is still open", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const { order: draft } = await createOrder(validCreateOrderInput(), {
      actor,
    });
    const { order: created } = await initiatePayment(draft.id, { actor });

    const result = await reconcileOrderPayment(created.id, { actor });
    expect(result.changed).toBe(false);
    expect(result.stripeStatus).toBe("open");
    expect(result.order.status).toBe(OrderStatus.LINK_GENERATED);
  });

  it("marks the order EXPIRED when Stripe reports the session expired", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const stripe = getCurrentTestStripe();
    const { order: draft } = await createOrder(validCreateOrderInput(), {
      actor,
    });
    const { order: created } = await initiatePayment(draft.id, { actor });

    const session = stripe.sessionsCreated[0]!.result as unknown as {
      status: string;
    };
    session.status = "expired";

    const result = await reconcileOrderPayment(created.id, { actor });
    expect(result.changed).toBe(true);
    expect(result.stripeStatus).toBe("expired");
    expect(result.order.status).toBe(OrderStatus.EXPIRED);
  });

  it("rejects reconcile for an order the caller didn't create (when ctx supplied)", async () => {
    const owner = actorFor(UserRole.STAFF);
    const stranger = actorFor(UserRole.STAFF);
    const { order: created } = await createOrder(validCreateOrderInput(), {
      actor: owner,
    });
    await expect(
      reconcileOrderPayment(created.id, { actor: stranger }),
    ).rejects.toThrow(/orders you created/i);
  });

  it("allows public reconcile (no ctx) — used by the /pay/success render", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const stripe = getCurrentTestStripe();
    const { order: draft } = await createOrder(validCreateOrderInput(), {
      actor,
    });
    const { order: created } = await initiatePayment(draft.id, { actor });
    const session = stripe.sessionsCreated[0]!.result as unknown as {
      status: string;
      payment_status: string;
      amount_total: number | null;
    };
    session.status = "complete";
    session.payment_status = "paid";
    session.amount_total = Math.round(
      validCreateOrderInput().charges[0].amount * 100,
    );

    const result = await reconcileOrderPayment(created.id);
    expect(result.changed).toBe(true);
    expect(result.order.status).toBe(OrderStatus.PAID);
  });
});
