import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PaymentGatewayKey, UserRole } from "@/lib/constants/enums";
import { _resetMasterKeyForTesting } from "@/lib/crypto/envelope";
import { POST as connectRoute } from "@/app/api/admin/gateways/stripe/connect/route";
import { POST as testRoute } from "@/app/api/admin/gateways/stripe/test/route";
import { DELETE as disableRoute } from "@/app/api/admin/gateways/[gateway]/route";
import { GatewayCredential } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { mockNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";

/**
 * Pass 6a, Stripe auto-connect onboarding tests.
 *
 * Verifies the happy path: operator pastes a secret key, server
 * verifies it via Stripe's /v1/balance, registers a webhook endpoint
 * on the operator's account, persists both encrypted, and the
 * webhook id is stored for clean-up on disconnect.
 *
 * Also covers the failure paths an operator is most likely to hit:
 *   - Mode mismatch (LIVE key pasted into TEST slot, or vice versa).
 *   - Stripe rejects the secret key (StripeAuthenticationError).
 *   - Pre-save "test connection" probe surfaces the same failure modes
 *     without persisting anything.
 */

let headers: Awaited<ReturnType<typeof mockNextHeaders>>;
let session: Awaited<ReturnType<typeof mockSession>> | null = null;

const masterKey = randomBytes(32).toString("base64");

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
  process.env.TRACETXN_MASTER_KEY = masterKey;
  _resetMasterKeyForTesting();
  headers = await mockNextHeaders();
  getCurrentTestStripe().reset();
});

afterEach(async () => {
  await headers.restore();
  if (session) {
    session.restore();
    session = null;
  }
  delete process.env.TRACETXN_MASTER_KEY;
  _resetMasterKeyForTesting();
});

const validPayload = {
  mode: "TEST" as const,
  secretKey: "sk_test_abcdef1234567890",
  publishableKey: "pk_test_1234",
};

