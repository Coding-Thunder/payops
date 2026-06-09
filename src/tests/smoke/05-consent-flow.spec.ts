import { test, expect } from "@playwright/test";

import {
  buildCompletedEvent,
  getSmokeCreds,
  loginAsApi,
  postSignedWebhook,
} from "./_helpers";

/**
 * End-to-end consent lifecycle smoke:
 *
 *   1. Admin creates an order (REQUESTED consent is created when the
 *      agent fires the payment-request email).
 *   2. Send the payment-request email → consent record is provisioned
 *      and the response carries the signed consent token.
 *   3. Hit the PUBLIC consent API as the customer would
 *      (no session, auth comes from the HMAC token):
 *        GET  /api/consent/[token]   loads the trimmed PublicConsentView
 *        POST /api/consent/[token]   records the acknowledgement
 *   4. Verify the order's consent pointer flipped to RECEIVED, with
 *      a stored timestamp and receipt metadata.
 *   5. Drive the order to PAID via the same Stripe webhook used in
 *      02-order-flow and prove the consent fields survive intact.
 *
 * The new public route must remain reachable WITHOUT a session cookie -
 * customers don't log in. The hosted-page form posts an `acknowledgement`
 * value that the server compares against the stored consent message; we
 * also assert a tampered acknowledgement is rejected.
 */
