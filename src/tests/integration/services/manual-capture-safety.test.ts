import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import type Stripe from "stripe";

import {
  AuditAction,
  BookingStatus,
  CaptureMode,
  EmailKind,
  OrderStatus,
  PaymentCaptureStatus,
  PaymentGatewayKey,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import { PaymentError } from "@/lib/errors";
import {
  AuditLog,
  Order,
  Organization,
  OrganizationMember,
  PendingEmail,
} from "@/server/db/models";
import { orgCookieName } from "@/server/auth/org-cookie";
import { getDefaultGateway } from "@/server/payments/gateways";
import {
  createOrder,
  initiatePayment,
  regeneratePaymentLink,
} from "@/server/services/order.service";
import {
  cancelAuthorization,
  capturePayment,
} from "@/server/services/payment-capture.service";
import { processGatewayEvent } from "@/server/services/webhook.service";
import { createSettings } from "@/tests/factories/settings.factory";
import {
  buildAmountCapturableUpdated,
  buildCheckoutCompleted,
  buildCheckoutExpired,
  buildPaymentIntentCanceled,
  buildPaymentIntentFailed,
  buildPaymentIntentSucceeded,
  signWebhook,
} from "@/tests/factories/stripe-event.factory";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";

/**
 * Manual capture under the conditions that break naive implementations —
 * on Rental Confirmation, the DEFAULT organization, switched to MANUAL the
 * way `scripts/set-organization-capture-mode.ts` does it, its Stripe events
 * arriving at the deployment endpoint (`processGatewayEvent(…, null)`).
 *
 *  - Stripe's payment_intent.canceled for an operator's release processed
 *    BEFORE the app records the release;
 *  - Stripe's own cancellation reasons (the hold lapsed) vs. a person's;
 *  - a capture the app recorded as failed that Stripe in fact performed;
 *  - a decline reported after the capture already landed;
 *  - the organization switched back to AUTOMATIC, then a link regenerated;
 *  - a second hold on the same order.
 */

const admin = actorFor(UserRole.ADMIN, { name: "Admin User" });
const DEPLOYMENT_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
let rental: Types.ObjectId;

/** Rental Confirmation as production stores it, then switched to MANUAL
 *  with the script's narrow write. */
async function makeRental(): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: "rentalconfirmation",
    name: "Rental Confirmation",
    brandName: "Rental Confirmation",
    isDefault: true,
    payments: {
      provider: PaymentGatewayKey.STRIPE,
      enabledProviders: [PaymentGatewayKey.STRIPE],
    },
  });
  const id = doc._id as Types.ObjectId;
  await Organization.collection.updateOne(
    { _id: id },
    { $unset: { serviceTypes: "", legal: "", "payments.captureMode": "" } },
  );
  await setRentalMode(CaptureMode.MANUAL);
  await OrganizationMember.create({
    organizationId: id,
    userId: new Types.ObjectId(admin.id),
    role: admin.role,
    status: RecordState.ACTIVE,
  });
  return id;
}

async function setRentalMode(mode: CaptureMode) {
  await Organization.collection.updateOne(
    { slug: "rentalconfirmation" },
    { $set: { "payments.captureMode": mode } },
  );
}

/** A Stripe event as the deployment endpoint receives it: signed with the
 *  deployment secret, verified by the deployment gateway, processed with no
 *  endpoint organization. */
async function deliver(event: Stripe.Event) {
  const payload = JSON.stringify(event);
  const headers = new Headers({
    "stripe-signature": signWebhook(payload, DEPLOYMENT_WEBHOOK_SECRET),
  });
  const verified = await getDefaultGateway().verifyWebhook(payload, headers);
  return processGatewayEvent(verified, null);
}

async function reload(orderId: string) {
  const doc = await Order.findById(orderId).lean();
  if (!doc) throw new Error(`Order ${orderId} vanished`);
  return doc;
}

async function linkedOrder() {
  setNextHeaders({ cookies: { [orgCookieName()]: String(rental) } });
  const { order } = await createOrder(validCreateOrderInput(), { actor: admin });
  const { order: initiated } = await initiatePayment(order.id, { actor: admin });
  return initiated;
}

