import { beforeEach, describe, expect, it } from "vitest";
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
