import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import type Stripe from "stripe";

import {
  BookingStatus,
  CaptureMode,
  EmailKind,
  OrderStatus,
  PaymentCaptureStatus,
  PaymentGatewayKey,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import { ConflictError, ForbiddenError } from "@/lib/errors";
import {
  Order,
  Organization,
  OrganizationMember,
  PendingEmail,
} from "@/server/db/models";
import { orgCookieName } from "@/server/auth/org-cookie";
import { getGatewayForOrganization } from "@/server/payments/resolve-gateway";
import { createOrder, initiatePayment } from "@/server/services/order.service";
import {
  cancelAuthorization,
  capturePayment,
} from "@/server/services/payment-capture.service";
import { processGatewayEvent } from "@/server/services/webhook.service";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";
import { createSettings } from "@/tests/factories/settings.factory";
import {
  buildAmountCapturableUpdated,
  buildCheckoutCompleted,
  buildPaymentIntentSucceeded,
  signWebhook,
} from "@/tests/factories/stripe-event.factory";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * Manual capture (authorize → capture), end to end at the service layer.
 *
 * THE INVARIANT THIS FILE EXISTS TO PIN: manual capture is a GlobeVista-only
 * behaviour. RentalConfirmation and TripReservations are automatic-capture
 * organizations, every order they have ever created carries
 * `payment.capture === null`, and none of the machinery below is reachable
 * for them. Where a shared code path exists, the assertion is that the
 * incumbent's side of it is BYTE-IDENTICAL — not merely equivalent. The
 * clearest example is requirement 13: the outgoing Stripe payload for a
 * RentalConfirmation checkout must not carry `capture_method` at all, not
 * even `capture_method: "automatic"`.
 *
 * Requirements covered here: 13, 14 (service level), 15, 16, 17, 18, plus
 * the RBAC on the two new money-moving operations.
 */

const admin = actorFor(UserRole.ADMIN, { name: "Admin User" });
const staff = actorFor(UserRole.STAFF, { name: "Staff User" });

const GV_SECRET_KEY = "sk_test_globevista_only";
const GV_WEBHOOK_SECRET = "whsec_globevista_only";
const DEPLOYMENT_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

const GV_ENV = {
  ORG_GLOBEVISTA_STRIPE_SECRET_KEY: GV_SECRET_KEY,
  ORG_GLOBEVISTA_STRIPE_WEBHOOK_SECRET: GV_WEBHOOK_SECRET,
};

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
let globevista: Types.ObjectId;
let rentalconfirmation: Types.ObjectId;

async function makeOrg(opts: {
  slug: string;
  brandName: string;
  isDefault: boolean;
  captureMode: CaptureMode;
  serviceTypes?: ServiceType[];
  email?: Record<string, unknown>;
}) {
  const doc = await Organization.create({
    slug: opts.slug,
    name: opts.slug,
    brandName: opts.brandName,
    isDefault: opts.isDefault,
    payments: {
      provider: PaymentGatewayKey.STRIPE,
      captureMode: opts.captureMode,
    },
    serviceTypes: opts.serviceTypes ?? [ServiceType.CAR_RENTAL],
    ...(opts.email ? { email: opts.email } : {}),
  });
  const id = doc._id as Types.ObjectId;
  // Both actors are members so the organization cookie resolves for either.
  for (const actor of [admin, staff]) {
    await OrganizationMember.create({
      organizationId: id,
      userId: new Types.ObjectId(actor.id),
      role: actor.role,
      status: RecordState.ACTIVE,
    });
  }
  return id;
}

function actingAs(orgId: Types.ObjectId) {
  setNextHeaders({ cookies: { [orgCookieName()]: String(orgId) } });
}

/** Create an order owned by `orgId` and generate its payment link. */
async function linkedOrder(orgId: Types.ObjectId) {
  actingAs(orgId);
  const { order } = await createOrder(validCreateOrderInput(), { actor: admin });
  const { order: initiated } = await initiatePayment(order.id, { actor: admin });
  return initiated;
}

/** The `checkout.sessions.create` params for the most recent call. */
function lastSessionParams(): Stripe.Checkout.SessionCreateParams {
  const stripe = getCurrentTestStripe();
  const last = stripe.sessionsCreated.at(-1);
  if (!last) throw new Error("No Stripe checkout session was created");
  return last.params;
}

/**
 * Push a raw Stripe event through the ORGANIZATION'S OWN gateway —
 * signature verification, adapter normalisation, then the shared webhook
 * service. Everything except the HTTP route, which
 * webhook-manual-capture.test.ts covers.
 */
async function deliver(
  orgId: Types.ObjectId,
  event: Stripe.Event,
  secret: string,
) {
  const gateway = await getGatewayForOrganization(String(orgId));
  const payload = JSON.stringify(event);
  const headers = new Headers({
    "stripe-signature": signWebhook(payload, secret),
  });
  const verified = await gateway.verifyWebhook(payload, headers);
  return { verified, result: await processGatewayEvent(verified, String(orgId)) };
}

const deliverToGlobeVista = (orgId: Types.ObjectId, event: Stripe.Event) =>
  deliver(orgId, event, GV_WEBHOOK_SECRET);

async function reload(orderId: string) {
  const doc = await Order.findById(orderId).lean();
  if (!doc) throw new Error(`Order ${orderId} vanished`);
  return doc;
}

/** Drive a GlobeVista order all the way to AUTHORIZED. */
async function authorizedGlobeVistaOrder() {
  const order = await linkedOrder(globevista);
  const doc = await reload(order.id);
  const event = buildAmountCapturableUpdated({
    paymentIntentId: doc.payment.paymentIntentId!,
    orderId: order.id,
    orderNumber: order.orderNumber,
    amountCapturable: Math.round(doc.pricing.amount * 100),
  });
  await deliverToGlobeVista(globevista, event);
  return order;
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  Object.assign(process.env, GV_ENV);
  sessionMock = await mockSession(admin);
  rentalconfirmation = await makeOrg({
    slug: "rentalconfirmation",
    brandName: "Rental Confirmation",
    isDefault: true,
    captureMode: CaptureMode.AUTOMATIC,
  });
  globevista = await makeOrg({
    slug: "globevista",
    brandName: "FlightBizz",
    isDefault: false,
    captureMode: CaptureMode.MANUAL,
    serviceTypes: [ServiceType.FLIGHT],
    email: {
      fromName: "FlightBizz",
      fromEmail: "no-reply@flightbizz.test",
    },
  });
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  for (const k of Object.keys(GV_ENV)) delete process.env[k];
  setNextHeaders({});
});

