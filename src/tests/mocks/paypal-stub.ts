/**
 * In-process stand-in for the PayPal REST API, for the smoke/browser test
 * server only (`PAYOPS_TEST_MODE=smoke`), mirroring the Stripe stub.
 *
 * It lets the full operator journey — Stripe fails, resend through PayPal,
 * the customer pays — run without PayPal credentials or network access. No
 * money can move: nothing here talks to PayPal.
 *
 * Behaviour, kept close to the real API where it matters for PayOps:
 *   - POST /v1/oauth2/token                → a bearer token
 *   - POST /v2/checkout/orders             → a PayPal order; the same
 *     `PayPal-Request-Id` returns the SAME order (PayPal's idempotency)
 *   - POST /v2/checkout/orders/:id/capture → COMPLETED once; a second
 *     capture with a different request id is refused, as PayPal does
 *   - GET  /v2/checkout/orders/:id         → the order's status
 *   - POST /v1/notifications/verify-webhook-signature → SUCCESS. The test
 *     harness posts the webhook deliveries itself.
 */

interface StubOrder {
  id: string;
  status: "PAYER_ACTION_REQUIRED" | "COMPLETED";
  amount: { currency_code: string; value: string };
  customId: string | null;
  captureId: string | null;
  captureRequestId: string | null;
}

export interface PayPalStub {
  fetch: typeof fetch;
  readonly orders: Map<string, StubOrder>;
}

export function createPayPalStub(opts: { appUrl: string }): PayPalStub {
  const orders = new Map<string, StubOrder>();
  const byRequestId = new Map<string, string>();
  let counter = 0;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const orderView = (o: StubOrder) => ({
    id: o.id,
    status: o.status,
    purchase_units: [
      {
        custom_id: o.customId,
        amount: o.amount,
        payments: o.captureId
          ? { captures: [{ id: o.captureId, status: "COMPLETED", amount: o.amount }] }
          : undefined,
      },
    ],
  });

  const stubFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    // The token request is form-encoded; everything else is JSON.
    let body: {
      purchase_units?: Array<{ amount?: StubOrder["amount"]; custom_id?: string }>;
    } | null = null;
    if (typeof init?.body === "string" && init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = null;
      }
    }
    const path = url.pathname;

    if (method === "POST" && path === "/v1/oauth2/token") {
      return json(200, { access_token: "stub-paypal-token", expires_in: 32_400 });
    }

    if (method === "POST" && path === "/v1/notifications/verify-webhook-signature") {
      return json(200, { verification_status: "SUCCESS" });
    }

    if (method === "POST" && path === "/v2/checkout/orders") {
      const requestId = headers.get("paypal-request-id");
      const existing = requestId ? byRequestId.get(requestId) : undefined;
      if (existing) {
        const o = orders.get(existing)!;
        return json(200, { id: o.id, status: o.status, links: approveLinks(o) });
      }
      counter += 1;
      const id = `PAYPAL-STUB-${Date.now().toString(36).toUpperCase()}-${counter}`;
      const unit = body?.purchase_units?.[0];
      const order: StubOrder = {
        id,
        status: "PAYER_ACTION_REQUIRED",
        amount: unit?.amount ?? { currency_code: "USD", value: "0.00" },
        customId: unit?.custom_id ?? null,
        captureId: null,
        captureRequestId: null,
      };
      orders.set(id, order);
      if (requestId) byRequestId.set(requestId, id);
      return json(201, { id, status: order.status, links: approveLinks(order) });
    }

    const capture = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(path);
    if (method === "POST" && capture) {
      const o = orders.get(decodeURIComponent(capture[1]));
      if (!o) return json(404, { name: "RESOURCE_NOT_FOUND" });
      const requestId = headers.get("paypal-request-id");
      if (o.captureId) {
        if (requestId && requestId === o.captureRequestId) return json(200, orderView(o));
        return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] });
      }
      counter += 1;
      o.status = "COMPLETED";
      o.captureId = `CAPTURE-STUB-${counter}`;
      o.captureRequestId = requestId;
      return json(201, orderView(o));
    }

    const get = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(path);
    if (method === "GET" && get) {
      const o = orders.get(decodeURIComponent(get[1]));
      if (!o) return json(404, { name: "RESOURCE_NOT_FOUND" });
      return json(200, orderView(o));
    }

    return json(404, { name: "NOT_STUBBED", path, method });
  };

  function approveLinks(o: StubOrder) {
    return [
      {
        rel: "payer-action",
        href: `${opts.appUrl}/pay/checkout/${o.id}?gateway=paypal`,
      },
    ];
  }

  return { fetch: stubFetch, orders };
}
