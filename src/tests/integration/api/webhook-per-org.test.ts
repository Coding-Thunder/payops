import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import {
  OrderStatus,
  PaymentGatewayKey,
  RecordState,
} from "@/lib/constants/enums";
import {
  CredentialField,
  CredentialProvider,
  Order,
  Organization,
} from "@/server/db/models";
import { POST as orgWebhook } from "@/app/api/webhooks/stripe/[orgSlug]/route";
import { POST as paypalOrgWebhook } from "@/app/api/webhooks/paypal/[orgSlug]/route";
import { _setPayPalFetchForTesting } from "@/server/payments/gateways/paypal";
import { putSecret } from "@/server/services/organization-credential.service";
import { createOrder as factoryCreateOrder } from "@/tests/factories/order.factory";
import { jsonBody } from "@/tests/utils/api";
import {
  buildCheckoutCompleted,
  signWebhook,
} from "@/tests/factories/stripe-event.factory";
import { ensureMongo } from "@/tests/utils/db";

/**
 * Per-organization webhook endpoints.
 *
 * This closes the gap P5 left open. A Stripe signature can only be verified
 * with the signing secret of the account that produced it, and the payload
 * must not be parsed before verification — so an incoming event cannot tell
 * us which tenant it belongs to. The organization therefore has to be in the
 * URL, and each account is pointed at its own path.
 *
 * The slug grants nothing on its own: it selects WHICH SECRET to verify
 * against, so a request signed with the wrong key is rejected exactly like
 * an unsigned one.
 */

function params(orgSlug: string) {
  return { params: Promise.resolve({ orgSlug }) };
}

/** Raw Request, matching how webhook-stripe.test.ts drives the route. */
function req(slug: string, payload: string, signature?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature) headers.set("stripe-signature", signature);
  return new Request(`http://localhost/api/webhooks/stripe/${slug}`, {
    method: "POST",
    headers,
    body: payload,
  }) as never;
}

async function makeConfiguredOrg(slug: string) {
  const doc = await Organization.create({
    slug,
    name: slug,
    brandName: `${slug} brand`,
    isDefault: false,
    payments: { provider: PaymentGatewayKey.STRIPE },
  });
  const id = String(doc._id as Types.ObjectId);
  await putSecret({
    organizationId: id,
    provider: CredentialProvider.STRIPE,
    field: CredentialField.SECRET_KEY,
    value: `sk_live_${slug}`,
  });
  await putSecret({
    organizationId: id,
    provider: CredentialProvider.STRIPE,
    field: CredentialField.WEBHOOK_SECRET,
    value: `whsec_${slug}`,
  });
  return id;
}

beforeEach(async () => {
  await ensureMongo();
});

describe("endpoint resolution does not leak which brands exist", () => {
  it("returns a flat 404 for an unknown slug", async () => {
    const res = await orgWebhook(
      req("nope", "{}", "t=1,v1=deadbeef"),
      params("nope"),
    );
    const { status, body } = await jsonBody(res);
    expect(status).toBe(404);
    expect(JSON.stringify(body)).toMatch(/unknown endpoint/i);
  });

  it("returns the SAME flat 404 for a real but unconfigured organization", async () => {
    // Distinguishable responses would turn this endpoint into an oracle for
    // enumerating which brands are configured on the deployment.
    await Organization.create({
      slug: "unconfigured",
      name: "unconfigured",
      brandName: "Unconfigured",
      isDefault: false,
      payments: { provider: PaymentGatewayKey.STRIPE },
    });
    const res = await orgWebhook(
      req("unconfigured", "{}", "t=1,v1=deadbeef"),
      params("unconfigured"),
    );
    const { status, body } = await jsonBody(res);
    expect(status).toBe(404);
    expect(JSON.stringify(body)).toMatch(/unknown endpoint/i);
  });

  it("ignores a disabled organization", async () => {
    const id = await makeConfiguredOrg("tripreservations");
    await Organization.updateOne(
      { _id: new Types.ObjectId(id) },
      { $set: { status: RecordState.DISABLED } },
    );
    const res = await orgWebhook(
      req("tripreservations", "{}", "t=1,v1=deadbeef"),
      params("tripreservations"),
    );
    expect((await jsonBody(res)).status).toBe(404);
  });
});

describe("signature handling on a configured organization", () => {
  it("rejects a missing signature before touching the database", async () => {
    await makeConfiguredOrg("tripreservations");
    const res = await orgWebhook(
      req("tripreservations", "{}"),
      params("tripreservations"),
    );
    const { status, body } = await jsonBody(res);
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toMatch(/missing signature/i);
  });

  it("enforces the body cap before verification", async () => {
    await makeConfiguredOrg("tripreservations");
    const res = await orgWebhook(
      req("tripreservations", "x".repeat(70 * 1024), "t=1,v1=deadbeef"),
      params("tripreservations"),
    );
    expect((await jsonBody(res)).status).toBe(413);
  });
});