async function authorize(orderId: string) {
  const doc = await reload(orderId);
  await deliver(
    buildAmountCapturableUpdated({
      paymentIntentId: doc.payment.paymentIntentId!,
      orderId,
      orderNumber: doc.orderNumber,
      amountCapturable: Math.round(doc.pricing.amount * 100),
    }),
  );
  const after = await reload(orderId);
  expect(after.payment.capture?.status).toBe(PaymentCaptureStatus.AUTHORIZED);
  return after;
}

const emails = (orderId: string, kind: EmailKind) =>
  PendingEmail.countDocuments({ orderId: new Types.ObjectId(orderId), kind });

const releasedAudits = (orderId: string) =>
  AuditLog.find({ entityId: orderId, action: AuditAction.AUTHORIZATION_RELEASED }).lean();

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sessionMock = await mockSession(admin);
  rental = await makeRental();
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  setNextHeaders({});
});

describe("Stripe reports an operator's release BEFORE the app records it", () => {
  it("the order ends CANCELLED with the operator's typed reason and the operator's AUTHORIZATION_RELEASED audit — never 'expired'", async () => {
    const linked = await linkedOrder();
    const held = await authorize(linked.id);
    const pi = held.payment.paymentIntentId!;

    // Stripe's payment_intent.canceled for this very release is processed
    // while the release request is still in flight — between Stripe's answer
    // and the service's own write.
    const intents = getCurrentTestStripe().asStripe().paymentIntents;
    const realCancel = intents.cancel.bind(intents) as (...args: unknown[]) => Promise<unknown>;
    let webhookFirst: Awaited<ReturnType<typeof deliver>> | null = null;
    vi.spyOn(intents, "cancel").mockImplementationOnce((async (...args: unknown[]) => {
      const answer = await realCancel(...args);
      webhookFirst = await deliver(
        buildPaymentIntentCanceled({
          paymentIntentId: pi,
          orderId: linked.id,
          orderNumber: linked.orderNumber,
          cancellationReason: "abandoned",
        }),
      );
      return answer;
    }) as never);

    await cancelAuthorization(linked.id, { actor: admin }, { reason: "Supplier could not confirm" });

    // The webhook really did get there first, and recorded a release.
    expect(webhookFirst).toMatchObject({ handled: true, duplicate: false });

    const doc = await reload(linked.id);
    expect(doc.payment.capture?.status).toBe(PaymentCaptureStatus.CANCELLED);
    expect(doc.payment.capture?.cancelReason).toBe("Supplier could not confirm");
    expect(doc.bookingStatus).toBe(BookingStatus.CANCELLED);
    expect(doc.status).toBe(OrderStatus.LINK_GENERATED);

    const audits = await releasedAudits(linked.id);
    const byOperator = audits.filter(
      (a) => (a.metadata as Record<string, unknown> | undefined)?.releasedBy === "operator",
    );
    expect(byOperator).toHaveLength(1);
    expect(String(byOperator[0]!.actor?.userId)).toBe(admin.id);
    // Nothing anywhere says the hold lapsed on its own.
    expect(
      audits.some((a) => (a.metadata as Record<string, unknown> | undefined)?.releasedBy === "gateway"),
    ).toBe(false);

    // Stripe was asked once, with the operator's reason and this hold's key.
    const cancels = getCurrentTestStripe().cancelsRequested;
    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toMatchObject({
      id: pi,
      params: { cancellation_reason: "abandoned" },
      options: { idempotencyKey: `order:${linked.id}:cancel:${pi}` },
    });
    expect(await emails(linked.id, EmailKind.PAYMENT_CONFIRMATION)).toBe(0);
  });
});