describe("POST /api/admin/gateways/stripe/connect, happy path", () => {
  it("verifies the key, registers a webhook, persists encrypted, audits", async () => {
    session = await mockSession(actorFor(UserRole.SUPER_ADMIN));
    const stripe = getCurrentTestStripe();

    const res = await connectRoute(
      buildRequest("/api/admin/gateways/stripe/connect", {
        method: "POST",
        body: validPayload,
      }),
    );
    const { status, body } = await jsonBody<{
      data: {
        credential: { mode: string; secretKeyLast4: string };
        webhookEndpointId: string;
        webhookEndpointUrl: string;
      };
    }>(res);
    expect(status).toBe(201);
    expect(body.data.credential.mode).toBe("TEST");
    expect(body.data.credential.secretKeyLast4).toBe("7890");
    expect(body.data.webhookEndpointId).toMatch(/^we_test_stub_/);
    expect(body.data.webhookEndpointUrl).toMatch(
      /\/api\/webhooks\/stripe\/[a-f0-9]{24}$/,
    );

    // Webhook endpoint was registered with Stripe + carries our event set.
    expect(stripe.webhookEndpointsCreated).toHaveLength(1);
    expect(stripe.webhookEndpointsCreated[0].enabled_events).toContain(
      "checkout.session.completed",
    );

    // Persisted row carries the endpoint id + an encrypted blob (not plaintext).
    const row = await GatewayCredential.findOne({
      gateway: PaymentGatewayKey.STRIPE,
    }).lean();
    expect(row?.stripeWebhookEndpointId).toBe(
      body.data.webhookEndpointId,
    );
    expect(JSON.stringify(row?.secretKey)).not.toContain(
      validPayload.secretKey,
    );
    expect(JSON.stringify(row?.webhookSecret)).not.toContain("whsec_");
  });

  it("disconnecting deletes the Stripe webhook endpoint we registered", async () => {
    session = await mockSession(actorFor(UserRole.SUPER_ADMIN));
    const stripe = getCurrentTestStripe();

    // Connect first.
    await connectRoute(
      buildRequest("/api/admin/gateways/stripe/connect", {
        method: "POST",
        body: validPayload,
      }),
    );
    expect(stripe.webhookEndpointsCreated).toHaveLength(1);
    const registeredId = stripe.webhookEndpointsCreated[0].id;

    // Disconnect via DELETE /api/admin/gateways/STRIPE.
    const res = await disableRoute(
      buildRequest(`/api/admin/gateways/${PaymentGatewayKey.STRIPE}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ gateway: PaymentGatewayKey.STRIPE }) },
    );
    expect((await jsonBody(res)).status).toBe(200);
    expect(stripe.webhookEndpointsDeleted).toContain(registeredId);

    const row = await GatewayCredential.findOne({
      gateway: PaymentGatewayKey.STRIPE,
    }).lean();
    expect(row?.enabled).toBe(false);
    expect(row?.stripeWebhookEndpointId).toBeNull();
  });
});

describe("POST /api/admin/gateways/stripe/connect, refusal paths", () => {
  it("REFUSES when the secret key's prefix doesn't match the selected mode", async () => {
    session = await mockSession(actorFor(UserRole.SUPER_ADMIN));
    const res = await connectRoute(
      buildRequest("/api/admin/gateways/stripe/connect", {
        method: "POST",
        body: {
          mode: "LIVE",
          secretKey: "sk_test_pasted_into_live_slot",
        },
      }),
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(422);
    // Nothing got registered or persisted.
    expect(getCurrentTestStripe().webhookEndpointsCreated).toHaveLength(0);
    expect(
      await GatewayCredential.countDocuments({
        gateway: PaymentGatewayKey.STRIPE,
      }),
    ).toBe(0);
  });

  it("REFUSES when Stripe rejects the secret key", async () => {
    session = await mockSession(actorFor(UserRole.SUPER_ADMIN));
    getCurrentTestStripe().failNextBalance({
      type: "StripeAuthenticationError",
      message: "Invalid API Key provided",
    });

    const res = await connectRoute(
      buildRequest("/api/admin/gateways/stripe/connect", {
        method: "POST",
        body: validPayload,
      }),
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(422);
    expect(getCurrentTestStripe().webhookEndpointsCreated).toHaveLength(0);
  });

  it("ADMIN cannot connect, gated by GATEWAY_MANAGE (SUPER_ADMIN only)", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    const res = await connectRoute(
      buildRequest("/api/admin/gateways/stripe/connect", {
        method: "POST",
        body: validPayload,
      }),
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(403);
  });
});

describe("POST /api/admin/gateways/stripe/test, pre-save probe", () => {
  it("returns ok=true when Stripe accepts the key", async () => {
    session = await mockSession(actorFor(UserRole.SUPER_ADMIN));
    const res = await testRoute(
      buildRequest("/api/admin/gateways/stripe/test", {
        method: "POST",
        body: {
          mode: "TEST",
          secretKey: "sk_test_abcdef1234567890",
        },
      }),
    );
    const { status, body } = await jsonBody<{
      data: { ok: boolean; livemode?: boolean };
    }>(res);
    expect(status).toBe(200);
    expect(body.data.ok).toBe(true);
    expect(body.data.livemode).toBe(false);
    // Nothing was persisted.
    expect(getCurrentTestStripe().webhookEndpointsCreated).toHaveLength(0);
  });

  it("returns ok=false with a friendly message on auth failure", async () => {
    session = await mockSession(actorFor(UserRole.SUPER_ADMIN));
    getCurrentTestStripe().failNextBalance({
      type: "StripeAuthenticationError",
      message: "Invalid API Key provided",
    });
    const res = await testRoute(
      buildRequest("/api/admin/gateways/stripe/test", {
        method: "POST",
        body: {
          mode: "TEST",
          secretKey: "sk_test_abcdef1234567890",
        },
      }),
    );
    const { status, body } = await jsonBody<{
      data: { ok: boolean; message?: string };
    }>(res);
    expect(status).toBe(200);
    expect(body.data.ok).toBe(false);
    expect(body.data.message).toMatch(/rejected/i);
  });

  it("returns ok=false on TEST/LIVE mode mismatch without hitting Stripe", async () => {
    session = await mockSession(actorFor(UserRole.SUPER_ADMIN));
    const res = await testRoute(
      buildRequest("/api/admin/gateways/stripe/test", {
        method: "POST",
        body: {
          mode: "LIVE",
          secretKey: "sk_test_obviously_test_key",
        },
      }),
    );
    const { body } = await jsonBody<{
      data: { ok: boolean; message?: string };
    }>(res);
    expect(body.data.ok).toBe(false);
    expect(body.data.message).toMatch(/mode/i);
  });
});