describe("each endpoint verifies against ITS OWN signing secret", () => {
  it("accepts an event signed with the organization's secret and flips ITS order to PAID", async () => {
    // The gap P5 left open: before per-organization endpoints, a
    // non-default organization could generate a link and send branded email
    // but its payment could never be confirmed, because verification always
    // used the deployment's signing secret.
    const orgId = await makeConfiguredOrg("tripreservations");
    const order = await factoryCreateOrder({});
    await Order.updateOne(
      { _id: order._id },
      { $set: { organizationId: new Types.ObjectId(orgId) } },
    );

    const payload = JSON.stringify(
      buildCheckoutCompleted({
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        amountTotal: Math.round(order.pricing.amount * 100),
      }),
    );
    const signed = signWebhook(payload, "whsec_tripreservations");

    const res = await orgWebhook(req("tripreservations", payload, signed), params("tripreservations"));
    const { status } = await jsonBody(res);
    expect(status).toBe(200);

    const updated = await Order.findById(order._id);
    expect(updated?.status).toBe(OrderStatus.PAID);
    expect(String(updated?.organizationId)).toBe(orgId);
  });

  it("REJECTS an event signed with the DEPLOYMENT secret", async () => {
    // The security property that makes the slug safe to expose: knowing the
    // URL is worthless without that organization's own signing key. A
    // deployment-signed event — or any other tenant's — fails here.
    const orgId = await makeConfiguredOrg("tripreservations");
    const order = await factoryCreateOrder({});
    await Order.updateOne(
      { _id: order._id },
      { $set: { organizationId: new Types.ObjectId(orgId) } },
    );

    const payload = JSON.stringify(
      buildCheckoutCompleted({
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        amountTotal: Math.round(order.pricing.amount * 100),
      }),
    );
    const wrong = signWebhook(payload, process.env.STRIPE_WEBHOOK_SECRET!);

    const res = await orgWebhook(req("tripreservations", payload, wrong), params("tripreservations"));
    const { status } = await jsonBody(res);
    expect(status).toBe(400);

    // And the order is untouched — no partial application before the check.
    const untouched = await Order.findById(order._id);
    expect(untouched?.status).not.toBe(OrderStatus.PAID);
  });
});

describe("a brand's gateway can never settle another brand's order", () => {
  // The regulatory concern, stated as a test. Two brands are two legal
  // entities with separate merchant accounts. If a delivery to brand B's
  // endpoint could mark brand A's order PAID, the money would have landed
  // in B's account while A's books recorded the sale — settlement that does
  // not reconcile, against the wrong entity.
  //
  // The payload's order reference is attacker- or misconfiguration-
  // controlled, so the binding has to be enforced server-side.

  it("REFUSES an event whose order belongs to a different organization", async () => {
    const tripId = await makeConfiguredOrg("tripreservations");

    // An order owned by the OTHER brand.
    const otherOrg = await Organization.create({
      slug: "rentalconfirmation",
      name: "rentalconfirmation",
      brandName: "Rental Confirmation",
      isDefault: true,
      payments: { provider: PaymentGatewayKey.STRIPE },
    });
    const victim = await factoryCreateOrder({});
    await Order.updateOne(
      { _id: victim._id },
      { $set: { organizationId: otherOrg._id as Types.ObjectId } },
    );

    // A correctly-signed delivery to TripReservations' endpoint that names
    // the other brand's order.
    const payload = JSON.stringify(
      buildCheckoutCompleted({
        orderId: String(victim._id),
        orderNumber: victim.orderNumber,
        amountTotal: Math.round(victim.pricing.amount * 100),
      }),
    );
    const signed = signWebhook(payload, "whsec_tripreservations");

    const res = await orgWebhook(
      req("tripreservations", payload, signed),
      params("tripreservations"),
    );
    const { status, body } = await jsonBody(res);

    // Acked so the gateway stops retrying — but the order is untouched.
    expect(status).toBe(200);
    expect(JSON.stringify(body)).toMatch(/order_not_found/);

    const after = await Order.findById(victim._id);
    expect(after?.status).not.toBe(OrderStatus.PAID);
    expect(after?.payment.paidAt ?? null).toBeNull();
    expect(String(after?.organizationId)).toBe(String(otherOrg._id));
    void tripId;
  });

  it("settles an order that DOES belong to the endpoint's organization", async () => {
    const orgId = await makeConfiguredOrg("tripreservations");
    const order = await factoryCreateOrder({});
    await Order.updateOne(
      { _id: order._id },
      { $set: { organizationId: new Types.ObjectId(orgId) } },
    );

    const payload = JSON.stringify(
      buildCheckoutCompleted({
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        amountTotal: Math.round(order.pricing.amount * 100),
      }),
    );
    const signed = signWebhook(payload, "whsec_tripreservations");

    const res = await orgWebhook(
      req("tripreservations", payload, signed),
      params("tripreservations"),
    );
    expect((await jsonBody(res)).status).toBe(200);
    const after = await Order.findById(order._id);
    expect(after?.status).toBe(OrderStatus.PAID);
  });
});

