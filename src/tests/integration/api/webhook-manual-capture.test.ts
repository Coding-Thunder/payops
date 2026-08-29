import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import {
  AuditLog,
  Order,
  Organization,
  OrganizationMember,
  PendingEmail,
} from "@/server/db/models";
import { orgCookieName } from "@/server/auth/org-cookie";
import { POST as deploymentWebhook } from "@/app/api/webhooks/stripe/route";
import { POST as orgWebhook } from "@/app/api/webhooks/stripe/[orgSlug]/route";
import { createOrder, initiatePayment } from "@/server/services/order.service";
import { createSettings } from "@/tests/factories/settings.factory";
import {
  buildCheckoutCompleted,
  signWebhook,
} from "@/tests/factories/stripe-event.factory";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { jsonBody } from "@/tests/utils/api";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * Manual capture as seen from the HTTP webhook endpoints.
 *
 * manual-capture.test.ts covers the service layer. This file drives the same
 * two properties through the real route handlers — signature verification,
 * per-organization credential selection, the tenancy chokepoint — because
 * that is the surface Stripe actually hits:
 *
 *   14. a delivery that says `payment_status: "unpaid"` must NOT settle the
 *       order, while the incumbent's `"paid"` delivery must settle it
 *       exactly as it always has;
 *   19. a delivery to GlobeVista's endpoint can never touch another
 *       organization's order, however the payload is addressed.
 *
 * Modelled on webhook-per-org.test.ts, which established this shape.
 */

const admin = actorFor(UserRole.ADMIN);

const GV_ENV = {
  ORG_GLOBEVISTA_STRIPE_SECRET_KEY: "sk_test_globevista_only",
  ORG_GLOBEVISTA_STRIPE_WEBHOOK_SECRET: "whsec_globevista_only",
};
const GV_WEBHOOK_SECRET = GV_ENV.ORG_GLOBEVISTA_STRIPE_WEBHOOK_SECRET;
const DEPLOYMENT_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
let globevista: Types.ObjectId;
let rentalconfirmation: Types.ObjectId;

function params(orgSlug: string) {
  return { params: Promise.resolve({ orgSlug }) };
}

/** Raw Request, matching how webhook-per-org.test.ts drives the route. */
function req(url: string, payload: string, signature: string) {
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("stripe-signature", signature);
  return new Request(url, {
    method: "POST",
    headers,
    body: payload,
  }) as never;
}

function postToOrg(slug: string, event: Stripe.Event, secret: string) {
  const payload = JSON.stringify(event);
  return orgWebhook(
    req(
      `http://localhost/api/webhooks/stripe/${slug}`,
      payload,
      signWebhook(payload, secret),
    ),
    params(slug),
  );
}

function postToDeployment(event: Stripe.Event, secret: string) {
  const payload = JSON.stringify(event);
  return deploymentWebhook(
    req(
      "http://localhost/api/webhooks/stripe",
      payload,
      signWebhook(payload, secret),
    ),
  );
}

async function makeOrg(opts: {
  slug: string;
  brandName: string;
  isDefault: boolean;
  captureMode: CaptureMode;
  serviceTypes?: ServiceType[];
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
  });
  const id = doc._id as Types.ObjectId;
  await OrganizationMember.create({
    organizationId: id,
    userId: new Types.ObjectId(admin.id),
    role: UserRole.ADMIN,
    status: RecordState.ACTIVE,
  });
  return id;
}

async function linkedOrder(orgId: Types.ObjectId) {
  setNextHeaders({ cookies: { [orgCookieName()]: String(orgId) } });
  const { order } = await createOrder(validCreateOrderInput(), { actor: admin });
  const { order: initiated } = await initiatePayment(order.id, { actor: admin });
  const doc = await Order.findById(initiated.id).lean();
  if (!doc) throw new Error("order vanished");
  return doc;
}

async function reload(orderId: Types.ObjectId | string) {
  const doc = await Order.findById(orderId).lean();
  if (!doc) throw new Error("order vanished");
  return doc;
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
  });
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  for (const k of Object.keys(GV_ENV)) delete process.env[k];
  setNextHeaders({});
});

/* ────────── 14. completion is authorization, not settlement ───────── */