/* ─────────── 13. capture_method: manual is GlobeVista-only ─────────── */

describe("13 — Stripe manual capture is enabled ONLY for GlobeVista", () => {
  it("asks Stripe for a manual-capture PaymentIntent on a GlobeVista link", async () => {
    await linkedOrder(globevista);

    const params = lastSessionParams();
    expect(params.payment_intent_data?.capture_method).toBe("manual");
    expect(getCurrentTestStripe().sessionsCreated.at(-1)!.manualCapture).toBe(
      true,
    );
  });

  it("pins the manual-capture bookkeeping onto the order at link time", async () => {
    const order = await linkedOrder(globevista);
    const doc = await reload(order.id);

    expect(doc.payment.capture?.method).toBe(CaptureMode.MANUAL);
    expect(doc.payment.capture?.status).toBe(
      PaymentCaptureStatus.PENDING_AUTHORIZATION,
    );
    expect(doc.bookingStatus).toBe(BookingStatus.PENDING);
    // The money has not moved and the order is not paid.
    expect(doc.status).toBe(OrderStatus.LINK_GENERATED);
    expect(doc.payment.paidAt ?? null).toBeNull();
  });

  it("omits capture_method ENTIRELY for RentalConfirmation — not 'automatic', ABSENT", async () => {
    await linkedOrder(rentalconfirmation);

    const params = lastSessionParams();
    const intentData = params.payment_intent_data ?? {};
    // The distinction that matters: an explicit "automatic" would be a
    // changed payload for the incumbent brand. The key must not be there.
    expect(Object.keys(intentData)).not.toContain("capture_method");
    expect("capture_method" in intentData).toBe(false);
    expect(intentData.capture_method).toBeUndefined();
    expect(JSON.stringify(params)).not.toContain("capture_method");
    expect(getCurrentTestStripe().sessionsCreated.at(-1)!.manualCapture).toBe(
      false,
    );
  });

  it("leaves payment.capture null on a RentalConfirmation order", async () => {
    const order = await linkedOrder(rentalconfirmation);
    const doc = await reload(order.id);

    expect(doc.payment.capture ?? null).toBeNull();
    expect(doc.bookingStatus ?? null).toBeNull();
    expect(doc.status).toBe(OrderStatus.LINK_GENERATED);
  });

  it("keeps the incumbent's checkout idempotency key unchanged", async () => {
    const rc = await linkedOrder(rentalconfirmation);
    const rcCall = getCurrentTestStripe().sessionsCreated.at(-1)!;
    expect(rcCall.options?.idempotencyKey).toBe(`order:${rc.id}:checkout`);

    const gv = await linkedOrder(globevista);
    const gvCall = getCurrentTestStripe().sessionsCreated.at(-1)!;
    // Namespaced away so re-authorizing after a released hold is not served
    // the dead session out of Stripe's 24h idempotency cache.
    expect(gvCall.options?.idempotencyKey).toBe(
      `order:${gv.id}:checkout:manual`,
    );
  });
});