/* ------------------------------------------------------------------ *
 * Each endpoint resolves the provider IT serves
 *
 * A brand may enable two providers — TripReservations takes PayPal and is
 * adding its own Stripe account. Its PayPal deliveries arrive on the PayPal
 * endpoint and its Stripe deliveries on the Stripe one, whichever provider
 * is its default. Each endpoint therefore asks for its own provider's
 * gateway; resolving the brand's DEFAULT turned away every delivery for the
 * other one. The request is honoured only for an ENABLED provider, so a
 * single-provider brand resolves exactly what it always did.
 * ------------------------------------------------------------------ */

/** Every PayPal API call the stub answered, in order. */
let paypalCalls: { url: string; body: unknown }[] = [];
/** What PayPal's verify-webhook-signature answers. */
let paypalVerdict = "SUCCESS";
const paypalEnvKeys: string[] = [];

function stubPayPal() {
  paypalCalls = [];
  paypalVerdict = "SUCCESS";
  _setPayPalFetchForTesting((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body ? String(init.body) : "";
    paypalCalls.push({ url, body: raw.startsWith("{") ? JSON.parse(raw) : raw });
    const reply = url.includes("/v1/oauth2/token")
      ? { access_token: "tok", expires_in: 3600 }
      : url.includes("/v1/notifications/verify-webhook-signature")
        ? { verification_status: paypalVerdict }
        : url.includes("/capture")
          ? { id: "PP-ORDER-1", status: "COMPLETED" }
          : {};
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch);
}

/** PayPal credentials for `slug`, from the environment — how this
 *  deployment configures a brand's PayPal account. */
function paypalEnv(slug: string) {
  const prefix = `ORG_${slug.toUpperCase()}_PAYPAL_`;
  const values = {
    [`${prefix}CLIENT_ID`]: `client-${slug}`,
    [`${prefix}CLIENT_SECRET`]: `secret-${slug}`,
    [`${prefix}WEBHOOK_ID`]: `WEBHOOK-${slug}`,
    [`${prefix}SANDBOX`]: "true",
  };
  Object.assign(process.env, values);
  paypalEnvKeys.push(...Object.keys(values));
}

async function stripeVault(orgId: string, slug: string) {
  await putSecret({
    organizationId: orgId,
    provider: CredentialProvider.STRIPE,
    field: CredentialField.SECRET_KEY,
    value: `sk_live_${slug}`,
  });
  await putSecret({
    organizationId: orgId,
    provider: CredentialProvider.STRIPE,
    field: CredentialField.WEBHOOK_SECRET,
    value: `whsec_${slug}`,
  });
}

/** An organization on `provider` by default, with `enabled` providers, and
 *  credentials for each one it enables. */
async function makeBrand(
  slug: string,
  provider: PaymentGatewayKey,
  enabled: PaymentGatewayKey[] = [],
): Promise<string> {
  const doc = await Organization.create({
    slug,
    name: slug,
    brandName: `${slug} brand`,
    isDefault: false,
    payments: { provider, enabledProviders: enabled },
  });
  const id = String(doc._id as Types.ObjectId);
  const uses = enabled.length > 0 ? enabled : [provider];
  if (uses.includes(PaymentGatewayKey.PAYPAL)) paypalEnv(slug);
  if (uses.includes(PaymentGatewayKey.STRIPE)) await stripeVault(id, slug);
  return id;
}

/** A PayPal delivery as PayPal sends it: the five transmission headers. */
function paypalReq(slug: string, event: Record<string, unknown>) {
  return new Request(`http://localhost/api/webhooks/paypal/${slug}`, {
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      "paypal-transmission-id": "tx-1",
      "paypal-transmission-time": "2026-10-10T00:00:00Z",
      "paypal-cert-url": "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT",
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-transmission-sig": "sig",
    }),
    body: JSON.stringify(event),
  }) as never;
}

