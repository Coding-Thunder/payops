import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _setPayPalFetchForTesting,
  createPayPalGateway,
  supportsCapture,
} from "@/server/payments/gateways/paypal";

/**
 * PayPal gateway.
 *
 * The properties pinned here are the ones where being wrong moves money or
 * accepts a forged instruction:
 *
 *   - APPROVED is NOT paid. PayPal separates approval from capture; treating
 *     approval as payment would mark orders paid that were never charged.
 *   - a webhook is only trusted after PayPal itself says SUCCESS. There is no
 *     signing secret to check locally, so a missing or negative verdict must
 *     be fatal.
 *   - cert_url is attacker-controlled input that we hand to PayPal, so it
 *     must be constrained to paypal.com.
 */

const CREDS = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  webhookId: "TESTWEBHOOKID",
};

const gateway = createPayPalGateway(() => CREDS);

/** Records every request and replies from a scripted route table. */
function mockFetch(routes: Record<string, unknown>, status = 200) {
  const calls: { url: string; method: string; body: unknown; headers: Record<string, string> }[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body).startsWith("{") ? String(init.body) : "{}") : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const payload = key ? routes[key] : {};
    return new Response(JSON.stringify(payload), {
      status: key ? status : 200,
      headers: { "content-type": "application/json" },
    });
  });
  _setPayPalFetchForTesting(impl as unknown as typeof fetch);
  return { calls, impl };
}

const OAUTH = { "/v1/oauth2/token": { access_token: "tok_123", expires_in: 3600 } };

function ppHeaders(overrides: Record<string, string | null> = {}) {
  const base: Record<string, string> = {
    "paypal-transmission-id": "tx-1",
    "paypal-transmission-time": "2026-08-10T00:00:00Z",
    "paypal-cert-url": "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-transmission-sig": "sig",
  };
  const merged = { ...base, ...overrides };
  return {
    get: (n: string) => {
      const v = merged[n.toLowerCase()];
      return v === null || v === undefined ? null : v;
    },
  };
}

beforeEach(() => _setPayPalFetchForTesting(null));
afterEach(() => _setPayPalFetchForTesting(null));