/* ─────────── 14. completion is not capture (service level) ─────────── */

describe("14 — checkout completion does NOT automatically capture", () => {
  it("routes an 'unpaid' completion to AUTHORIZED and never to PAID", async () => {
    const order = await linkedOrder(globevista);
    const before = await reload(order.id);

    const { verified } = await deliverToGlobeVista(
      globevista,
      buildCheckoutCompleted({
        orderId: order.id,
        orderNumber: order.orderNumber,
        sessionId: before.payment.stripeSessionId!,
        paymentIntentId: before.payment.paymentIntentId!,
        amountTotal: Math.round(before.pricing.amount * 100),
        paymentStatus: "unpaid",
      }),
    );

    // The adapter rerouted it — this is the guard that keeps a hold from
    // being read as a payment.
    expect(verified.type).toBe("payment.authorized");

    const doc = await reload(order.id);
    expect(doc.status).not.toBe(OrderStatus.PAID);
    expect(doc.payment.status).not.toBe(OrderStatus.PAID);
    expect(doc.payment.paidAt ?? null).toBeNull();
    expect(doc.payment.capture?.status).toBe(PaymentCaptureStatus.AUTHORIZED);
    expect(doc.bookingStatus).toBe(BookingStatus.PENDING);

    // No receipt for money that has not moved.
    expect(
      await PendingEmail.countDocuments({
        orderId: new Types.ObjectId(order.id),
        kind: EmailKind.PAYMENT_CONFIRMATION,
      }),
    ).toBe(0);
    // The customer IS told their card was authorized, which is a different
    // email entirely and only ever exists on a manual-capture order.
    expect(
      await PendingEmail.countDocuments({
        orderId: new Types.ObjectId(order.id),
        kind: EmailKind.PAYMENT_AUTHORIZED,
      }),
    ).toBe(1);
  });

  it("still marks a RentalConfirmation 'paid' completion PAID, exactly as before", async () => {
    const order = await linkedOrder(rentalconfirmation);
    const before = await reload(order.id);

    const { verified } = await deliver(
      rentalconfirmation,
      buildCheckoutCompleted({
        orderId: order.id,
        orderNumber: order.orderNumber,
        sessionId: before.payment.stripeSessionId!,
        paymentIntentId: before.payment.paymentIntentId!,
        amountTotal: Math.round(before.pricing.amount * 100),
      }),
      DEPLOYMENT_WEBHOOK_SECRET,
    );
    expect(verified.type).toBe("checkout.completed");

    const doc = await reload(order.id);
    expect(doc.status).toBe(OrderStatus.PAID);
    expect(doc.payment.status).toBe(OrderStatus.PAID);
    expect(doc.payment.paidAt).toBeInstanceOf(Date);
    expect(doc.payment.amountReceived).toBe(doc.pricing.amount);
    // Untouched by everything manual capture added.
    expect(doc.payment.capture ?? null).toBeNull();
    expect(doc.bookingStatus ?? null).toBeNull();
    expect(
      await PendingEmail.countDocuments({
        orderId: new Types.ObjectId(order.id),
        kind: EmailKind.PAYMENT_CONFIRMATION,
      }),
    ).toBe(1);
  });
});

/* ─────────────────── 15. requires_capture is handled ─────────────────── */