describe("payment_intent.canceled: Stripe's own reasons mean the hold lapsed; a person's mean it was released", () => {
  it.each([
    { reason: "automatic", status: PaymentCaptureStatus.AUTHORIZATION_EXPIRED },
    { reason: "expired", status: PaymentCaptureStatus.AUTHORIZATION_EXPIRED },
    { reason: "abandoned", status: PaymentCaptureStatus.CANCELLED },
    { reason: "requested_by_customer", status: PaymentCaptureStatus.CANCELLED },
    { reason: "duplicate", status: PaymentCaptureStatus.CANCELLED },
    { reason: "fraudulent", status: PaymentCaptureStatus.CANCELLED },
  ] as const)("cancellation_reason '$reason' → $status, booking CANCELLED, order status untouched, no email", async ({ reason, status }) => {
    const linked = await linkedOrder();
    const held = await authorize(linked.id);

    const outcome = await deliver(
      buildPaymentIntentCanceled({
        paymentIntentId: held.payment.paymentIntentId!,
        orderId: linked.id,
        orderNumber: linked.orderNumber,
        cancellationReason: reason,
      }),
    );
    expect(outcome).toMatchObject({ handled: true, duplicate: false });

    const doc = await reload(linked.id);
    expect(doc.payment.capture?.status).toBe(status);
    expect(doc.payment.capture?.cancelReason).toBe(reason);
    expect(doc.bookingStatus).toBe(BookingStatus.CANCELLED);
    expect(doc.status).toBe(OrderStatus.LINK_GENERATED);
    const audit = (await releasedAudits(linked.id))[0];
    expect((audit?.metadata as Record<string, unknown> | undefined)?.releasedBy).toBe(
      status === PaymentCaptureStatus.AUTHORIZATION_EXPIRED ? "gateway" : "operator_or_gateway",
    );
    expect(await emails(linked.id, EmailKind.PAYMENT_CONFIRMATION)).toBe(0);

    // Either way the money cannot be taken any more.
    await expect(capturePayment(linked.id, { actor: admin })).rejects.toThrow(
      `Cannot capture — the payment is ${status.toLowerCase()}.`,
    );
  });
});

describe("a capture the app recorded as FAILED that Stripe in fact performed", () => {
  it("payment_intent.succeeded repairs it: PAID, CAPTURED, booking CONFIRMED, one receipt — not PAID with a failed capture still showing", async () => {
    const linked = await linkedOrder();
    const held = await authorize(linked.id);
    const pi = held.payment.paymentIntentId!;

    getCurrentTestStripe().failNextCapture({
      code: "api_connection_error",
      message: "Request timed out",
    });
    await expect(capturePayment(linked.id, { actor: admin })).rejects.toBeInstanceOf(PaymentError);
    const failed = await reload(linked.id);
    expect(failed.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURE_FAILED);
    expect(failed.status).not.toBe(OrderStatus.PAID);

    const minor = Math.round(held.pricing.amount * 100);
    await deliver(
      buildPaymentIntentSucceeded({
        paymentIntentId: pi,
        orderId: linked.id,
        orderNumber: linked.orderNumber,
        amountReceived: minor,
      }),
    );

    const doc = await reload(linked.id);
    expect(doc.status).toBe(OrderStatus.PAID);
    expect(doc.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURED);
    expect(doc.payment.capture?.amountCaptured).toBe(held.pricing.amount);
    expect(doc.payment.capture?.lastError).toBeNull();
    expect(doc.bookingStatus).toBe(BookingStatus.CONFIRMED);
    expect(await emails(linked.id, EmailKind.PAYMENT_CONFIRMATION)).toBe(1);
  });
});