describe("14 — a completed checkout does not automatically capture", () => {
  it("an 'unpaid' completion on GlobeVista's endpoint AUTHORIZES and stops there", async () => {
    const order = await linkedOrder(globevista);
    // Preconditions: the link was minted manual-capture.
    expect(order.payment.capture?.method).toBe(CaptureMode.MANUAL);
    expect(order.payment.capture?.status).toBe(
      PaymentCaptureStatus.PENDING_AUTHORIZATION,
    );

    const res = await postToOrg(
      "globevista",
      buildCheckoutCompleted({
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        sessionId: order.payment.stripeSessionId!,
        paymentIntentId: order.payment.paymentIntentId!,
        amountTotal: Math.round(order.pricing.amount * 100),
        // Stripe's manual-capture completion. The funds are held; the
        // customer has not been charged.
        paymentStatus: "unpaid",
      }),
      GV_WEBHOOK_SECRET,
    );
    const { status, body } = await jsonBody<{ data: { received: boolean } }>(res);
    expect(status).toBe(200);
    expect(body.data.received).toBe(true);

    const after = await reload(order._id);
    // Not paid. Not paid anywhere.
    expect(after.status).not.toBe(OrderStatus.PAID);
    expect(after.payment.status).not.toBe(OrderStatus.PAID);
    expect(after.payment.paidAt ?? null).toBeNull();
    expect(after.payment.amountReceived ?? null).toBeNull();
    // Authorized, and the booking is awaiting confirmation.
    expect(after.payment.capture?.status).toBe(PaymentCaptureStatus.AUTHORIZED);
    expect(after.payment.capture?.authorizedAt).toBeInstanceOf(Date);
    expect(after.bookingStatus).toBe(BookingStatus.PENDING);

    // No receipt was enqueued: nothing has been received.
    expect(
      await PendingEmail.countDocuments({
        orderId: order._id,
        kind: EmailKind.PAYMENT_CONFIRMATION,
      }),
    ).toBe(0);
    // Nor was PAYMENT_SUCCEEDED ever recorded.
    expect(
      await AuditLog.countDocuments({ action: AuditAction.PAYMENT_SUCCEEDED }),
    ).toBe(0);
  });

  it("a 'paid' completion on the deployment endpoint settles RentalConfirmation exactly as before", async () => {
    const order = await linkedOrder(rentalconfirmation);
    expect(order.payment.capture ?? null).toBeNull();

    const res = await postToDeployment(
      buildCheckoutCompleted({
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        sessionId: order.payment.stripeSessionId!,
        paymentIntentId: order.payment.paymentIntentId!,
        amountTotal: Math.round(order.pricing.amount * 100),
      }),
      DEPLOYMENT_WEBHOOK_SECRET,
    );
    expect((await jsonBody(res)).status).toBe(200);

    const after = await reload(order._id);
    expect(after.status).toBe(OrderStatus.PAID);
    expect(after.payment.status).toBe(OrderStatus.PAID);
    expect(after.payment.paidAt).toBeInstanceOf(Date);
    expect(after.payment.amountReceived).toBe(after.pricing.amount);
    // Nothing manual capture added leaked onto the incumbent's order.
    expect(after.payment.capture ?? null).toBeNull();
    expect(after.bookingStatus ?? null).toBeNull();

    expect(
      await PendingEmail.countDocuments({
        orderId: order._id,
        kind: EmailKind.PAYMENT_CONFIRMATION,
      }),
    ).toBe(1);
    expect(
      await AuditLog.countDocuments({ action: AuditAction.PAYMENT_SUCCEEDED }),
    ).toBe(1);
  });
});

/* ────────── 19. one brand's endpoint cannot touch another's order ───── */