function paypalApproved(orderId: string) {
  return {
    id: `WH-APPROVED-${orderId}`,
    event_type: "CHECKOUT.ORDER.APPROVED",
    create_time: "2026-10-10T00:00:00Z",
    resource: { id: "PP-ORDER-1", status: "APPROVED", purchase_units: [{ custom_id: orderId }] },
  };
}

function paypalCaptureCompleted(orderId: string, value = "199.50") {
  return {
    id: `WH-COMPLETED-${orderId}`,
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    create_time: "2026-10-10T00:00:00Z",
    resource: {
      id: "CAP-1",
      status: "COMPLETED",
      custom_id: orderId,
      amount: { currency_code: "USD", value },
      supplementary_data: { related_ids: { order_id: "PP-ORDER-1" } },
    },
  };
}

async function orderOf(orgId: string) {
  return factoryCreateOrder({ organizationId: new Types.ObjectId(orgId) });
}

function signedCheckout(order: Awaited<ReturnType<typeof orderOf>>, slug: string) {
  const payload = JSON.stringify(
    buildCheckoutCompleted({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      amountTotal: Math.round(order.pricing.amount * 100),
    }),
  );
  return { payload, signature: signWebhook(payload, `whsec_${slug}`) };
}

describe("the PayPal endpoint uses the brand's PayPal gateway, whatever its default", () => {
  beforeEach(() => stubPayPal());
  afterEach(() => {
    _setPayPalFetchForTesting(null);
    for (const key of paypalEnvKeys.splice(0)) delete process.env[key];
  });

  it("captures an APPROVED order for a brand on Stripe by default with PayPal also enabled", async () => {
    const orgId = await makeBrand("stripefirst", PaymentGatewayKey.STRIPE, [
      PaymentGatewayKey.STRIPE,
      PaymentGatewayKey.PAYPAL,
    ]);
    const order = await orderOf(orgId);

    const res = await paypalOrgWebhook(
      paypalReq("stripefirst", paypalApproved(String(order._id))),
      params("stripefirst"),
    );
    const { status, body } = await jsonBody<{ data: { captured?: boolean } }>(res);
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.data.captured).toBe(true);
    // Verified with THIS brand's PayPal webhook id, then captured on PayPal.
    const verify = paypalCalls.find((c) => c.url.includes("verify-webhook-signature"));
    expect((verify!.body as { webhook_id: string }).webhook_id).toBe("WEBHOOK-stripefirst");
    expect(paypalCalls.some((c) => c.url.endsWith("/v2/checkout/orders/PP-ORDER-1/capture"))).toBe(
      true,
    );
    // Approval is not payment: the order is not PAID until the capture lands.
    expect((await Order.findById(order._id))?.status).not.toBe(OrderStatus.PAID);
  });

  it("settles that brand's order on PAYMENT.CAPTURE.COMPLETED", async () => {
    const orgId = await makeBrand("stripefirst", PaymentGatewayKey.STRIPE, [
      PaymentGatewayKey.STRIPE,
      PaymentGatewayKey.PAYPAL,
    ]);
    const order = await orderOf(orgId);

    const res = await paypalOrgWebhook(
      paypalReq("stripefirst", paypalCaptureCompleted(String(order._id))),
      params("stripefirst"),
    );
    expect((await jsonBody(res)).status).toBe(200);
    const paid = await Order.findById(order._id);
    expect(paid?.status).toBe(OrderStatus.PAID);
    expect(paid?.payment.amountReceived).toBe(199.5);
  });

  it("keeps a PayPal-only brand exactly as it was — captured, then settled", async () => {
    const orgId = await makeBrand("paypalonly", PaymentGatewayKey.PAYPAL);
    const order = await orderOf(orgId);

    const approved = await paypalOrgWebhook(
      paypalReq("paypalonly", paypalApproved(String(order._id))),
      params("paypalonly"),
    );
    expect((await jsonBody<{ data: { captured?: boolean } }>(approved)).body.data.captured).toBe(true);

    const completed = await paypalOrgWebhook(
      paypalReq("paypalonly", paypalCaptureCompleted(String(order._id))),
      params("paypalonly"),
    );
    expect((await jsonBody(completed)).status).toBe(200);
    expect((await Order.findById(order._id))?.status).toBe(OrderStatus.PAID);
  });

  it("answers a Stripe-only brand's PayPal endpoint with the same flat 404 as an unknown one", async () => {
    await makeConfiguredOrg("tripreservations");
    const res = await paypalOrgWebhook(
      paypalReq("tripreservations", paypalCaptureCompleted(new Types.ObjectId().toString())),
      params("tripreservations"),
    );
    const { status, body } = await jsonBody(res);
    expect(status).toBe(404);
    expect(JSON.stringify(body)).toMatch(/unknown endpoint/i);
    expect(paypalCalls).toHaveLength(0);
  });

  it("refuses a delivery PayPal does not verify, and settles nothing", async () => {
    const orgId = await makeBrand("paypalonly", PaymentGatewayKey.PAYPAL);
    const order = await orderOf(orgId);
    paypalVerdict = "FAILURE";

    const res = await paypalOrgWebhook(
      paypalReq("paypalonly", paypalCaptureCompleted(String(order._id))),
      params("paypalonly"),
    );
    expect((await jsonBody(res)).status).toBe(400);
    expect((await Order.findById(order._id))?.status).not.toBe(OrderStatus.PAID);
  });

  it("never settles another brand's order, however correctly signed", async () => {
    await makeBrand("paypalonly", PaymentGatewayKey.PAYPAL);
    const otherOrgId = await makeBrand("otherbrand", PaymentGatewayKey.PAYPAL);
    const victim = await orderOf(otherOrgId);

    const res = await paypalOrgWebhook(
      paypalReq("paypalonly", paypalCaptureCompleted(String(victim._id))),
      params("paypalonly"),
    );
    const { status, body } = await jsonBody(res);
    expect(status).toBe(200);
    expect(JSON.stringify(body)).toMatch(/order_not_found/);
    expect((await Order.findById(victim._id))?.status).not.toBe(OrderStatus.PAID);
  });
});

