import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";
import type Stripe from "stripe";

import {
  BookingStatus,
  CaptureMode,
  OrderStatus,
  PaymentCaptureStatus,
  PaymentGatewayKey,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { ConflictError } from "@/lib/errors";
import { Order, Organization, OrganizationMember } from "@/server/db/models";
import { orgCookieName } from "@/server/auth/org-cookie";
import { getGatewayForOrganization } from "@/server/payments/resolve-gateway";
import {
  createOrder,
  initiatePayment,
  regeneratePaymentLink,
} from "@/server/services/order.service";
import { cancelAuthorization } from "@/server/services/payment-capture.service";
import { processGatewayEvent } from "@/server/services/webhook.service";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";
import { createSettings } from "@/tests/factories/settings.factory";
import {
  buildAmountCapturableUpdated,
  signWebhook,
} from "@/tests/factories/stripe-event.factory";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * REGRESSION TESTS FOR A REAL DEFECT FOUND IN ADVERSARIAL REVIEW.
 *
 * `initiatePayment` was taught about manual capture; `regeneratePaymentLink`
 * — the OTHER `gateway.createSession` call site, reachable from a first-class
 * button on the order page — was not. The consequences were severe and
 * silent:
 *
 *   1. The replacement session was created with AUTOMATIC capture while the
 *      order still said MANUAL. Stripe charged the customer's card at
 *      checkout, but the webhook path recorded it as a mere AUTHORIZATION —
 *      so real money moved, the order never became PAID, it was excluded
 *      from every revenue aggregation, and the customer was emailed
 *      "your card was authorized, you have not been charged".
 *
 *   2. Regenerating over a LIVE authorization repointed
 *      `payment.paymentIntentId` at a new intent, orphaning the hold. The
 *      customer's funds stayed locked until Stripe expired them ~7 days
 *      later, Capture and Release both acted on the wrong intent, and a
 *      second successful payment would have charged them twice.
 *
 * Neither was covered by any test, which is exactly why they survived to
 * review. Both are pinned here.
 */

const admin = actorFor(UserRole.ADMIN, { name: "Admin User" });

const GV_SECRET_KEY = "sk_test_globevista_only";
const GV_WEBHOOK_SECRET = "whsec_globevista_only";

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
let globevista: Types.ObjectId;
let rentalconfirmation: Types.ObjectId;

async function makeOrg(opts: {
  slug: string;
  isDefault: boolean;
  captureMode: CaptureMode;
  serviceTypes?: ServiceType[];
}) {
  const doc = await Organization.create({
    slug: opts.slug,
    name: opts.slug,
    brandName: opts.slug,
    isDefault: opts.isDefault,
    payments: {
      provider: PaymentGatewayKey.STRIPE,
      captureMode: opts.captureMode,
    },
    serviceTypes: opts.serviceTypes ?? [ServiceType.CAR_RENTAL],
  });
  const id = doc._id as Types.ObjectId;
  await OrganizationMember.create({
    organizationId: id,
    userId: new Types.ObjectId(admin.id),
    role: admin.role,
    status: RecordState.ACTIVE,
  });
  return id;
}

function actingAs(orgId: Types.ObjectId) {
  setNextHeaders({ cookies: { [orgCookieName()]: String(orgId) } });
}

async function linkedOrder(orgId: Types.ObjectId) {
  actingAs(orgId);
  const { order } = await createOrder(validCreateOrderInput(), { actor: admin });
  const { order: initiated } = await initiatePayment(order.id, { actor: admin });
  return initiated;
}

async function reload(orderId: string) {
  const doc = await Order.findById(orderId).lean();
  if (!doc) throw new Error(`Order ${orderId} vanished`);
  return doc;
}

function lastSessionParams(): Stripe.Checkout.SessionCreateParams {
  const last = getCurrentTestStripe().sessionsCreated.at(-1);
  if (!last) throw new Error("No Stripe checkout session was created");
  return last.params;
}

async function deliverToGlobeVista(event: Stripe.Event) {
  const gateway = await getGatewayForOrganization(String(globevista));
  const payload = JSON.stringify(event);
  const headers = new Headers({
    "stripe-signature": signWebhook(payload, GV_WEBHOOK_SECRET),
  });
  const verified = await gateway.verifyWebhook(payload, headers);
  return processGatewayEvent(verified, String(globevista));
}

async function authorize(orderId: string, orderNumber: string) {
  const doc = await reload(orderId);
  await deliverToGlobeVista(
    buildAmountCapturableUpdated({
      paymentIntentId: doc.payment.paymentIntentId!,
      orderId,
      orderNumber,
      amountCapturable: Math.round(doc.pricing.amount * 100),
    }),
  );
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sessionMock = await mockSession(admin);
  process.env.ORG_GLOBEVISTA_STRIPE_SECRET_KEY = GV_SECRET_KEY;
  process.env.ORG_GLOBEVISTA_STRIPE_WEBHOOK_SECRET = GV_WEBHOOK_SECRET;
  rentalconfirmation = await makeOrg({
    slug: "rentalconfirmation",
    isDefault: true,
    captureMode: CaptureMode.AUTOMATIC,
  });
  globevista = await makeOrg({
    slug: "globevista",
    isDefault: false,
    captureMode: CaptureMode.MANUAL,
    serviceTypes: [ServiceType.FLIGHT, ServiceType.HOTEL, ServiceType.CAR_RENTAL],
  });
});

