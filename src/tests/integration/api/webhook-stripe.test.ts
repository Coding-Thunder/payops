import { beforeEach, describe, expect, it } from "vitest";

import { POST as webhookRoute } from "@/app/api/webhooks/stripe/route";
import { AuditAction, OrderStatus } from "@/lib/constants/enums";
import { AuditLog, Order } from "@/server/db/models";
import { createOrder as factoryCreateOrder } from "@/tests/factories/order.factory";
import {
  completedWebhook,
  expiredWebhook,
} from "@/tests/fixtures/webhook.fixture";
import { signWebhook } from "@/tests/factories/stripe-event.factory";
import { ensureMongo } from "@/tests/utils/db";

/**
 * /api/webhooks/stripe — verifies the HTTP route end-to-end:
 *
 *   - rejects a missing Stripe-Signature header with 400 BAD_REQUEST
 *   - rejects an invalid signature even when the body parses cleanly
 *   - accepts a properly signed event and runs the side effects (order
 *     transitions + audit rows)
 *   - returns 200 for duplicate deliveries so Stripe stops retrying
 *
 * Signature generation uses the same HMAC scheme Stripe employs; the
 * real `Stripe.webhooks.constructEvent` in our stub validates it.
 */

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

function buildSignedRequest(payload: string, signature?: string) {
  const headers = new Headers({
    "content-type": "application/json",
  });
  if (signature) headers.set("stripe-signature", signature);
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers,
    body: payload,
  });
}

beforeEach(async () => {
  await ensureMongo();
});

describe("POST /api/webhooks/stripe", () => {
  it("rejects requests without a Stripe-Signature header with 400", async () => {
    const res = await webhookRoute(
      buildSignedRequest(JSON.stringify({ type: "ping" })) as never,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("rejects an invalid signature with 400", async () => {
    const payload = JSON.stringify({ type: "checkout.session.completed" });
    const res = await webhookRoute(
      buildSignedRequest(payload, "t=1,v1=deadbeef") as never,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/Invalid signature/i);

    expect(
      await AuditLog.countDocuments({
        action: AuditAction.WEBHOOK_FAILED,
        "metadata.reason": "invalid_signature",
      }),
    ).toBe(1);
  });

  it("processes a properly signed checkout.session.completed and returns 200", async () => {
    const order = await factoryCreateOrder({});
    const event = completedWebhook({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      amount: 199.5,
    });
    const payload = JSON.stringify(event);
    const sig = signWebhook(payload, WEBHOOK_SECRET);

    const res = await webhookRoute(
      buildSignedRequest(payload, sig) as never,
    );
    expect(res.status).toBe(200);

    const updated = await Order.findById(order._id);
    expect(updated?.status).toBe(OrderStatus.PAID);
    expect(updated?.payment.processedWebhookEventIds).toContain(event.id);
  });

  it("returns 200 (NOT 4xx) on a duplicate signed delivery so Stripe stops retrying", async () => {
    const order = await factoryCreateOrder({});
    const event = completedWebhook({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
    });
    const payload = JSON.stringify(event);
    const sig = signWebhook(payload, WEBHOOK_SECRET);

    const first = await webhookRoute(
      buildSignedRequest(payload, sig) as never,
    );
    const second = await webhookRoute(
      buildSignedRequest(payload, sig) as never,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.data.duplicate).toBe(true);
  });

  it("processes checkout.session.expired and marks order EXPIRED", async () => {
    const order = await factoryCreateOrder({});
    const event = expiredWebhook({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
    });
    const payload = JSON.stringify(event);
    const sig = signWebhook(payload, WEBHOOK_SECRET);

    const res = await webhookRoute(
      buildSignedRequest(payload, sig) as never,
    );
    expect(res.status).toBe(200);

    const updated = await Order.findById(order._id);
    expect(updated?.status).toBe(OrderStatus.EXPIRED);
  });
});