describe("createSession", () => {
  it("creates an order and returns the approval URL", async () => {
    const { calls } = mockFetch({
      ...OAUTH,
      "/v2/checkout/orders": {
        id: "5O190127TN364715T",
        status: "PAYER_ACTION_REQUIRED",
        links: [
          { rel: "self", href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/5O1" },
          { rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=5O1" },
        ],
      },
    });

    const session = await gateway.createSession({
      orderId: "order123",
      orderNumber: "TR-0001",
      amount: 249.99,
      currency: "GBP",
      customer: { name: "Ada", email: "ada@x.test", phone: "+1" },
      productName: "Rental",
      description: "Pick-up …",
      successUrl: "https://x.test/pay/success",
      cancelUrl: "https://x.test/pay/cancelled",
      expiresAt: new Date("2026-08-11T00:00:00Z"),
      metadata: { orderId: "order123", appName: "Trip Reservations" },
    });

    expect(session.sessionId).toBe("5O190127TN364715T");
    expect(session.url).toBe("https://www.sandbox.paypal.com/checkoutnow?token=5O1");

    const create = calls.find((c) => c.url.includes("/v2/checkout/orders"))!;
    const body = create.body as {
      intent: string;
      purchase_units: { custom_id: string; amount: { currency_code: string; value: string } }[];
    };
    expect(body.intent).toBe("CAPTURE");
    // custom_id is how the order is recovered on every later webhook —
    // PayPal has no client_reference_id.
    expect(body.purchase_units[0]!.custom_id).toBe("order123");
    expect(body.purchase_units[0]!.amount).toEqual({
      currency_code: "GBP",
      value: "249.99",
    });
    // Stable request id makes a repeat create return the same order rather
    // than a second one the customer could also pay.
    expect(create.headers["PayPal-Request-Id"]).toBe("order:order123:checkout");
  });

  it("reuses the OAuth token across calls", async () => {
    const { calls } = mockFetch({
      ...OAUTH,
      "/v2/checkout/orders": { id: "o1", links: [{ rel: "approve", href: "https://x" }] },
    });
    const input = {
      orderId: "o", orderNumber: "n", amount: 10, currency: "USD",
      customer: { name: "a", email: "a@x.test", phone: "" },
      productName: "p", description: "d",
      successUrl: "https://x/s", cancelUrl: "https://x/c",
      expiresAt: new Date(), metadata: {},
    };
    await gateway.createSession(input);
    await gateway.createSession(input);
    expect(calls.filter((c) => c.url.includes("/v1/oauth2/token"))).toHaveLength(1);
  });
});

describe("verifyWebhook — authenticity", () => {
  const captureEvent = {
    id: "WH-1",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    create_time: "2026-08-10T00:00:00Z",
    resource: {
      id: "CAP-1",
      custom_id: "order123",
      amount: { currency_code: "GBP", value: "249.99" },
      supplementary_data: { related_ids: { order_id: "5O1" } },
    },
  };

  it("accepts an event PayPal confirms", async () => {
    mockFetch({
      ...OAUTH,
      "/v1/notifications/verify-webhook-signature": { verification_status: "SUCCESS" },
    });
    const event = await gateway.verifyWebhook(JSON.stringify(captureEvent), ppHeaders());
    expect(event.type).toBe("checkout.completed");
    expect(event.orderId).toBe("order123");
    expect(event.sessionId).toBe("5O1");
    expect(event.amountTotalMinor).toBe(24999);
  });

  it("REJECTS an event PayPal does not confirm", async () => {
    mockFetch({
      ...OAUTH,
      "/v1/notifications/verify-webhook-signature": { verification_status: "FAILURE" },
    });
    await expect(
      gateway.verifyWebhook(JSON.stringify(captureEvent), ppHeaders()),
    ).rejects.toThrow(/verification failed/i);
  });

  it("rejects a delivery missing transmission headers", async () => {
    mockFetch({ ...OAUTH });
    await expect(
      gateway.verifyWebhook(
        JSON.stringify(captureEvent),
        ppHeaders({ "paypal-transmission-sig": null }),
      ),
    ).rejects.toThrow(/missing transmission headers/i);
  });

  it("rejects a cert_url that is not on paypal.com", async () => {
    // cert_url comes from the request and is handed to PayPal's verifier.
    // An arbitrary host would point verification at attacker infrastructure.
    mockFetch({ ...OAUTH });
    await expect(
      gateway.verifyWebhook(
        JSON.stringify(captureEvent),
        ppHeaders({ "paypal-cert-url": "https://evil.example.com/cert" }),
      ),
    ).rejects.toThrow(/not a paypal\.com URL/i);
  });

  it("passes OUR webhook id to the verifier", async () => {
    const { calls } = mockFetch({
      ...OAUTH,
      "/v1/notifications/verify-webhook-signature": { verification_status: "SUCCESS" },
    });
    await gateway.verifyWebhook(JSON.stringify(captureEvent), ppHeaders());
    const verify = calls.find((c) => c.url.includes("verify-webhook-signature"))!;
    expect((verify.body as { webhook_id: string }).webhook_id).toBe("TESTWEBHOOKID");
  });
});

describe("verifyWebhook — approval is not payment", () => {
  it("does NOT map CHECKOUT.ORDER.APPROVED to completed", async () => {
    // The money-safety property. Approval authorises a capture; nothing has
    // been charged. Mapping it to checkout.completed would mark the order
    // PAID before any money moved.
    mockFetch({
      ...OAUTH,
      "/v1/notifications/verify-webhook-signature": { verification_status: "SUCCESS" },
    });
    const approved = {
      id: "WH-2",
      event_type: "CHECKOUT.ORDER.APPROVED",
      resource: { id: "5O1", custom_id: "order123" },
    };
    const event = await gateway.verifyWebhook(JSON.stringify(approved), ppHeaders());
    expect(event.type).not.toBe("checkout.completed");
    expect(event.type).toBe("unhandled");
    expect(event.sessionId).toBe("5O1");
  });

  it("maps refunds and disputes to their lifecycle events", async () => {
    mockFetch({
      ...OAUTH,
      "/v1/notifications/verify-webhook-signature": { verification_status: "SUCCESS" },
    });
    const cases: [string, string][] = [
      ["PAYMENT.CAPTURE.REFUNDED", "refund.created"],
      ["PAYMENT.CAPTURE.DENIED", "payment.failed"],
      ["CUSTOMER.DISPUTE.CREATED", "dispute.created"],
      ["CUSTOMER.DISPUTE.RESOLVED", "dispute.closed"],
    ];
    for (const [paypalType, expected] of cases) {
      const e = await gateway.verifyWebhook(
        JSON.stringify({ id: "WH", event_type: paypalType, resource: {} }),
        ppHeaders(),
      );
      expect(e.type, paypalType).toBe(expected);
    }
  });
});

describe("getSessionStatus", () => {
  it("reports APPROVED as open and UNPAID, never paid", async () => {
    mockFetch({
      ...OAUTH,
      "/v2/checkout/orders/": {
        status: "APPROVED",
        purchase_units: [{ amount: { currency_code: "GBP", value: "249.99" } }],
      },
    });
    const s = await gateway.getSessionStatus("5O1");
    expect(s.status).toBe("open");
    expect(s.paymentStatus).toBe("unpaid");
  });

  it("reports a completed capture as paid", async () => {
    mockFetch({
      ...OAUTH,
      "/v2/checkout/orders/": {
        status: "COMPLETED",
        purchase_units: [
          {
            amount: { currency_code: "GBP", value: "249.99" },
            payments: { captures: [{ id: "CAP-1", status: "COMPLETED" }] },
          },
        ],
      },
    });
    const s = await gateway.getSessionStatus("5O1");
    expect(s.status).toBe("complete");
    expect(s.paymentStatus).toBe("paid");
    expect(s.paymentIntentId).toBe("CAP-1");
    expect(s.amountTotalMinor).toBe(24999);
  });
});

describe("capability and configuration", () => {
  it("advertises capture support; Stripe-shaped gateways would not", async () => {
    expect(supportsCapture(gateway)).toBe(true);
  });

  it("is disabled without a webhook id — deliveries could not be verified", () => {
    const g = createPayPalGateway(() => ({ ...CREDS, webhookId: "" }));
    expect(g.enabled).toBe(false);
  });

  it("does not leak the client id in an auth failure message", async () => {
    mockFetch({ "/v1/oauth2/token": { error: "invalid_client" } }, 401);
    const err = await gateway
      .getSessionStatus("x")
      .catch((e: Error) => e.message);
    expect(String(err)).not.toContain("test-client-id");
    expect(String(err)).not.toContain("test-client-secret");
  });
});