describe("the Stripe endpoint uses the brand's Stripe gateway, whatever its default", () => {
  beforeEach(() => stubPayPal());
  afterEach(() => {
    _setPayPalFetchForTesting(null);
    for (const key of paypalEnvKeys.splice(0)) delete process.env[key];
  });

  it("verifies a signed Stripe event for a brand on PayPal by default with Stripe also enabled", async () => {
    const orgId = await makeBrand("paypalfirst", PaymentGatewayKey.PAYPAL, [
      PaymentGatewayKey.PAYPAL,
      PaymentGatewayKey.STRIPE,
    ]);
    const order = await orderOf(orgId);
    const { payload, signature } = signedCheckout(order, "paypalfirst");

    const res = await orgWebhook(req("paypalfirst", payload, signature), params("paypalfirst"));
    const { status, body } = await jsonBody(res);
    expect(status, JSON.stringify(body)).toBe(200);
    expect((await Order.findById(order._id))?.status).toBe(OrderStatus.PAID);
    // Verified locally against the brand's Stripe secret — PayPal never asked.
    expect(paypalCalls).toHaveLength(0);
  });

  it("still rejects that brand's event when it is signed with any other secret", async () => {
    const orgId = await makeBrand("paypalfirst", PaymentGatewayKey.PAYPAL, [
      PaymentGatewayKey.PAYPAL,
      PaymentGatewayKey.STRIPE,
    ]);
    const order = await orderOf(orgId);
    const { payload } = signedCheckout(order, "paypalfirst");

    const res = await orgWebhook(
      req("paypalfirst", payload, signWebhook(payload, process.env.STRIPE_WEBHOOK_SECRET!)),
      params("paypalfirst"),
    );
    expect((await jsonBody(res)).status).toBe(400);
    expect((await Order.findById(order._id))?.status).not.toBe(OrderStatus.PAID);
  });

  it("answers a PayPal-only brand's Stripe endpoint with the same flat 404 as an unknown one", async () => {
    const orgId = await makeBrand("paypalonly", PaymentGatewayKey.PAYPAL);
    const order = await orderOf(orgId);
    const { payload, signature } = signedCheckout(order, "paypalonly");

    const res = await orgWebhook(req("paypalonly", payload, signature), params("paypalonly"));
    const { status, body } = await jsonBody(res);
    expect(status).toBe(404);
    expect(JSON.stringify(body)).toMatch(/unknown endpoint/i);
    expect((await Order.findById(order._id))?.status).not.toBe(OrderStatus.PAID);
  });

  it("keeps a Stripe-only brand exactly as it was", async () => {
    const orgId = await makeConfiguredOrg("tripreservations");
    const order = await orderOf(orgId);
    const { payload, signature } = signedCheckout(order, "tripreservations");

    const res = await orgWebhook(req("tripreservations", payload, signature), params("tripreservations"));
    expect((await jsonBody(res)).status).toBe(200);
    expect((await Order.findById(order._id))?.status).toBe(OrderStatus.PAID);
  });
});
