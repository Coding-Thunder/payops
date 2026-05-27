import { randomBytes } from "node:crypto";

import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PaymentGatewayKey, UserRole } from "@/lib/constants/enums";
import { _resetMasterKeyForTesting } from "@/lib/crypto/envelope";
import {
  GatewayCredential,
  GatewayMode,
  Organization,
  OrgStatus,
  User,
} from "@/server/db/models";
import {
  LEGACY_ORG_SLUG,
  _resetLegacyOrgIdForTesting,
} from "@/server/db/org/legacy";
import {
  loadGatewayCredential,
  saveGatewayCredential,
  disableGatewayCredential,
} from "@/server/payments/gateway-credentials.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * Phase-3 per-org gateway credentials: encrypted-at-rest persistence,
 * env-fallback for the legacy tenant, and write-isolation between orgs.
 */

const masterKey = randomBytes(32).toString("base64");

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
  process.env.PAYOPS_MASTER_KEY = masterKey;
  _resetMasterKeyForTesting();
  _resetLegacyOrgIdForTesting();
});

afterEach(() => {
  delete process.env.PAYOPS_MASTER_KEY;
  _resetMasterKeyForTesting();
  _resetLegacyOrgIdForTesting();
});

/** Seed the legacy organization so `isLegacyTenant(<id>)` resolves
 *  to true for the returned id — required by Pass 5a's env-fallback
 *  gate in `loadGatewayCredential`. */
async function seedLegacyOrg(): Promise<string> {
  const ownerId = new Types.ObjectId();
  await User.create({
    _id: ownerId,
    name: "Legacy Owner",
    email: `legacy-${ownerId.toString().slice(-6)}@payops.test`,
    passwordHash: "x".repeat(60),
    role: UserRole.SUPER_ADMIN,
    status: "ACTIVE",
  });
  const org = await Organization.create({
    slug: LEGACY_ORG_SLUG,
    name: "Legacy Tenant",
    ownerUserId: ownerId,
    status: OrgStatus.ACTIVE,
    verifiedAt: new Date(),
  });
  return String(org._id);
}

function actor() {
  return {
    id: new Types.ObjectId().toString(),
    name: "Ada",
    role: UserRole.ADMIN,
  };
}

describe("loadGatewayCredential", () => {
  it("falls back to env for STRIPE when the LEGACY org has no per-org row (Tenant #1 path)", async () => {
    // Pass 5a: env-fallback is gated by `isLegacyTenant`. Seeding
    // the legacy org BEFORE calling makes the lookup resolve and
    // permits the fallback — exactly the behaviour Tenant #1 relies
    // on through the cutover.
    const legacyOrgId = await seedLegacyOrg();
    const creds = await loadGatewayCredential(
      legacyOrgId,
      PaymentGatewayKey.STRIPE,
    );
    expect(creds).not.toBeNull();
    expect(creds?.source).toBe("env");
    expect(creds?.secretKey).toBe(process.env.STRIPE_SECRET_KEY);
    expect(creds?.webhookSecret).toBe(process.env.STRIPE_WEBHOOK_SECRET);
  });

  it("REFUSES env fallback for a non-legacy tenant (Pass 5a security gate)", async () => {
    // Critical regression-pin: without this assertion a new tenant
    // could silently route their first order's payment to the
    // platform's Stripe account. See Phase-A audit risk #4.1.
    await seedLegacyOrg();
    const newTenant = new Types.ObjectId().toString();
    const creds = await loadGatewayCredential(
      newTenant,
      PaymentGatewayKey.STRIPE,
    );
    expect(creds).toBeNull();
  });

  it("falls back to env even when orgId is omitted (legacy callers)", async () => {
    const creds = await loadGatewayCredential(null, PaymentGatewayKey.STRIPE);
    expect(creds?.source).toBe("env");
  });

  it("returns null for non-STRIPE gateways without a per-org row", async () => {
    const orgA = new Types.ObjectId().toString();
    const creds = await loadGatewayCredential(orgA, PaymentGatewayKey.RAZORPAY);
    expect(creds).toBeNull();
  });
});

