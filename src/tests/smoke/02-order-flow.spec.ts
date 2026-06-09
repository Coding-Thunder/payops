import { test, expect } from "@playwright/test";

import {
  buildCompletedEvent,
  getSmokeCreds,
  loginAsApi,
  postSignedWebhook,
} from "./_helpers";

/**
 * End-to-end order lifecycle smoke:
 *
 *   1. Admin logs in (API) and creates an order via /api/orders.
 *   2. The response carries the stub Stripe checkout URL.
 *   3. We POST a properly signed checkout.session.completed webhook
 *      to /api/webhooks/stripe.
 *   4. Re-fetch the order via /api/orders/:id and confirm it transitioned
 *      to PAID and recorded the amount + paidAt.
 *
 * This is the heart of TraceTxn, if it ever breaks, payments are broken.
 */

test.describe("order + payment flow", () => {
  test("admin creates order → webhook flips it to PAID", async ({
    request,
  }) => {
    const { admin } = getSmokeCreds();
    await loginAsApi(request, admin);

    const pickup = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const dropoff = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

    const createRes = await request.post("/api/orders", {
      data: {
        bookingType: "NEW_BOOKING",
        provider: "HERTZ",
        customer: {
          name: "Smoke Customer",
          email: "smoke-customer@tracetxn.test",
          phone: "+15555550100",
        },
        vehicle: { company: "Toyota", type: "Camry" },
        trip: { pickupDate: pickup, dropoffDate: dropoff },
        pricing: { amount: 199.5, currency: "USD" },
        notes: "smoke",
      },
    });
    expect(createRes.status(), await createRes.text()).toBe(201);
    const created = await createRes.json();
    expect(created.ok).toBe(true);
    const orderId = created.data.order.id as string;
    const orderNumber = created.data.order.orderNumber as string;
    const sessionId = created.data.order.payment.stripeSessionId as string;
    expect(created.data.checkoutUrl).toMatch(/^http/);
    expect(sessionId).toMatch(/^cs_test_stub_/);

    // Webhook ⇒ paid
    const event = buildCompletedEvent({
      orderId,
      orderNumber,
      sessionId,
      amount: 199.5,
    });
    const webhook = await postSignedWebhook(request, event);
    expect(webhook.status).toBe(200);

    // Verify final state
    const getRes = await request.get(`/api/orders/${orderId}`);
    expect(getRes.status()).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.data.status).toBe("PAID");
    expect(fetched.data.payment.status).toBe("PAID");
    expect(fetched.data.payment.amountReceived).toBe(199.5);
    expect(fetched.data.payment.paidAt).toBeTruthy();
  });

  test("duplicate webhook delivery is idempotent (still 200, status unchanged)", async ({
    request,
  }) => {
    const { admin } = getSmokeCreds();
    await loginAsApi(request, admin);

    const pickup = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const dropoff = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

    const create = await request.post("/api/orders", {
      data: {
        bookingType: "NEW_BOOKING",
        provider: "HERTZ",
        customer: {
          name: "Dup Customer",
          email: "dup-customer@tracetxn.test",
          phone: "+15555550100",
        },
        vehicle: { company: "Honda", type: "Civic" },
        trip: { pickupDate: pickup, dropoffDate: dropoff },
        pricing: { amount: 50, currency: "USD" },
      },
    });
    const { order } = (await create.json()).data;

    const event = buildCompletedEvent({
      orderId: order.id,
      orderNumber: order.orderNumber,
      sessionId: order.payment.stripeSessionId,
      amount: 50,
    });

    const first = await postSignedWebhook(request, event);
    const second = await postSignedWebhook(request, event);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((second.body as { data: { duplicate: boolean } }).data.duplicate).toBe(
      true,
    );

    const fetched = await request.get(`/api/orders/${order.id}`);
    const json = await fetched.json();
    expect(json.data.status).toBe("PAID");
  });

  test("invalid webhook signature is rejected with 400", async ({ request }) => {
    const res = await request.post("/api/webhooks/stripe", {
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=1,v1=deadbeef",
      },
      data: JSON.stringify({ type: "checkout.session.completed" }),
    });
    expect(res.status()).toBe(400);
  });
});