describe("19 — a GlobeVista delivery cannot modify another organization's order", () => {
  it("leaves a RentalConfirmation order COMPLETELY untouched and audits the attempt", async () => {
    // Two legal entities, two merchant accounts. If GlobeVista's endpoint
    // could settle RentalConfirmation's order, the money would have landed
    // in GlobeVista's account while the other brand's books recorded the
    // sale. The order reference in the payload is not trustworthy, so the
    // binding is enforced server-side.
    const victim = await linkedOrder(rentalconfirmation);
    const snapshot = JSON.stringify(victim);

    const res = await postToOrg(
      "globevista",
      buildCheckoutCompleted({
        orderId: String(victim._id),
        orderNumber: victim.orderNumber,
        sessionId: victim.payment.stripeSessionId!,
        paymentIntentId: victim.payment.paymentIntentId!,
        amountTotal: Math.round(victim.pricing.amount * 100),
      }),
      GV_WEBHOOK_SECRET,
    );

    // Acked so Stripe stops retrying, but treated as "not our order".
    const { status, body } = await jsonBody(res);
    expect(status).toBe(200);
    expect(JSON.stringify(body)).toMatch(/order_not_found/);

    const after = await reload(victim._id);
    expect(after.status).toBe(OrderStatus.LINK_GENERATED);
    expect(after.payment.paidAt ?? null).toBeNull();
    expect(after.payment.capture ?? null).toBeNull();
    expect(after.bookingStatus ?? null).toBeNull();
    expect(String(after.organizationId)).toBe(String(rentalconfirmation));
    // Byte-for-byte: not one field of the record moved.
    expect(JSON.stringify(after)).toBe(snapshot);

    // And the attempt is on the record.
    const crossOrg = await AuditLog.find({
      action: AuditAction.WEBHOOK_FAILED,
      "metadata.reason": "cross_organization_event",
    }).lean();
    expect(crossOrg).toHaveLength(1);
    expect(String(crossOrg[0]!.metadata!.orderId)).toBe(String(victim._id));
    expect(String(crossOrg[0]!.metadata!.orderOrganizationId)).toBe(
      String(rentalconfirmation),
    );
    expect(String(crossOrg[0]!.metadata!.endpointOrganizationId)).toBe(
      String(globevista),
    );

    // No side effects of any kind reached the victim.
    expect(await PendingEmail.countDocuments({ orderId: victim._id })).toBe(0);
    expect(
      await AuditLog.countDocuments({ action: AuditAction.PAYMENT_SUCCEEDED }),
    ).toBe(0);
  });

  it("also refuses a cross-organization AUTHORIZATION, not just a settlement", async () => {
    // The same payload with `payment_status: "unpaid"` takes the new
    // manual-capture branch. The tenancy chokepoint sits upstream of that
    // branch, so it must refuse there too — otherwise the new code path
    // would be a way around the check.
    const victim = await linkedOrder(rentalconfirmation);
    const snapshot = JSON.stringify(victim);

    const res = await postToOrg(
      "globevista",
      buildCheckoutCompleted({
        orderId: String(victim._id),
        orderNumber: victim.orderNumber,
        sessionId: victim.payment.stripeSessionId!,
        paymentIntentId: victim.payment.paymentIntentId!,
        amountTotal: Math.round(victim.pricing.amount * 100),
        paymentStatus: "unpaid",
      }),
      GV_WEBHOOK_SECRET,
    );
    expect((await jsonBody(res)).status).toBe(200);

    expect(JSON.stringify(await reload(victim._id))).toBe(snapshot);
    expect(
      await AuditLog.countDocuments({
        action: AuditAction.WEBHOOK_FAILED,
        "metadata.reason": "cross_organization_event",
      }),
    ).toBe(1);
  });

  it("rejects a GlobeVista-addressed event signed with the deployment secret", async () => {
    // Knowing the slug buys nothing: the URL only selects which secret the
    // signature is checked against.
    const order = await linkedOrder(globevista);
    const snapshot = JSON.stringify(order);

    const res = await postToOrg(
      "globevista",
      buildCheckoutCompleted({
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        sessionId: order.payment.stripeSessionId!,
        paymentIntentId: order.payment.paymentIntentId!,
        amountTotal: Math.round(order.pricing.amount * 100),
        paymentStatus: "unpaid",
      }),
      DEPLOYMENT_WEBHOOK_SECRET,
    );
    expect((await jsonBody(res)).status).toBe(400);

    expect(JSON.stringify(await reload(order._id))).toBe(snapshot);
  });

  it("settles GlobeVista's OWN order when the delivery is legitimate", async () => {
    // The positive control — the refusals above are not simply "this
    // endpoint never works".
    const order = await linkedOrder(globevista);

    const res = await postToOrg(
      "globevista",
      buildCheckoutCompleted({
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        sessionId: order.payment.stripeSessionId!,
        paymentIntentId: order.payment.paymentIntentId!,
        amountTotal: Math.round(order.pricing.amount * 100),
        paymentStatus: "unpaid",
      }),
      GV_WEBHOOK_SECRET,
    );
    expect((await jsonBody(res)).status).toBe(200);

    const after = await reload(order._id);
    expect(after.payment.capture?.status).toBe(PaymentCaptureStatus.AUTHORIZED);
    expect(
      await AuditLog.countDocuments({
        action: AuditAction.WEBHOOK_FAILED,
        "metadata.reason": "cross_organization_event",
      }),
    ).toBe(0);
  });
});