describe("saveGatewayCredential + loadGatewayCredential round-trip", () => {
  it("persists encrypted blobs and decrypts cleanly on read", async () => {
    const orgA = new Types.ObjectId().toString();
    await saveGatewayCredential(
      {
        gateway: PaymentGatewayKey.STRIPE,
        mode: GatewayMode.TEST,
        secretKey: "sk_test_orgA_secret_XYZ",
        webhookSecret: "whsec_orgA_webhook",
        publishableKey: "pk_test_orgA",
      },
      { actor: actor(), orgId: orgA, request: null },
    );

    const loaded = await loadGatewayCredential(orgA, PaymentGatewayKey.STRIPE);
    expect(loaded?.source).toBe("org");
    expect(loaded?.secretKey).toBe("sk_test_orgA_secret_XYZ");
    expect(loaded?.webhookSecret).toBe("whsec_orgA_webhook");
    expect(loaded?.publishableKey).toBe("pk_test_orgA");
    expect(loaded?.mode).toBe(GatewayMode.TEST);
  });

  it("never stores secrets in plaintext on disk", async () => {
    const orgA = new Types.ObjectId().toString();
    await saveGatewayCredential(
      {
        gateway: PaymentGatewayKey.STRIPE,
        mode: GatewayMode.TEST,
        secretKey: "sk_test_PLAINTEXT_MARKER_AAA",
        webhookSecret: "whsec_PLAINTEXT_MARKER_BBB",
      },
      { actor: actor(), orgId: orgA, request: null },
    );

    // Read the raw doc from Mongo — neither the secret nor the webhook
    // signing secret should appear in clear.
    const raw = await GatewayCredential.findOne({
      orgId: new Types.ObjectId(orgA),
    }).lean();
    const dumped = JSON.stringify(raw);
    expect(dumped).not.toContain("PLAINTEXT_MARKER_AAA");
    expect(dumped).not.toContain("PLAINTEXT_MARKER_BBB");
    // But the encrypted blob structure IS present.
    expect(raw?.secretKey).toHaveProperty("iv");
    expect(raw?.secretKey).toHaveProperty("ciphertext");
    expect(raw?.secretKey).toHaveProperty("authTag");
    expect(raw?.secretKey).toHaveProperty("keyVersion", "v1");
  });

  it("re-saving the same gateway updates the encrypted blob (key rotation)", async () => {
    const orgA = new Types.ObjectId().toString();
    await saveGatewayCredential(
      {
        gateway: PaymentGatewayKey.STRIPE,
        mode: GatewayMode.TEST,
        secretKey: "sk_test_OLD_KEY",
        webhookSecret: "whsec_OLD",
      },
      { actor: actor(), orgId: orgA, request: null },
    );
    await saveGatewayCredential(
      {
        gateway: PaymentGatewayKey.STRIPE,
        mode: GatewayMode.TEST,
        secretKey: "sk_test_ROTATED_KEY",
        webhookSecret: "whsec_NEW",
      },
      { actor: actor(), orgId: orgA, request: null },
    );

    const loaded = await loadGatewayCredential(orgA, PaymentGatewayKey.STRIPE);
    expect(loaded?.secretKey).toBe("sk_test_ROTATED_KEY");
    expect(loaded?.webhookSecret).toBe("whsec_NEW");

    // Exactly one row, not two.
    const rows = await GatewayCredential.find({
      orgId: new Types.ObjectId(orgA),
    }).lean();
    expect(rows.length).toBe(1);
  });

  it("disabled credentials resolve to null on read", async () => {
    const orgA = new Types.ObjectId().toString();
    await saveGatewayCredential(
      {
        gateway: PaymentGatewayKey.STRIPE,
        mode: GatewayMode.TEST,
        secretKey: "sk_test_DISABLED_VALUE",
        webhookSecret: "whsec_disabled_test",
      },
      { actor: actor(), orgId: orgA, request: null },
    );
    await disableGatewayCredential(PaymentGatewayKey.STRIPE, {
      actor: actor(),
      orgId: orgA,
      request: null,
    });
    const loaded = await loadGatewayCredential(orgA, PaymentGatewayKey.STRIPE);
    // Disabled per-org row returns null — does NOT fall back to env
    // because the operator explicitly turned this off.
    expect(loaded).toBeNull();
  });
});

describe("cross-tenant isolation", () => {
  it("org A's credentials never leak into org B's lookups", async () => {
    const orgA = new Types.ObjectId().toString();
    const orgB = new Types.ObjectId().toString();

    await saveGatewayCredential(
      {
        gateway: PaymentGatewayKey.STRIPE,
        mode: GatewayMode.TEST,
        secretKey: "sk_test_A_ONLY",
        webhookSecret: "whsec_A_only_secret",
      },
      { actor: actor(), orgId: orgA, request: null },
    );
    await saveGatewayCredential(
      {
        gateway: PaymentGatewayKey.STRIPE,
        mode: GatewayMode.LIVE,
        secretKey: "sk_live_B_ONLY",
        webhookSecret: "whsec_B_only_secret",
      },
      { actor: actor(), orgId: orgB, request: null },
    );

    const fromA = await loadGatewayCredential(orgA, PaymentGatewayKey.STRIPE);
    const fromB = await loadGatewayCredential(orgB, PaymentGatewayKey.STRIPE);
    expect(fromA?.secretKey).toBe("sk_test_A_ONLY");
    expect(fromA?.mode).toBe(GatewayMode.TEST);
    expect(fromB?.secretKey).toBe("sk_live_B_ONLY");
    expect(fromB?.mode).toBe(GatewayMode.LIVE);
  });
});