afterEach(() => {
  delete process.env.ORG_GLOBEVISTA_STRIPE_SECRET_KEY;
  delete process.env.ORG_GLOBEVISTA_STRIPE_WEBHOOK_SECRET;
  if (sessionMock) {
    sessionMock.restore();
    sessionMock = null;
  }
});

describe("regenerating a link carries the capture mode over", () => {
  it("asks Stripe for a MANUAL-capture session on a GlobeVista regenerate", async () => {
    const order = await linkedOrder(globevista);
    // Sanity: the FIRST session was manual.
    expect(lastSessionParams().payment_intent_data?.capture_method).toBe(
      "manual",
    );

    await regeneratePaymentLink(order.id, { actor: admin });

    // THE REGRESSION: this used to be undefined, i.e. automatic capture,
    // which charged the customer at checkout on an order the system still
    // believed was merely authorized.
    expect(lastSessionParams().payment_intent_data?.capture_method).toBe(
      "manual",
    );
  });

  it("still sends NO capture_method at all on a RentalConfirmation regenerate", async () => {
    const order = await linkedOrder(rentalconfirmation);
    await regeneratePaymentLink(order.id, { actor: admin });

    const intentData = lastSessionParams().payment_intent_data ?? {};
    // Byte-identity for the incumbent: absent, not "automatic".
    expect("capture_method" in intentData).toBe(false);
    expect(JSON.stringify(lastSessionParams())).not.toContain("capture_method");
  });

  it("re-arms the authorization record against the NEW payment intent", async () => {
    const order = await linkedOrder(globevista);
    const before = await reload(order.id);

    await regeneratePaymentLink(order.id, { actor: admin });
    const after = await reload(order.id);

    expect(after.payment.paymentIntentId).not.toBe(
      before.payment.paymentIntentId,
    );
    // Capture state must track the new intent, or the incoming authorization
    // for the replacement session fails its PENDING_AUTHORIZATION filter and
    // is silently dropped.
    expect(after.payment.capture?.method).toBe(CaptureMode.MANUAL);
    expect(after.payment.capture?.status).toBe(
      PaymentCaptureStatus.PENDING_AUTHORIZATION,
    );
    expect(after.payment.capture?.authorizedAt ?? null).toBeNull();
    expect(after.bookingStatus).toBe(BookingStatus.PENDING);
  });

  it("leaves payment.capture null on a RentalConfirmation regenerate", async () => {
    const order = await linkedOrder(rentalconfirmation);
    await regeneratePaymentLink(order.id, { actor: admin });
    const after = await reload(order.id);
    expect(after.payment.capture ?? null).toBeNull();
    expect(after.bookingStatus ?? null).toBeNull();
  });

  it("an authorization on the REGENERATED session still lands correctly", async () => {
    const order = await linkedOrder(globevista);
    await regeneratePaymentLink(order.id, { actor: admin });
    await authorize(order.id, order.orderNumber);

    const after = await reload(order.id);
    expect(after.payment.capture?.status).toBe(PaymentCaptureStatus.AUTHORIZED);
    expect(after.bookingStatus).toBe(BookingStatus.PENDING);
    // Still not paid — an authorization is not a payment.
    expect(after.status).not.toBe(OrderStatus.PAID);
    expect(after.payment.paidAt ?? null).toBeNull();
  });
});

describe("regenerating over a live authorization is refused", () => {
  it("refuses while the hold is AUTHORIZED, rather than orphaning it", async () => {
    const order = await linkedOrder(globevista);
    await authorize(order.id, order.orderNumber);
    const before = await reload(order.id);
    expect(before.payment.capture?.status).toBe(
      PaymentCaptureStatus.AUTHORIZED,
    );

    await expect(
      regeneratePaymentLink(order.id, { actor: admin }),
    ).rejects.toBeInstanceOf(ConflictError);

    // Nothing moved: the hold is still reachable by Capture and Release.
    const after = await reload(order.id);
    expect(after.payment.paymentIntentId).toBe(before.payment.paymentIntentId);
    expect(after.payment.stripeSessionId).toBe(before.payment.stripeSessionId);
    expect(after.payment.capture?.status).toBe(PaymentCaptureStatus.AUTHORIZED);
  });

  it("allows regenerating once the authorization has been RELEASED", async () => {
    const order = await linkedOrder(globevista);
    await authorize(order.id, order.orderNumber);
    await cancelAuthorization(order.id, { actor: admin });

    // The documented recovery path: release, then re-issue a link.
    await expect(
      regeneratePaymentLink(order.id, { actor: admin }),
    ).resolves.toBeTruthy();

    const after = await reload(order.id);
    expect(after.payment.capture?.status).toBe(
      PaymentCaptureStatus.PENDING_AUTHORIZATION,
    );
    // A released hold is not a failed payment — the order must not be
    // terminal, or it could never be re-collected.
    expect(after.status).not.toBe(OrderStatus.FAILED);
  });

  it("never blocks a RentalConfirmation regenerate — capture is null there", async () => {
    const order = await linkedOrder(rentalconfirmation);
    await expect(
      regeneratePaymentLink(order.id, { actor: admin }),
    ).resolves.toBeTruthy();
  });
});