describe("a decline reported after the capture already landed", () => {
  it("payment_intent.payment_failed does not turn a just-CAPTURED hold back into CAPTURE_FAILED", async () => {
    const linked = await linkedOrder();
    const held = await authorize(linked.id);
    const pi = held.payment.paymentIntentId!;

    // The handler reads the order (still AUTHORIZED), then the operator's
    // capture lands before the handler's write.
    const realUpdateOne = Order.updateOne.bind(Order);
    let raced = false;
    vi.spyOn(Order, "updateOne").mockImplementation(((
      filter: Record<string, unknown>,
      update: { $set?: Record<string, unknown> },
      ...rest: unknown[]
    ) => {
      if (!raced && update?.$set?.["payment.capture.status"] === PaymentCaptureStatus.CAPTURE_FAILED) {
        raced = true;
        return Order.collection
          .updateOne(
            { _id: new Types.ObjectId(linked.id) },
            {
              $set: {
                status: OrderStatus.PAID,
                "payment.status": OrderStatus.PAID,
                "payment.capture.status": PaymentCaptureStatus.CAPTURED,
              },
            },
          )
          .then(() => (realUpdateOne as (...args: unknown[]) => unknown)(filter, update, ...rest));
      }
      return (realUpdateOne as (...args: unknown[]) => unknown)(filter, update, ...rest);
    }) as never);

    await deliver(buildPaymentIntentFailed({ paymentIntentId: pi, message: "Your card was declined." }));
    expect(raced).toBe(true);

    const doc = await reload(linked.id);
    expect(doc.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURED);
    expect(doc.payment.capture?.lastError ?? null).toBeNull();
  });
});

describe("the organization switched back to AUTOMATIC, then a link regenerated", () => {
  it("the new link charges at checkout AND the old manual record is cleared, so the paid checkout makes the order PAID — not a mere authorization", async () => {
    const linked = await linkedOrder();
    const first = await reload(linked.id);
    expect(first.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);

    // The link expires before the customer authorizes…
    await deliver(
      buildCheckoutExpired({
        sessionId: first.payment.stripeSessionId!,
        orderId: linked.id,
        orderNumber: linked.orderNumber,
      }),
    );
    expect((await reload(linked.id)).status).toBe(OrderStatus.EXPIRED);

    // …Rental is switched back to AUTOMATIC, and the link regenerated.
    await setRentalMode(CaptureMode.AUTOMATIC);
    await regeneratePaymentLink(linked.id, { actor: admin });
    const sessions = getCurrentTestStripe().sessionsCreated;
    const regenerated = sessions.at(-1)!;
    expect(regenerated.params.payment_intent_data).not.toHaveProperty("capture_method");
    expect(regenerated.manualCapture).toBe(false);

    const relinked = await reload(linked.id);
    expect(relinked.payment.capture ?? null).toBeNull();
    expect(relinked.bookingStatus ?? null).toBeNull();

    // The customer pays on the new link.
    await deliver(
      buildCheckoutCompleted({
        sessionId: relinked.payment.stripeSessionId!,
        paymentIntentId: relinked.payment.paymentIntentId ?? undefined,
        orderId: linked.id,
        orderNumber: linked.orderNumber,
        amountTotal: Math.round(relinked.pricing.amount * 100),
      }),
    );
    const paid = await reload(linked.id);
    expect(paid.status).toBe(OrderStatus.PAID);
    expect(paid.payment.capture ?? null).toBeNull();
    expect(await emails(linked.id, EmailKind.PAYMENT_CONFIRMATION)).toBe(1);
    expect(await emails(linked.id, EmailKind.PAYMENT_AUTHORIZED)).toBe(0);
  });
});

describe("a second hold on the same order", () => {
  it("is released and captured under its OWN Stripe keys (per hold), never the first hold's", async () => {
    const linked = await linkedOrder();
    const firstHold = await authorize(linked.id);
    const pi1 = firstHold.payment.paymentIntentId!;
    await cancelAuthorization(linked.id, { actor: admin }, { reason: "Customer changed dates" });

    await regeneratePaymentLink(linked.id, { actor: admin });
    const secondHold = await authorize(linked.id);
    const pi2 = secondHold.payment.paymentIntentId!;
    expect(pi2).not.toBe(pi1);

    await capturePayment(linked.id, { actor: admin });
    const stub = getCurrentTestStripe();
    expect(stub.cancelsRequested.map((c) => c.options?.idempotencyKey)).toEqual([
      `order:${linked.id}:cancel:${pi1}`,
    ]);
    expect(stub.capturesRequested.map((c) => [c.id, c.options?.idempotencyKey])).toEqual([
      [pi2, `order:${linked.id}:capture:${pi2}`],
    ]);
    const doc = await reload(linked.id);
    expect(doc.status).toBe(OrderStatus.PAID);
    expect(doc.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURED);
  });
});
