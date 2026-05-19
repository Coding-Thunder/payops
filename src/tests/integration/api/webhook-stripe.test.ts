import { beforeEach, describe, expect, it } from "vitest";

import { POST as webhookRoute } from "@/app/api/webhooks/stripe/route";
import {
  AuditAction,
  EmailKind,
  OrderStatus,
} from "@/lib/constants/enums";
import {
  AuditLog,
  Order,
  PendingEmail,
  PendingEmailStatus,
  ProcessedWebhookEvent,
} from "@/server/db/models";
import { createOrder as factoryCreateOrder } from "@/tests/factories/order.factory";
// HTTP tests need Stripe-shaped payloads (raw Stripe.Event JSON) because
// they exercise the gateway's verifyWebhook path, which parses Stripe's
// native event types. The normalised fixtures in webhook.fixture.ts are
// for service-level tests that bypass the route.
import {
  buildCheckoutCompleted,
  buildCheckoutExpired,
  signWebhook,
} from "@/tests/factories/stripe-event.factory";
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
    const event = buildCheckoutCompleted({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      amountTotal: 19950,
    });
    const payload = JSON.stringify(event);
    const sig = signWebhook(payload, WEBHOOK_SECRET);

    const res = await webhookRoute(
      buildSignedRequest(payload, sig) as never,
    );
    expect(res.status).toBe(200);

    const updated = await Order.findById(order._id);
    expect(updated?.status).toBe(OrderStatus.PAID);
    // Defense-in-depth array still receives the event id (capped via
    // $slice at -50 so it stays bounded over the order lifetime).
    expect(updated?.payment.processedWebhookEventIds).toContain(event.id);

    // Durable dedupe collection: the gateway event id is recorded.
    // This is the primary idempotency primitive now.
    const claim = await ProcessedWebhookEvent.findOne({
      gatewayEventId: event.id,
    });
    expect(claim).not.toBeNull();
    expect(claim?.gateway).toBe("STRIPE");

    // Webhook does NOT send mail inline anymore — confirmation lands in
    // the outbox in the same transaction. The post-commit drain is
    // skipped in test mode so we can deterministically observe the row.
    const pending = await PendingEmail.find({
      orderId: order._id,
      kind: EmailKind.PAYMENT_CONFIRMATION,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe(PendingEmailStatus.PENDING);
    expect(pending[0].recipient).toBe(order.customer.email.toLowerCase());
  });

  it("returns 200 (NOT 4xx) on a duplicate signed delivery so Stripe stops retrying", async () => {
    const order = await factoryCreateOrder({});
    const event = buildCheckoutCompleted({
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

    // Duplicate delivery MUST NOT enqueue a second confirmation email
    // — the outbox row from the first delivery is the single source of
    // truth and the drainer retries autonomously.
    const pending = await PendingEmail.find({
      orderId: order._id,
      kind: EmailKind.PAYMENT_CONFIRMATION,
    });
    expect(pending).toHaveLength(1);

    // Exactly one ProcessedWebhookEvent row for this id — the durable
    // dedupe collection is the real idempotency primitive.
    const claims = await ProcessedWebhookEvent.find({
      gatewayEventId: event.id,
    });
    expect(claims).toHaveLength(1);
  });

  it("rejects an oversized body with 413 before signature verification", async () => {
    // 200 KB payload — well over the 64 KB webhook cap.
    const payload = JSON.stringify({ blob: "x".repeat(200 * 1024) });
    const headers = new Headers({
      "content-type": "application/json",
      "content-length": String(payload.length),
      "stripe-signature": "t=1,v1=deadbeef",
    });
    const res = await webhookRoute(
      new Request("http://localhost/api/webhooks/stripe", {
        method: "POST",
        headers,
        body: payload,
      }) as never,
    );
    expect(res.status).toBe(413);
  });

  it("processes checkout.session.expired and marks order EXPIRED", async () => {
    const order = await factoryCreateOrder({});
    const event = buildCheckoutExpired({
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
