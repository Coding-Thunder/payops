import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PaymentGatewayKey, UserRole } from "@/lib/constants/enums";
import { _resetMasterKeyForTesting } from "@/lib/crypto/envelope";
import {
  GET as listRoute,
  POST as saveRoute,
} from "@/app/api/admin/gateways/route";
import { DELETE as disableRoute } from "@/app/api/admin/gateways/[gateway]/route";
import { GatewayCredential } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { buildRequest, expectOk, jsonBody } from "@/tests/utils/api";
import { mockNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

let headers: Awaited<ReturnType<typeof mockNextHeaders>>;
let session: Awaited<ReturnType<typeof mockSession>> | null = null;

const masterKey = randomBytes(32).toString("base64");

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
  process.env.PAYOPS_MASTER_KEY = masterKey;
  _resetMasterKeyForTesting();
  headers = await mockNextHeaders();
});

afterEach(async () => {
  await headers.restore();
  if (session) {
    session.restore();
    session = null;
  }
  delete process.env.PAYOPS_MASTER_KEY;
  _resetMasterKeyForTesting();
});

const validPayload = {
  gateway: PaymentGatewayKey.STRIPE,
  mode: "TEST" as const,
  secretKey: "sk_test_abcdef1234567890",
  webhookSecret: "whsec_test_1234567890abcd",
  publishableKey: "pk_test_1234",
  accountId: null,
};

describe("POST /api/admin/gateways (RBAC + happy path)", () => {
  it("SUPER_ADMIN can save Stripe credentials", async () => {
    session = await mockSession(actorFor(UserRole.SUPER_ADMIN));
    const res = await saveRoute(
      buildRequest("/api/admin/gateways", {
        method: "POST",
        body: validPayload,
      }),
    );
    const { status, body } = await jsonBody(res);
    expect(status).toBe(201);
    expectOk(body as never);

    // Persisted with encrypted blobs — no plaintext leaks to disk.
    const raw = await GatewayCredential.findOne({
      gateway: PaymentGatewayKey.STRIPE,
    }).lean();
    expect(JSON.stringify(raw)).not.toContain("sk_test_abcdef1234567890");
    expect(JSON.stringify(raw)).not.toContain("whsec_test_1234567890abcd");
    expect(raw?.secretKey).toHaveProperty("iv");
  });

  it("ADMIN is FORBIDDEN (gateway management is SUPER_ADMIN-only)", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    const res = await saveRoute(
      buildRequest("/api/admin/gateways", {
        method: "POST",
        body: validPayload,
      }),
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(403);
  });

  it("STAFF is FORBIDDEN", async () => {
    session = await mockSession(actorFor(UserRole.STAFF));
    const res = await saveRoute(
      buildRequest("/api/admin/gateways", {
        method: "POST",
        body: validPayload,
      }),
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(403);
  });

  it("rejects a too-short secret key with a validation error", async () => {
    session = await mockSession(actorFor(UserRole.SUPER_ADMIN));
    const res = await saveRoute(
      buildRequest("/api/admin/gateways", {
        method: "POST",
        body: { ...validPayload, secretKey: "x" },
      }),
    );
    const { status } = await jsonBody(res);
    // withApi wraps Zod errors as 422 (unprocessable entity).
    expect(status).toBe(422);
  });

  it("re-posting rotates the encrypted blob (key rotation)", async () => {
    session = await mockSession(actorFor(UserRole.SUPER_ADMIN));
    await saveRoute(
      buildRequest("/api/admin/gateways", {
        method: "POST",
        body: validPayload,
      }),
    );
    const first = await GatewayCredential.findOne({
      gateway: PaymentGatewayKey.STRIPE,
    }).lean<{ secretKey: { ciphertext: string } }>();

    await saveRoute(
      buildRequest("/api/admin/gateways", {
        method: "POST",
        body: { ...validPayload, secretKey: "sk_test_rotated_1234567890" },
      }),
    );
    const second = await GatewayCredential.findOne({
      gateway: PaymentGatewayKey.STRIPE,
    }).lean<{ secretKey: { ciphertext: string } }>();
    expect(second?.secretKey.ciphertext).not.toBe(first?.secretKey.ciphertext);
    // Still exactly one row — rotation, not duplicate.
    const count = await GatewayCredential.countDocuments({});
    expect(count).toBe(1);
  });
});

describe("GET /api/admin/gateways", () => {
  it("returns the configured rows for the actor's org", async () => {
    session = await mockSession(actorFor(UserRole.SUPER_ADMIN));
    await saveRoute(
      buildRequest("/api/admin/gateways", {
        method: "POST",
        body: validPayload,
      }),
    );
    const res = await listRoute(
      buildRequest("/api/admin/gateways", { method: "GET" }),
    );
    const { status, body } = await jsonBody(res);
    expect(status).toBe(200);
    expectOk(body as never);
    const data = (body as { data: { items: unknown[]; encryptionAvailable: boolean } }).data;
    expect(data.items.length).toBe(1);
    expect(data.encryptionAvailable).toBe(true);
  });

  it("never returns the decrypted secret key", async () => {
    session = await mockSession(actorFor(UserRole.SUPER_ADMIN));
    await saveRoute(
      buildRequest("/api/admin/gateways", {
        method: "POST",
        body: validPayload,
      }),
    );
    const res = await listRoute(
      buildRequest("/api/admin/gateways", { method: "GET" }),
    );
    const { body } = await jsonBody(res);
    const dumped = JSON.stringify(body);
    expect(dumped).not.toContain("sk_test_abcdef1234567890");
    expect(dumped).not.toContain("whsec_test_1234567890abcd");
  });
});

describe("DELETE /api/admin/gateways/[gateway]", () => {
  it("disables the gateway (soft) — keeps the row for audit", async () => {
    session = await mockSession(actorFor(UserRole.SUPER_ADMIN));
    await saveRoute(
      buildRequest("/api/admin/gateways", {
        method: "POST",
        body: validPayload,
      }),
    );
    const res = await disableRoute(
      buildRequest(`/api/admin/gateways/${PaymentGatewayKey.STRIPE}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ gateway: PaymentGatewayKey.STRIPE }) },
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(200);
    const row = await GatewayCredential.findOne({
      gateway: PaymentGatewayKey.STRIPE,
    }).lean<{ enabled: boolean }>();
    expect(row?.enabled).toBe(false);
  });

  it("ADMIN cannot disable a gateway", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    const res = await disableRoute(
      buildRequest(`/api/admin/gateways/${PaymentGatewayKey.STRIPE}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ gateway: PaymentGatewayKey.STRIPE }) },
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(403);
  });
});