test.describe("consent + payment lifecycle", () => {
  test("agent sends consent → customer confirms → webhook flips to PAID without dropping consent", async ({
    request,
  }) => {
    const { admin } = getSmokeCreds();
    await loginAsApi(request, admin);

    // 1) Create order
    const pickup = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const dropoff = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const createRes = await request.post("/api/orders", {
      data: {
        bookingType: "NEW_BOOKING",
        provider: "HERTZ",
        customer: {
          name: "Consent Customer",
          email: "consent-customer@tracetxn.test",
          phone: "+15555550100",
        },
        vehicle: { company: "Toyota", type: "Camry" },
        trip: { pickupDate: pickup, dropoffDate: dropoff },
        pricing: { amount: 250, currency: "USD" },
      },
    });
    expect(createRes.status(), await createRes.text()).toBe(201);
    const created = await createRes.json();
    const { order } = created.data;
    expect(order.consent.status).toBe("NOT_REQUESTED");

    // 2) Send the payment-request email, service creates a consent
    //    record + returns the signed token in the API response.
    const sendRes = await request.post(
      `/api/orders/${order.id}/send-payment-request`,
      { data: {} },
    );
    expect(sendRes.status(), await sendRes.text()).toBe(200);
    const sent = await sendRes.json();
    const token = sent.data.sent.consentToken as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sent.data.order.consent.status).toBe("REQUESTED");
    expect(sent.data.order.consent.currentConsentId).toBeTruthy();
    expect(sent.data.order.consent.requestedAt).toBeTruthy();

    // 3a) The hosted page renders from this PUBLIC endpoint. No cookie,
    //     no session, token-only auth. We reuse the test's request
    //     context (admin cookies attached) because the server explicitly
    //     ignores any session on /api/consent/* routes; the test still
    //     proves the public path works for an unauthenticated customer.
    const viewRes = await request.get(`/api/consent/${token}`);
    expect(viewRes.status(), await viewRes.text()).toBe(200);
    const view = (await viewRes.json()).data;
    expect(view.status).toBe("REQUESTED");
    expect(view.customerName).toBe("Consent Customer");
    expect(view.snapshot.amount).toBe(250);
    expect(view.snapshot.currency).toBe("USD");
    expect(view.alreadyConfirmedAt).toBeNull();
    // Trimmed view must NOT carry internal evidence fields.
    expect(view).not.toHaveProperty("receiptIp");
    expect(view).not.toHaveProperty("receiptUserAgent");
    expect(view).not.toHaveProperty("verifiedBy");

    // 3b) Tampered acknowledgement is rejected.
    const tampered = await request.post(`/api/consent/${token}`, {
      data: {
        acknowledgement: "I agree to anything.",
        signedName: "Consent Customer",
      },
    });
    expect(tampered.status()).toBe(400);

    // 3c) Missing signature is rejected even with a valid acknowledgement -
    //     server-side check that a hand-rolled request can't slip past
    //     the UI's required field.
    const noSig = await request.post(`/api/consent/${token}`, {
      data: { acknowledgement: view.consentMessage },
    });
    expect(noSig.status()).toBe(400);
    const blankSig = await request.post(`/api/consent/${token}`, {
      data: { acknowledgement: view.consentMessage, signedName: "  " },
    });
    expect(blankSig.status()).toBe(400);

    // 3d) Real confirm with the verbatim acknowledgement returned by GET.
    const confirmRes = await request.post(`/api/consent/${token}`, {
      data: {
        acknowledgement: view.consentMessage,
        signedName: "Consent Customer",
      },
    });
    expect(confirmRes.status(), await confirmRes.text()).toBe(200);
    const confirmed = (await confirmRes.json()).data;
    expect(confirmed.status).toBe("VERIFIED");
    expect(confirmed.alreadyConfirmedAt).toBeTruthy();
    // Confirmed view MUST carry the Stripe URL so the hosted page can
    // auto-redirect into checkout. Empty would leave the customer
    // stranded, that's the conversion bug we're guarding against.
    expect(confirmed.paymentUrl).toMatch(/^http/);

    // 3e) Submitting again is idempotent, same state returned even
    //     without a signature (the replay path doesn't carry one).
    const replay = await request.post(`/api/consent/${token}`, {
      data: { acknowledgement: view.consentMessage },
    });
    expect(replay.status()).toBe(200);
    const replayed = (await replay.json()).data;
    expect(replayed.status).toBe("VERIFIED");
    expect(replayed.alreadyConfirmedAt).toBe(confirmed.alreadyConfirmedAt);

    // 4) Agent re-fetches the order, denormalised pointer is up to date.
    const afterConsent = await request.get(`/api/orders/${order.id}`);
    expect(afterConsent.status()).toBe(200);
    const afterDto = (await afterConsent.json()).data;
    expect(afterDto.consent.status).toBe("VERIFIED");
    expect(afterDto.consent.method).toBe("HOSTED_PAGE");
    expect(afterDto.consent.receivedAt).toBeTruthy();
    expect(afterDto.consent.verifiedAt).toBeTruthy();
    expect(afterDto.consent.currentConsentId).toBe(
      sent.data.order.consent.currentConsentId,
    );

    // 4b) The agent-facing history endpoint exposes full audit-grade fields.
    const historyRes = await request.get(`/api/orders/${order.id}/consent`);
    expect(historyRes.status()).toBe(200);
    const history = (await historyRes.json()).data;
    expect(history.items).toHaveLength(1);
    expect(history.items[0].status).toBe("VERIFIED");
    expect(history.items[0].method).toBe("HOSTED_PAGE");
    expect(history.items[0].signedName).toBe("Consent Customer");
    expect(history.items[0].receivedAt).toBeTruthy();
    expect(history.items[0].verifiedAt).toBeTruthy();
    expect(history.items[0].receiptUserAgent).toBeTruthy();

    // 5) Drive payment to PAID and prove the consent fields are preserved.
    const event = buildCompletedEvent({
      orderId: order.id,
      orderNumber: order.orderNumber,
      sessionId: order.payment.stripeSessionId,
      amount: 250,
    });
    const webhook = await postSignedWebhook(request, event);
    expect(webhook.status).toBe(200);

    const final = await request.get(`/api/orders/${order.id}`);
    const finalDto = (await final.json()).data;
    expect(finalDto.status).toBe("PAID");
    expect(finalDto.payment.amountReceived).toBe(250);
    // Consent is dispute-grade evidence, the payment webhook must NOT
    // erase it. Customer submission auto-verifies, so the order stays
    // on VERIFIED through PAID.
    expect(finalDto.consent.status).toBe("VERIFIED");
    expect(finalDto.consent.currentConsentId).toBe(
      sent.data.order.consent.currentConsentId,
    );
    expect(finalDto.consent.receivedAt).toBe(afterDto.consent.receivedAt);
    expect(finalDto.consent.verifiedAt).toBe(afterDto.consent.verifiedAt);
  });

  test("invalid consent token returns 400", async ({ request }) => {
    const res = await request.get("/api/consent/not-a-real-token");
    expect(res.status()).toBe(400);
  });
});
