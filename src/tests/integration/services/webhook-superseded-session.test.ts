import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

import {
  AuditAction,
  EmailKind,
  OrderEvidenceEventType,
  OrderStatus,
  PaymentGatewayKey,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import {
  AuditLog,
  Order,
  OrderEvidence,
  Organization,
  OrganizationMember,
  PendingEmail,
} from "@/server/db/models";
import { orgCookieName } from "@/server/auth/org-cookie";
import {
  createOrder,
  initiatePayment,
  reconcileOrderPayment,
  regeneratePaymentLink,
} from "@/server/services/order.service";
import { createProvider } from "@/server/services/provider.service";
import { processGatewayEvent } from "@/server/services/webhook.service";
import { createSettings } from "@/tests/factories/settings.factory";
import {
  roundTripFlightInput,
  validCreateOrderInput,
} from "@/tests/fixtures/order-input.fixture";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";
import type { OrderDTO } from "@/types";

/**
 * A regenerated Stripe link must not be killed by the session it replaced.
 *
 * `payment.stripeSessionId` is the order's authoritative session: payment
 * initiation pins it, and regenerating a link REPLACES it, then cancels the
 * previous session at Stripe. Stripe announces that old session's expiry —
 * and the event still finds the order, through the order id in its
 * metadata. Only an expiry of the CURRENT session may expire the order; a
 * superseded session's expiry is history. Payments keep their existing
 * rule: money Stripe reports as collected on any of the order's sessions
 * settles the order exactly once.
 */

const actor = actorFor(UserRole.ADMIN);
const ENV: Record<string, string> = {
  ORG_SESSIONCO_STRIPE_SECRET_KEY: "sk_test_sessionco_only",
  ORG_SESSIONCO_STRIPE_WEBHOOK_SECRET: "whsec_sessionco_only",
};

let orgId: Types.ObjectId;
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
let eventSeq = 0;

async function actingAsOperator() {
  sessionMock?.restore();
  sessionMock = await mockSession(actor);
  setNextHeaders({ cookies: { [orgCookieName()]: String(orgId) } });
}

/** A gateway webhook delivery: no session, no organization cookie. */
function asWebhookDelivery() {
  sessionMock?.restore();
  sessionMock = null;
  setNextHeaders({});
}

type Service = "car" | "flight";

async function linkedOrder(service: Service = "car"): Promise<OrderDTO> {
  await actingAsOperator();
  const input =
    service === "flight"
      ? roundTripFlightInput({ provider: "AIRINDIA" })
      : validCreateOrderInput();
  const { order } = await createOrder(input, { actor });
  const { order: linked } = await initiatePayment(order.id, { actor });
  return linked;
}

async function regenerate(order: OrderDTO): Promise<OrderDTO> {
  await actingAsOperator();
  const { order: next } = await regeneratePaymentLink(order.id, { actor });
  return next;
}

function deliver(
  type: "checkout.expired" | "checkout.completed",
  order: OrderDTO,
  sessionId: string,
  paymentIntentId: string | null = null,
) {
  asWebhookDelivery();
  eventSeq += 1;
  return processGatewayEvent(
    {
      eventId: `evt_session_${eventSeq}`,
      type,
      sessionId,
      orderId: order.id,
      paymentIntentId,
      amountTotalMinor:
        type === "checkout.completed"
          ? Math.round(order.pricing.amount * 100)
          : null,
      occurredAtMs: Date.now(),
      raw: {},
    },
    String(orgId),
  );
}

async function stored(order: OrderDTO) {
  return Order.findById(order.id).lean();
}

/**
 * The stub's `checkout.sessions`, so a test can deliver a webhook from inside
 * a regeneration's own gateway call. The stub is rebuilt for every test.
 */
function stripeSessions() {
  return getCurrentTestStripe().asStripe().checkout.sessions as unknown as {
    create: (...args: unknown[]) => Promise<unknown>;
    expire: (id: string, ...rest: unknown[]) => Promise<unknown>;
    retrieve: (id: string, ...rest: unknown[]) => Promise<unknown>;
  };
}

async function expiryRecords(order: OrderDTO) {
  const [audits, evidence] = await Promise.all([
    AuditLog.countDocuments({
      action: AuditAction.PAYMENT_EXPIRED,
      entityId: order.id,
    }),
    OrderEvidence.countDocuments({
      orderId: order.id,
      eventType: OrderEvidenceEventType.PAYMENT_EXPIRED,
    }),
  ]);
  return { audits, evidence };
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  Object.assign(process.env, ENV);
  const doc = await Organization.create({
    slug: "sessionco",
    name: "sessionco",
    brandName: "SessionCo",
    isDefault: false,
    payments: { provider: PaymentGatewayKey.STRIPE },
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT],
    email: { fromName: "SessionCo", fromEmail: "no-reply@sessionco.test" },
  });
  orgId = doc._id as Types.ObjectId;
  await OrganizationMember.create({
    organizationId: orgId,
    userId: new Types.ObjectId(actor.id),
    role: UserRole.ADMIN,
    status: RecordState.ACTIVE,
  });
  await actingAsOperator();
  await createProvider(
    {
      key: "AIRINDIA",
      name: "Air India",
      logo: "/providers/air-india.png",
      primaryColor: "#C8102E",
      onPrimaryColor: "#FFFFFF",
      tagline: "",
      sortOrder: 0,
      serviceTypes: [ServiceType.FLIGHT],
    } as Parameters<typeof createProvider>[0],
    { actor },
  );
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  for (const k of Object.keys(ENV)) delete process.env[k];
  setNextHeaders({});
});

