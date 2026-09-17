// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  _setPayPalFetchForTesting,
  createPayPalGateway,
} from "@/server/payments/gateways/paypal";
import { createPayPalStub } from "@/tests/mocks/paypal-stub";

/**
 * The browser/smoke server runs the real PayPal adapter against this stub,
 * so the stub must behave the way the adapter relies on PayPal behaving.
 */

afterEach(() => _setPayPalFetchForTesting(null));

const gateway = () =>
  createPayPalGateway(() => ({
    clientId: "stub-client",
    clientSecret: "stub-secret",
    webhookId: "stub-webhook",
    sandbox: true,
  }));

const input = (over: Record<string, unknown> = {}) =>
  ({
    orderId: "order-1",
    orderNumber: "ORD-1",
    amount: 650,
    currency: "USD",
    customer: { name: "Ada", email: "ada@payops.test", phone: "+15555550100" },
    productName: "Budget • Toyota Camry rental",
    description: "Pick-up … Drop-off …",
    successUrl: "http://127.0.0.1:3100/pay/success",
    cancelUrl: "http://127.0.0.1:3100/pay/cancelled",
    expiresAt: new Date(Date.now() + 3600_000),
    metadata: { orderId: "order-1", orderNumber: "ORD-1", appName: "Brand" },
    priceRevision: 1,
    attempt: 1,
    ...over,
  }) as never;

describe("PayPal adapter against the smoke stub", () => {
  it("creates an order at the requested amount, and replays it for the same checkout", async () => {
    const stub = createPayPalStub({ appUrl: "http://127.0.0.1:3100" });
    _setPayPalFetchForTesting(stub.fetch);
    const a = await gateway().createSession(input());
    const again = await gateway().createSession(input());
    const next = await gateway().createSession(input({ attempt: 2 }));
    expect(again.sessionId).toBe(a.sessionId);
    expect(next.sessionId).not.toBe(a.sessionId);
    expect(stub.orders.get(a.sessionId)!.amount).toEqual({ currency_code: "USD", value: "650.00" });
    expect(a.url).toContain(`/pay/checkout/${a.sessionId}`);
  });

  it("captures once and then reports the order paid", async () => {
    const stub = createPayPalStub({ appUrl: "http://127.0.0.1:3100" });
    _setPayPalFetchForTesting(stub.fetch);
    const g = gateway();
    const s = await g.createSession(input());
    expect((await g.getSessionStatus(s.sessionId)).status).toBe("open");
    await g.captureOrder(s.sessionId);
    await g.captureOrder(s.sessionId); // same request id: a replay, not a second charge
    const status = await g.getSessionStatus(s.sessionId);
    expect(status).toMatchObject({ status: "complete", paymentStatus: "paid", amountTotalMinor: 65000 });
  });

  it("verifies a webhook delivery and maps a completed capture", async () => {
    _setPayPalFetchForTesting(createPayPalStub({ appUrl: "http://x" }).fetch);
    const body = JSON.stringify({
      id: "WH-1",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "CAPTURE-1",
        custom_id: "order-1",
        amount: { currency_code: "USD", value: "650.00" },
        supplementary_data: { related_ids: { order_id: "PAYPAL-ORDER-1" } },
      },
    });
    const headers = new Headers({
      "paypal-transmission-id": "t",
      "paypal-transmission-time": new Date().toISOString(),
      "paypal-cert-url": "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT",
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-transmission-sig": "sig",
    });
    const event = await gateway().verifyWebhook(body, headers);
    expect(event).toMatchObject({
      type: "checkout.completed",
      sessionId: "PAYPAL-ORDER-1",
      orderId: "order-1",
      amountTotalMinor: 65000,
    });
  });
});