describe("15 — payment_intent.amount_capturable_updated drives AUTHORIZED", () => {
  it("records the authorization without touching order status", async () => {
    const order = await linkedOrder(globevista);
    const before = await reload(order.id);
    const amountMinor = Math.round(before.pricing.amount * 100);

    const { verified, result } = await deliverToGlobeVista(
      globevista,
      buildAmountCapturableUpdated({
        paymentIntentId: before.payment.paymentIntentId!,
        orderId: order.id,
        orderNumber: order.orderNumber,
        amountCapturable: amountMinor,
      }),
    );
    expect(verified.type).toBe("payment.authorized");
    expect(result).toMatchObject({ handled: true, duplicate: false });

    const doc = await reload(order.id);
    expect(doc.payment.capture?.status).toBe(PaymentCaptureStatus.AUTHORIZED);
    expect(doc.payment.capture?.amountAuthorized).toBe(before.pricing.amount);
    expect(doc.payment.capture?.authorizedAt).toBeInstanceOf(Date);
    expect(doc.payment.capture?.captureExpiresAt).toBeInstanceOf(Date);

    // Stripe holds an authorization for seven days.
    const authorizedAt = doc.payment.capture!.authorizedAt!.getTime();
    const expiresAt = doc.payment.capture!.captureExpiresAt!.getTime();
    expect(expiresAt - authorizedAt).toBe(7 * 24 * 60 * 60 * 1000);

    // The whole point: the payment fields are untouched. An authorized
    // order is not revenue and must not read as PAID anywhere.
    expect(doc.status).toBe(OrderStatus.LINK_GENERATED);
    expect(doc.payment.status).toBe(OrderStatus.LINK_GENERATED);
    expect(doc.payment.paidAt ?? null).toBeNull();
    expect(doc.payment.amountReceived ?? null).toBeNull();
    expect(doc.bookingStatus).toBe(BookingStatus.PENDING);
  });

  it("ignores an authorization aimed at an automatic-capture order", async () => {
    const order = await linkedOrder(rentalconfirmation);
    const before = await reload(order.id);

    const { result } = await deliver(
      rentalconfirmation,
      buildAmountCapturableUpdated({
        paymentIntentId: before.payment.paymentIntentId!,
        orderId: order.id,
        orderNumber: order.orderNumber,
      }),
      DEPLOYMENT_WEBHOOK_SECRET,
    );
    expect(result.reason).toBe("not_manual_capture");

    const doc = await reload(order.id);
    expect(doc.payment.capture ?? null).toBeNull();
    expect(doc.bookingStatus ?? null).toBeNull();
    expect(doc.status).toBe(OrderStatus.LINK_GENERATED);
  });
});

/* ──────────────── 16. an authorized payment CAN be captured ───────────── */