describe("checkout session expiry against the order's current session", () => {
  it("Case 1 — the only session expires: the order expires, as before", async () => {
    const order = await linkedOrder();
    const sessionA = order.payment.paymentSessionId!;

    const result = await deliver("checkout.expired", order, sessionA);
    expect(result).toMatchObject({ handled: true, duplicate: false });

    const after = await stored(order);
    expect(after?.status).toBe(OrderStatus.EXPIRED);
    expect(after?.payment.status).toBe(OrderStatus.EXPIRED);
    expect(await expiryRecords(order)).toEqual({ audits: 1, evidence: 1 });
  });

  it.each(["car", "flight"] as const)(
    "Case 2 (%s) — the session a regeneration replaced expires: the order keeps its new link",
    async (service) => {
      const order = await linkedOrder(service);
      const sessionA = order.payment.paymentSessionId!;
      const regenerated = await regenerate(order);
      const sessionB = regenerated.payment.paymentSessionId!;
      expect(sessionB).not.toBe(sessionA);
      // Regeneration itself expired A at Stripe — which is what makes
      // Stripe send the expiry below.
      expect(getCurrentTestStripe().sessionsExpired).toContain(sessionA);

      const result = await deliver("checkout.expired", order, sessionA);
      expect(result).toMatchObject({
        handled: true,
        duplicate: false,
        reason: "superseded_session",
      });

      const after = await stored(order);
      expect(after?.status).toBe(OrderStatus.PAYMENT_PENDING);
      expect(after?.payment.status).toBe(OrderStatus.PAYMENT_PENDING);
      expect(after?.payment.stripeSessionId).toBe(sessionB);
      expect(after?.payment.checkoutUrl).toBe(regenerated.payment.paymentUrl);
      expect(await expiryRecords(order)).toEqual({ audits: 0, evidence: 0 });

      // Session A stays on record, attributed to the order's brand.
      const superseded = await AuditLog.findOne({
        action: AuditAction.PAYMENT_SESSION_SUPERSEDED,
        entityId: order.id,
      }).lean();
      expect(String(superseded?.organizationId)).toBe(String(orgId));
      expect(superseded?.metadata).toMatchObject({
        sessionId: sessionA,
        currentSessionId: sessionB,
        type: "checkout.expired",
      });

      // B is still the live link: paying it settles the order.
      const paid = await deliver(
        "checkout.completed",
        order,
        sessionB,
        regenerated.payment.paymentIntentId,
      );
      expect(paid).toMatchObject({ handled: true, duplicate: false });
      expect((await stored(order))?.status).toBe(OrderStatus.PAID);
    },
  );

  it("Case 3 — the newest session expires with no newer one: the order expires", async () => {
    const order = await linkedOrder();
    const regenerated = await regenerate(order);
    const sessionB = regenerated.payment.paymentSessionId!;

    const result = await deliver("checkout.expired", order, sessionB);
    expect(result).toMatchObject({ handled: true, duplicate: false });
    expect((await stored(order))?.status).toBe(OrderStatus.EXPIRED);
    expect(await expiryRecords(order)).toEqual({ audits: 1, evidence: 1 });
  });

  it("Case 4 — the replaced session is reported paid: the payment settles the order once, and later expiries change nothing", async () => {
    const order = await linkedOrder();
    const sessionA = order.payment.paymentSessionId!;
    const intentA = order.payment.paymentIntentId;
    const regenerated = await regenerate(order);
    const sessionB = regenerated.payment.paymentSessionId!;

    // The customer completed checkout on A before it was cancelled: Stripe
    // collected the money, so the order is paid — exactly once.
    const paid = await deliver("checkout.completed", order, sessionA, intentA);
    expect(paid).toMatchObject({ handled: true, duplicate: false });
    const afterPay = await stored(order);
    expect(afterPay?.status).toBe(OrderStatus.PAID);
    expect(await PendingEmail.countDocuments({ orderId: order.id })).toBe(1);
    expect(
      (await PendingEmail.findOne({ orderId: order.id }).lean())?.kind,
    ).toBe(EmailKind.PAYMENT_CONFIRMATION);

    // The same completion replayed, and both sessions' expiries, change nothing.
    const replay = await deliver("checkout.completed", order, sessionA, intentA);
    expect(replay.duplicate).toBe(true);
    await deliver("checkout.expired", order, sessionB);
    await deliver("checkout.expired", order, sessionA);
    const final = await stored(order);
    expect(final?.status).toBe(OrderStatus.PAID);
    expect(final?.payment.paidAt?.getTime()).toBe(afterPay?.payment.paidAt?.getTime());
    expect(await PendingEmail.countDocuments({ orderId: order.id })).toBe(1);
    expect(await expiryRecords(order)).toEqual({ audits: 0, evidence: 0 });
  });

  it("two regenerations — only the third (current) session's expiry expires the order", async () => {
    const order = await linkedOrder();
    const sessionA = order.payment.paymentSessionId!;
    const sessionB = (await regenerate(order)).payment.paymentSessionId!;
    const sessionC = (await regenerate(order)).payment.paymentSessionId!;

    await deliver("checkout.expired", order, sessionA);
    await deliver("checkout.expired", order, sessionB);
    const pending = await stored(order);
    expect(pending?.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(pending?.payment.stripeSessionId).toBe(sessionC);

    await deliver("checkout.expired", order, sessionC);
    expect((await stored(order))?.status).toBe(OrderStatus.EXPIRED);
  });
});

describe("a regeneration racing the gateway", () => {
  it("the replaced session's expiry notice, delivered while the regeneration is still running, cannot expire the order", async () => {
    const order = await linkedOrder();
    const sessionA = order.payment.paymentSessionId!;
    // Stripe announces a cancelled session at once, so that notice races the
    // regeneration that cancelled it. Delivered here before the cancel call
    // has even returned — the tightest the race can be.
    const sessions = stripeSessions();
    const expire = sessions.expire;
    let notice: Awaited<ReturnType<typeof deliver>> | undefined;
    sessions.expire = async (id, ...rest) => {
      if (id === sessionA) {
        notice = await deliver("checkout.expired", order, sessionA);
      }
      return expire(id, ...rest);
    };

    const regenerated = await regenerate(order);
    const sessionB = regenerated.payment.paymentSessionId!;

    expect(getCurrentTestStripe().sessionsExpired).toEqual([sessionA]);
    expect(notice).toMatchObject({
      handled: true,
      duplicate: false,
      reason: "superseded_session",
    });
    const after = await stored(order);
    expect(after?.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(after?.payment.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(after?.payment.stripeSessionId).toBe(sessionB);
    expect(after?.payment.checkoutUrl).toBe(regenerated.payment.paymentUrl);
    expect(await expiryRecords(order)).toEqual({ audits: 0, evidence: 0 });
  });

  it("a regeneration that commits between the expiry handler's read and its write keeps its link", async () => {
    const order = await linkedOrder();
    const sessionA = order.payment.paymentSessionId!;
    let regenerated: OrderDTO | undefined;
    // The handler has read the order — still on A — when an operator's
    // regeneration commits.
    const findById = Order.findById.bind(Order);
    const spy = vi.spyOn(Order, "findById").mockImplementationOnce(((
      id: string,
    ) => {
      const read = findById(id);
      return {
        then: (
          resolve: (value: unknown) => unknown,
          reject: (reason: unknown) => unknown,
        ) =>
          read
            .then(async (doc) => {
              regenerated = await regenerate(order);
              asWebhookDelivery();
              return doc;
            })
            .then(resolve, reject),
      };
    }) as unknown as typeof Order.findById);

    const result = await deliver("checkout.expired", order, sessionA);
    spy.mockRestore();

    expect(result).toMatchObject({ handled: true });
    const after = await stored(order);
    expect(after?.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(after?.payment.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(after?.payment.stripeSessionId).toBe(
      regenerated!.payment.paymentSessionId,
    );
    expect(await expiryRecords(order)).toEqual({ audits: 0, evidence: 0 });
  });

  it("a reconcile that asked about the old session while a regeneration committed cannot expire the new link", async () => {
    const order = await linkedOrder();
    const sessionA = order.payment.paymentSessionId!;
    let regenerated: OrderDTO | undefined;
    let raced = false;
    // The operator's reconcile has read the order — still on A — and is
    // asking Stripe about A when a regeneration commits and cancels A.
    const sessions = stripeSessions();
    const retrieve = sessions.retrieve;
    sessions.retrieve = async (id, ...rest) => {
      if (id === sessionA && !raced) {
        raced = true;
        regenerated = await regenerate(order);
        const cancelled = getCurrentTestStripe().sessionsCreated.find(
          (s) => s.result.id === sessionA,
        )!.result as unknown as { status: string };
        cancelled.status = "expired";
      }
      return retrieve(id, ...rest);
    };

    await actingAsOperator();
    const result = await reconcileOrderPayment(order.id, { actor });

    expect(result.stripeStatus).toBe("expired");
    expect(result.changed).toBe(false);
    expect(result.order.status).toBe(OrderStatus.PAYMENT_PENDING);
    const after = await stored(order);
    expect(after?.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(after?.payment.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(after?.payment.stripeSessionId).toBe(
      regenerated!.payment.paymentSessionId,
    );
  });

  it("a payment on the old session that lands mid-regeneration wins: the order stays paid on the session that took the money", async () => {
    const order = await linkedOrder();
    const sessionA = order.payment.paymentSessionId!;
    const intentA = order.payment.paymentIntentId;
    const linkAudits = () =>
      AuditLog.countDocuments({
        action: AuditAction.ORDER_PAYMENT_LINK_REGENERATED,
        entityId: order.id,
      });
    const linkAuditsBefore = await linkAudits();
    // The customer completes checkout on A while the new session is created.
    const sessions = stripeSessions();
    const create = sessions.create;
    sessions.create = async (...args) => {
      await deliver("checkout.completed", order, sessionA, intentA);
      return create(...args);
    };

    await expect(regenerate(order)).rejects.toThrow(
      /changed while its payment link was being regenerated/,
    );

    const after = await stored(order);
    expect(after?.status).toBe(OrderStatus.PAID);
    expect(after?.payment.status).toBe(OrderStatus.PAID);
    expect(after?.payment.stripeSessionId).toBe(sessionA);
    expect(after?.payment.paymentIntentId).toBe(intentA);
    expect(after?.payment.checkoutUrl).toBe(order.payment.paymentUrl);
    // A took the money: nothing is cancelled and no regeneration recorded.
    expect(getCurrentTestStripe().sessionsExpired).toEqual([]);
    expect(await linkAudits()).toBe(linkAuditsBefore);
    expect(await PendingEmail.countDocuments({ orderId: order.id })).toBe(1);
  });

  it("an old session the customer already paid, its webhook not yet landed, is settled — and no new link is issued", async () => {
    const order = await linkedOrder();
    const sessionA = order.payment.paymentSessionId!;
    const intentA = order.payment.paymentIntentId;
    // The customer completed checkout on A; Stripe's webhook is late.
    const stub = getCurrentTestStripe();
    const paidAtStripe = stub.sessionsCreated.find(
      (s) => s.result.id === sessionA,
    )!.result as unknown as { status: string; payment_status: string };
    paidAtStripe.status = "complete";
    paidAtStripe.payment_status = "paid";

    await expect(regenerate(order)).rejects.toThrow(
      /already completed checkout on the existing payment link/,
    );

    // No second session was ever created, and A was not touched.
    expect(stub.sessionsCreated).toHaveLength(1);
    expect(stub.sessionsExpired).toEqual([]);
    const after = await stored(order);
    expect(after?.status).toBe(OrderStatus.PAID);
    expect(after?.payment.stripeSessionId).toBe(sessionA);
    expect(after?.payment.paymentIntentId).toBe(intentA);
    expect(after?.payment.checkoutUrl).toBe(order.payment.paymentUrl);
    expect(await PendingEmail.countDocuments({ orderId: order.id })).toBe(1);

    // A's late webhook changes nothing.
    expect(
      (await deliver("checkout.completed", order, sessionA, intentA)).duplicate,
    ).toBe(true);
    const final = await stored(order);
    expect(final?.status).toBe(OrderStatus.PAID);
    expect(final?.payment.paidAt?.getTime()).toBe(
      after?.payment.paidAt?.getTime(),
    );
    expect(await PendingEmail.countDocuments({ orderId: order.id })).toBe(1);
    expect(
      await AuditLog.countDocuments({
        action: AuditAction.PAYMENT_SUCCEEDED,
        entityId: order.id,
      }),
    ).toBe(1);
  });

  it("a failed regeneration leaves the live link alone, and a retry still replaces it", async () => {
    const order = await linkedOrder();
    const sessionA = order.payment.paymentSessionId!;
    getCurrentTestStripe().failNextCreate({
      code: "api_connection_error",
      message: "Stripe unreachable",
    });

    await expect(regenerate(order)).rejects.toThrow(
      /Could not regenerate the payment link/,
    );
    const untouched = await stored(order);
    expect(untouched?.status).toBe(order.status);
    expect(untouched?.payment.stripeSessionId).toBe(sessionA);
    // A is still the customer's live link: nothing was cancelled.
    expect(getCurrentTestStripe().sessionsExpired).toEqual([]);

    const regenerated = await regenerate(order);
    const sessionB = regenerated.payment.paymentSessionId!;
    expect(sessionB).not.toBe(sessionA);
    expect(getCurrentTestStripe().sessionsExpired).toEqual([sessionA]);
    expect((await stored(order))?.payment.stripeSessionId).toBe(sessionB);
  });
});
