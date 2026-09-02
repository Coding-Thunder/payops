import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as paypalWebhook } from "@/app/api/webhooks/paypal/route";
import {
  AuditAction,
  OrderStatus,
  PaymentGatewayKey,
} from "@/lib/constants/enums";
import { AuditLog, Order, ProcessedWebhookEvent } from "@/server/db/models";
import { _setPayPalFetchForTesting } from "@/server/payments/gateways/paypal";
import { createOrder } from "@/tests/factories/order.factory";
import { ensureMongo } from "@/tests/utils/db";
import { setEnabledProviders, TEST_ORG_SLUG } from "@/tests/utils/organization";

/**
 * /api/webhooks/paypal — the HTTP route, end to end against a stubbed PayPal.
 *
 * Nothing here talks to PayPal. `_setPayPalFetchForTesting` replaces the
 * adapter's HTTP layer, so the OAuth call, the signature-verification call
 * and the capture call are all answered locally. What is genuinely exercised
 * is everything this route decides: whether PayPal is switched on, whether a
 * delivery is authentic, what an approval means as opposed to a capture, and
 * whether the same event delivered twice settles an order twice.
 *
 * The three behaviours worth stating plainly, because getting any of them
 * wrong loses money:
 *
 *   - a delivery whose verification does not come back SUCCESS is refused
 *   - CHECKOUT.ORDER.APPROVED captures, it does not mark anything paid
 *   - only PAYMENT.CAPTURE.COMPLETED moves an order to PAID
 */

const ORG_ENV = {
  ORG_HIMANSHU_PAYPAL_CLIENT_ID: "test-client-id",
  ORG_HIMANSHU_PAYPAL_CLIENT_SECRET: "test-client-secret",
  ORG_HIMANSHU_PAYPAL_WEBHOOK_ID: "test-webhook-id",
} as const;

/** Every header PayPal signs a delivery with. Their values are not checked
 *  locally — PayPal checks them — but their PRESENCE is what the adapter
 *  requires before it will attempt verification at all. */
function paypalHeaders(): Headers {
  return new Headers({
    "content-type": "application/json",
    "paypal-transmission-id": "tx-1",
    "paypal-transmission-time": "2026-08-27T09:00:00Z",
    "paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/CERT",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-transmission-sig": "sig",
  });
}