describe("16 — capturePayment() converts the hold into a charge", () => {
  it("calls Stripe, confirms the booking, and settles the payment", async () => {
    const order = await authorizedGlobeVistaOrder();
    const stripe = getCurrentTestStripe();
    const authorized = await reload(order.id);

    await capturePayment(order.id, { actor: admin });

    expect(stripe.capturesRequested).toHaveLength(1);
    expect(stripe.capturesRequested[0]!.id).toBe(
      authorized.payment.paymentIntentId,
    );
    // A double-click retried over a flaky network must replay Stripe's
    // original capture, not issue a second one.
    expect(stripe.capturesRequested[0]!.options?.idempotencyKey).toBe(
      `order:${order.id}:capture`,
    );

    const doc = await reload(order.id);
    expect(doc.payment.capture?.status).toBe(PaymentCaptureStatus.CAPTURED);
    expect(doc.payment.capture?.capturedAt).toBeInstanceOf(Date);
    expect(doc.bookingStatus).toBe(BookingStatus.CONFIRMED);
    expect(doc.status).toBe(OrderStatus.PAID);
    expect(doc.payment.status).toBe(OrderStatus.PAID);
    expect(doc.payment.paidAt).toBeInstanceOf(Date);
  });

  it("does not charge twice — the second capture is a no-op that reaches no gateway", async () => {
    // WHICH BEHAVIOUR THE IMPLEMENTATION CHOOSES: it NO-OPS. Once
    // `payment.capture.status` is CAPTURED, `capturePayment` returns the
    // order unchanged instead of throwing, so an operator double-click is
    // idempotent from their point of view. Exactly one capture call ever
    // reaches Stripe.
    const order = await authorizedGlobeVistaOrder();
    const stripe = getCurrentTestStripe();

    await capturePayment(order.id, { actor: admin });
    const afterFirst = await reload(order.id);

    await expect(
      capturePayment(order.id, { actor: admin }),
    ).resolves.toBeTruthy();

    expect(stripe.capturesRequested).toHaveLength(1);

    const afterSecond = await reload(order.id);
    expect(afterSecond.payment.capture?.status).toBe(
      PaymentCaptureStatus.CAPTURED,
    );
    // Nothing was re-stamped, so the money figures cannot have doubled.
    expect(afterSecond.payment.capture?.capturedAt?.getTime()).toBe(
      afterFirst.payment.capture?.capturedAt?.getTime(),
    );
    expect(afterSecond.payment.paidAt?.getTime()).toBe(
      afterFirst.payment.paidAt?.getTime(),
    );
    expect(afterSecond.payment.amountReceived).toBe(
      afterFirst.payment.amountReceived,
    );
    // And exactly one confirmation email for the whole lifecycle.
    expect(
      await PendingEmail.countDocuments({
        orderId: new Types.ObjectId(order.id),
        kind: EmailKind.PAYMENT_CONFIRMATION,
      }),
    ).toBe(1);
  });

  it("refuses to capture more than was authorized", async () => {
    const order = await authorizedGlobeVistaOrder();
    const stripe = getCurrentTestStripe();
    const doc = await reload(order.id);

    await expect(
      capturePayment(order.id, { actor: admin }, {
        amount: doc.pricing.amount + 1,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(stripe.capturesRequested).toHaveLength(0);
  });
});

/* ────────── 17. an authorization CAN be released without charge ───────── */

describe("17 — cancelAuthorization() releases the hold", () => {
  it("releases at the gateway and cancels the BOOKING, not the payment", async () => {
    const order = await authorizedGlobeVistaOrder();
    const stripe = getCurrentTestStripe();
    const authorized = await reload(order.id);

    await cancelAuthorization(order.id, { actor: admin }, {
      reason: "Supplier could not confirm the fare",
    });

    expect(stripe.cancelsRequested).toHaveLength(1);
    expect(stripe.cancelsRequested[0]!.id).toBe(
      authorized.payment.paymentIntentId,
    );
    expect(stripe.capturesRequested).toHaveLength(0);

    const doc = await reload(order.id);
    expect(doc.payment.capture?.status).toBe(PaymentCaptureStatus.CANCELLED);
    expect(doc.payment.capture?.cancelledAt).toBeInstanceOf(Date);
    expect(doc.payment.capture?.cancelReason).toBe(
      "Supplier could not confirm the fare",
    );
    expect(doc.bookingStatus).toBe(BookingStatus.CANCELLED);

    // THE CRITICAL PART. A released hold is not a failed payment: driving
    // the order to FAILED would put it in a terminal state that blocks the
    // operator from ever re-issuing a link, and PAID would book revenue for
    // money that was handed straight back.
    expect(doc.status).not.toBe(OrderStatus.FAILED);
    expect(doc.status).not.toBe(OrderStatus.PAID);
    expect(doc.payment.status).not.toBe(OrderStatus.FAILED);
    expect(doc.payment.status).not.toBe(OrderStatus.PAID);
    expect(doc.status).toBe(OrderStatus.LINK_GENERATED);
    expect(doc.payment.paidAt ?? null).toBeNull();
    // The customer was never charged, so there is no receipt.
    expect(
      await PendingEmail.countDocuments({
        orderId: new Types.ObjectId(order.id),
        kind: EmailKind.PAYMENT_CONFIRMATION,
      }),
    ).toBe(0);
  });

  it("refuses to release a payment that has already been captured", async () => {
    const order = await authorizedGlobeVistaOrder();
    await capturePayment(order.id, { actor: admin });

    await expect(
      cancelAuthorization(order.id, { actor: admin }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(getCurrentTestStripe().cancelsRequested).toHaveLength(0);
  });
});

/* ───────────────── 18. webhook processing is idempotent ──────────────── */

describe("18 — the same Stripe event delivered twice is applied once", () => {
  it("collapses a repeated authorization", async () => {
    const order = await linkedOrder(globevista);
    const before = await reload(order.id);
    const event = buildAmountCapturableUpdated({
      paymentIntentId: before.payment.paymentIntentId!,
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountCapturable: Math.round(before.pricing.amount * 100),
    });

    const first = await deliverToGlobeVista(globevista, event);
    expect(first.result).toMatchObject({ handled: true, duplicate: false });
    const afterFirst = await reload(order.id);

    // Stripe genuinely re-delivers; a replay must not re-stamp anything.
    const second = await deliverToGlobeVista(globevista, event);
    expect(second.result.duplicate).toBe(true);

    const afterSecond = await reload(order.id);
    expect(afterSecond.payment.capture?.authorizedAt?.getTime()).toBe(
      afterFirst.payment.capture?.authorizedAt?.getTime(),
    );
    expect(afterSecond.payment.capture?.captureExpiresAt?.getTime()).toBe(
      afterFirst.payment.capture?.captureExpiresAt?.getTime(),
    );
    expect(afterSecond.payment.capture?.status).toBe(
      PaymentCaptureStatus.AUTHORIZED,
    );
    expect(
      await PendingEmail.countDocuments({
        orderId: new Types.ObjectId(order.id),
        kind: EmailKind.PAYMENT_AUTHORIZED,
      }),
    ).toBe(1);
  });

  it("collapses a repeated capture", async () => {
    const order = await authorizedGlobeVistaOrder();
    const doc = await reload(order.id);
    const event = buildPaymentIntentSucceeded({
      paymentIntentId: doc.payment.paymentIntentId!,
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountReceived: Math.round(doc.pricing.amount * 100),
    });

    const first = await deliverToGlobeVista(globevista, event);
    expect(first.verified.type).toBe("payment.captured");
    expect(first.result).toMatchObject({ handled: true, duplicate: false });
    const afterFirst = await reload(order.id);
    expect(afterFirst.status).toBe(OrderStatus.PAID);
    expect(afterFirst.payment.capture?.status).toBe(
      PaymentCaptureStatus.CAPTURED,
    );
    expect(afterFirst.bookingStatus).toBe(BookingStatus.CONFIRMED);

    const second = await deliverToGlobeVista(globevista, event);
    expect(second.result.duplicate).toBe(true);

    const afterSecond = await reload(order.id);
    expect(afterSecond.payment.paidAt?.getTime()).toBe(
      afterFirst.payment.paidAt?.getTime(),
    );
    expect(afterSecond.payment.amountReceived).toBe(
      afterFirst.payment.amountReceived,
    );
    expect(
      await PendingEmail.countDocuments({
        orderId: new Types.ObjectId(order.id),
        kind: EmailKind.PAYMENT_CONFIRMATION,
      }),
    ).toBe(1);
  });
});

/* ──────────────────── RBAC on the new operations ─────────────────────── */

describe("RBAC — capture and release are ADMIN and above", () => {
  it("does not grant STAFF either permission", () => {
    // An agent may generate and resend links all day. Deciding that a
    // booking is fulfilled and the hold should become a charge is not
    // theirs, and neither is handing the money back.
    expect(
      roleHasPermission(UserRole.STAFF, Permission.ORDER_CAPTURE_PAYMENT),
    ).toBe(false);
    expect(
      roleHasPermission(UserRole.STAFF, Permission.ORDER_VOID_AUTHORIZATION),
    ).toBe(false);
  });

  it("grants both to ADMIN and SUPER_ADMIN", () => {
    for (const role of [UserRole.ADMIN, UserRole.SUPER_ADMIN]) {
      expect(roleHasPermission(role, Permission.ORDER_CAPTURE_PAYMENT)).toBe(
        true,
      );
      expect(
        roleHasPermission(role, Permission.ORDER_VOID_AUTHORIZATION),
      ).toBe(true);
    }
  });

  it("refuses a STAFF capture at the service layer, before touching Stripe", async () => {
    const order = await authorizedGlobeVistaOrder();

    await expect(
      capturePayment(order.id, { actor: staff }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(getCurrentTestStripe().capturesRequested).toHaveLength(0);

    const doc = await reload(order.id);
    expect(doc.payment.capture?.status).toBe(PaymentCaptureStatus.AUTHORIZED);
  });

  it("refuses a STAFF release at the service layer, before touching Stripe", async () => {
    const order = await authorizedGlobeVistaOrder();

    await expect(
      cancelAuthorization(order.id, { actor: staff }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(getCurrentTestStripe().cancelsRequested).toHaveLength(0);
  });
});

describe("the incumbent brands cannot reach the capture machinery at all", () => {
  it("refuses to capture an automatic-capture order", async () => {
    const order = await linkedOrder(rentalconfirmation);

    const err = await capturePayment(order.id, { actor: admin }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(String((err as Error).message)).toMatch(/charged at checkout/i);
    expect(getCurrentTestStripe().capturesRequested).toHaveLength(0);

    const doc = await reload(order.id);
    expect(doc.payment.capture ?? null).toBeNull();
    expect(doc.bookingStatus ?? null).toBeNull();
    expect(doc.status).toBe(OrderStatus.LINK_GENERATED);
  });

  it("refuses to release an authorization on an automatic-capture order", async () => {
    const order = await linkedOrder(rentalconfirmation);

    await expect(
      cancelAuthorization(order.id, { actor: admin }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(getCurrentTestStripe().cancelsRequested).toHaveLength(0);
  });
});