function request(body: unknown, headers = paypalHeaders()) {
  return new Request("http://localhost/api/webhooks/paypal", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function captureCompleted(orderId: string, eventId = "WH-CAPTURE-1") {
  return {
    id: eventId,
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    create_time: "2026-08-27T09:00:00Z",
    resource: {
      id: "CAPTURE-1",
      status: "COMPLETED",
      amount: { value: "150.00", currency_code: "USD" },
      supplementary_data: { related_ids: { order_id: orderId } },
    },
  };
}

function orderApproved(orderId: string, eventId = "WH-APPROVED-1") {
  return {
    id: eventId,
    event_type: "CHECKOUT.ORDER.APPROVED",
    create_time: "2026-08-27T09:00:00Z",
    resource: { id: orderId, status: "APPROVED" },
  };
}

/**
 * Stub PayPal. `verification` decides what the signature-verification call
 * answers; `onCapture` records or rejects a capture attempt.
 */
/**
 * How the stubbed capture call fails.
 *
 *   "already"   PayPal's real 422 envelope for a replayed APPROVED. Safe.
 *   "declined"  422, buyer's instrument refused. Terminal — retrying is futile.
 *   "transient" 503. MUST be retried, so the route must not answer 2xx.
 *   "network"   the fetch itself rejects (socket timeout / abort).
 */
type CaptureFailure = "already" | "declined" | "transient" | "network";

function stubPayPal(opts: {
  verification?: "SUCCESS" | "FAILURE";
  captureFails?: boolean;
  captureFailure?: CaptureFailure;
} = {}) {
  const calls: string[] = [];
  _setPayPalFetchForTesting((async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);

    if (url.includes("/v1/oauth2/token")) {
      return new Response(
        JSON.stringify({ access_token: "stub-token", expires_in: 32400 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/v1/notifications/verify-webhook-signature")) {
      return new Response(
        JSON.stringify({ verification_status: opts.verification ?? "SUCCESS" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/capture")) {
      const mode: CaptureFailure | null = opts.captureFailure
        ?? (opts.captureFails ? "already" : null);
      if (mode === "network") {
        throw new Error("socket hang up");
      }
      if (mode === "transient") {
        return new Response(
          JSON.stringify({ name: "INTERNAL_SERVER_ERROR", debug_id: "dbg-1" }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      if (mode === "declined") {
        // PayPal's real envelope shape: the issue lives in details[].issue.
        return new Response(
          JSON.stringify({
            name: "UNPROCESSABLE_ENTITY",
            details: [{ issue: "INSTRUMENT_DECLINED" }],
            debug_id: "dbg-2",
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        );
      }
      if (mode === "already") {
        return new Response(
          JSON.stringify({
            name: "UNPROCESSABLE_ENTITY",
            details: [{ issue: "ORDER_ALREADY_CAPTURED" }],
            debug_id: "dbg-3",
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ id: "ORDER-1", status: "COMPLETED" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch);
  return calls;
}

beforeEach(async () => {
  await ensureMongo();
  for (const [k, v] of Object.entries(ORG_ENV)) vi.stubEnv(k, v);
  // The deployment default is Stripe-only; each test opts in explicitly so
  // the disabled case is exercised rather than assumed.
  await setEnabledProviders([PaymentGatewayKey.STRIPE]);
});

afterEach(() => {
  _setPayPalFetchForTesting(null);
  vi.unstubAllEnvs();
});

describe("when PayPal is not an enabled provider", () => {
  it("refuses with 503 and processes nothing", async () => {
    stubPayPal();
    const res = await paypalWebhook(request(captureCompleted("ORDER-X")) as never);

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("PROVIDER_DISABLED");
    expect(await ProcessedWebhookEvent.countDocuments({})).toBe(0);
  });

  it("never answers 200 — an ack would stop PayPal retrying a real event", async () => {
    stubPayPal();
    const res = await paypalWebhook(request(captureCompleted("ORDER-X")) as never);
    expect(res.status).not.toBe(200);
  });
});

describe("when PayPal is enabled", () => {
  beforeEach(async () => {
    await setEnabledProviders(
      [PaymentGatewayKey.STRIPE, PaymentGatewayKey.PAYPAL],
      PaymentGatewayKey.STRIPE,
    );
  });

  it("rejects a delivery PayPal does not vouch for", async () => {
    stubPayPal({ verification: "FAILURE" });
    const res = await paypalWebhook(request(captureCompleted("ORDER-X")) as never);

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("BAD_REQUEST");

    const audit = await AuditLog.findOne({ action: AuditAction.WEBHOOK_FAILED }).lean<{
      metadata?: { reason?: string; gateway?: string };
    }>();
    expect(audit?.metadata?.reason).toBe("invalid_signature");
    expect(audit?.metadata?.gateway).toBe(PaymentGatewayKey.PAYPAL);
  });

  it("rejects a delivery missing the transmission headers", async () => {
    stubPayPal();
    const bare = new Headers({ "content-type": "application/json" });
    const res = await paypalWebhook(request(captureCompleted("ORDER-X"), bare) as never);
    expect(res.status).toBe(400);
  });

  it("moves an order to PAID on PAYMENT.CAPTURE.COMPLETED", async () => {
    const order = await createOrder({
      status: OrderStatus.PAYMENT_PENDING,
      payment: {
        gateway: PaymentGatewayKey.PAYPAL,
        stripeSessionId: "PAYPAL-ORDER-1",
      },
    });
    stubPayPal();

    const res = await paypalWebhook(request(captureCompleted("PAYPAL-ORDER-1")) as never);
    expect(res.status).toBe(200);

    const settled = await Order.findById(order._id).lean<{
      status: OrderStatus;
      payment?: { gateway?: string; amountReceived?: number; paidAt?: Date };
    }>();
    expect(settled?.status).toBe(OrderStatus.PAID);
    expect(settled?.payment?.gateway).toBe(PaymentGatewayKey.PAYPAL);
    expect(settled?.payment?.paidAt).toBeTruthy();
  });

  it("settles once when the same capture is delivered twice", async () => {
    await createOrder({
      status: OrderStatus.PAYMENT_PENDING,
      payment: {
        gateway: PaymentGatewayKey.PAYPAL,
        stripeSessionId: "PAYPAL-ORDER-2",
      },
    });
    stubPayPal();

    const first = await paypalWebhook(request(captureCompleted("PAYPAL-ORDER-2", "WH-DUP")) as never);
    const second = await paypalWebhook(request(captureCompleted("PAYPAL-ORDER-2", "WH-DUP")) as never);

    // Both acked — a 500 on the replay would make PayPal retry forever.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await second.json()).data.duplicate).toBe(true);
    expect(await ProcessedWebhookEvent.countDocuments({ gatewayEventId: "WH-DUP" })).toBe(1);
  });

  it("captures on APPROVED and does NOT mark the order paid", async () => {
    const order = await createOrder({
      status: OrderStatus.PAYMENT_PENDING,
      payment: {
        gateway: PaymentGatewayKey.PAYPAL,
        stripeSessionId: "PAYPAL-ORDER-3",
      },
    });
    const calls = stubPayPal();

    const res = await paypalWebhook(request(orderApproved("PAYPAL-ORDER-3")) as never);
    expect(res.status).toBe(200);
    expect((await res.json()).data.captured).toBe(true);
    expect(calls.some((u) => u.includes("/capture"))).toBe(true);

    // Approval authorises a capture. It is not payment.
    const still = await Order.findById(order._id).lean<{ status: OrderStatus }>();
    expect(still?.status).toBe(OrderStatus.PAYMENT_PENDING);
  });

  it("acks a replayed APPROVED whose capture PayPal rejects", async () => {
    await createOrder({
      status: OrderStatus.PAYMENT_PENDING,
      payment: {
        gateway: PaymentGatewayKey.PAYPAL,
        stripeSessionId: "PAYPAL-ORDER-4",
      },
    });
    stubPayPal({ captureFailure: "already" });

    // PayPal refusing a second capture IS the idempotency guarantee. Retrying
    // cannot help, so the route acknowledges instead of 500-ing.
    const res = await paypalWebhook(request(orderApproved("PAYPAL-ORDER-4")) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { duplicate?: boolean } };
    expect(body.data?.duplicate).toBe(true);
  });

  /**
   * The distinction these three tests pin is the difference between losing a
   * payment and not losing it.
   *
   * Answering 200 tells PayPal to stop redelivering. Before this, EVERY
   * capture exception was swallowed and 200'd, so one transient 503 left an
   * approved order permanently uncaptured — no retry, no alert, and reconcile
   * cannot recover it because PayPal reports an approved-but-uncaptured order
   * as "open" and refuses to capture from there.
   */
  it("returns 502 on a TRANSIENT capture failure so PayPal retries", async () => {
    await createOrder({
      orderNumber: "RT-PP-TRANSIENT",
      payment: { gateway: PaymentGatewayKey.PAYPAL, stripeSessionId: "PAYPAL-ORDER-T1" },
    });
    stubPayPal({ captureFailure: "transient" });

    const res = await paypalWebhook(request(orderApproved("PAYPAL-ORDER-T1")) as never);
    expect(res.status).toBe(502);
  });

  it("returns 502 when the capture call itself throws (timeout / socket)", async () => {
    await createOrder({
      orderNumber: "RT-PP-NETWORK",
      payment: { gateway: PaymentGatewayKey.PAYPAL, stripeSessionId: "PAYPAL-ORDER-T2" },
    });
    stubPayPal({ captureFailure: "network" });

    const res = await paypalWebhook(request(orderApproved("PAYPAL-ORDER-T2")) as never);
    expect(res.status).toBe(502);
  });

  it("acks a TERMINAL decline without claiming the capture succeeded", async () => {
    await createOrder({
      orderNumber: "RT-PP-DECLINED",
      payment: { gateway: PaymentGatewayKey.PAYPAL, stripeSessionId: "PAYPAL-ORDER-T3" },
    });
    stubPayPal({ captureFailure: "declined" });

    const res = await paypalWebhook(request(orderApproved("PAYPAL-ORDER-T3")) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { captured?: boolean; declined?: boolean } };
    expect(body.data?.captured).toBe(false);
    expect(body.data?.declined).toBe(true);
  });

  it("uses the LIVE PayPal host", async () => {
    const calls = stubPayPal();
    await paypalWebhook(request(captureCompleted("PAYPAL-ORDER-5")) as never);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((u) => u.startsWith("https://api-m.paypal.com"))).toBe(true);
    expect(calls.some((u) => u.includes("sandbox"))).toBe(false);
  });

  it("CANNOT be moved to the sandbox host by any environment variable", async () => {
    // This deployment is live-only. The sandbox switch was removed rather
    // than defaulted to false, so setting the variable that used to flip it
    // must now do nothing at all. Asserting the negative is the point: a
    // regression that reintroduced the switch would send live credentials to
    // api-m.sandbox.paypal.com, where they cannot authenticate, and PayPal
    // would appear to "stop working" with nothing in PayPal changed.
    vi.stubEnv("ORG_HIMANSHU_PAYPAL_SANDBOX", "true");
    vi.stubEnv("PAYPAL_SANDBOX", "true");
    const calls = stubPayPal();
    await paypalWebhook(request(captureCompleted("PAYPAL-ORDER-6")) as never);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((u) => u.startsWith("https://api-m.paypal.com"))).toBe(true);
    expect(calls.some((u) => u.includes("sandbox"))).toBe(false);
  });
});

describe("PayPal's environment is decided by PayPal's own configuration", () => {
  /**
   * `payments.sandbox` on the organization is written by the seed from
   * whether the STRIPE secret key starts with `sk_test`. It used to be OR'd
   * into PayPal's host selection, so a Stripe test key silently moved live
   * PayPal credentials to the sandbox host — and being an OR, no PayPal
   * variable could move them back.
   */
  it("ignores the Stripe-derived sandbox flag on the organization", async () => {
    const { Organization } = await import("@/server/db/models");
    await setEnabledProviders(
      [PaymentGatewayKey.STRIPE, PaymentGatewayKey.PAYPAL],
      PaymentGatewayKey.STRIPE,
    );
    await Organization.updateOne(
      { slug: TEST_ORG_SLUG },
      { $set: { "payments.sandbox": true } },
    );

    const calls = stubPayPal();
    await paypalWebhook(request(captureCompleted("PAYPAL-ORDER-7")) as never);

    expect(calls.every((u) => u.startsWith("https://api-m.paypal.com"))).toBe(true);
  });
});
