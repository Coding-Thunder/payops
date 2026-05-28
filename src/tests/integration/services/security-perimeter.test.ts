import { randomBytes } from "node:crypto";

import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PaymentGatewayKey, UserRole } from "@/lib/constants/enums";
import { _resetMasterKeyForTesting } from "@/lib/crypto/envelope";
import {
  GatewayMode,
  Organization,
  OrgStatus,
  User,
} from "@/server/db/models";
import { LEGACY_ORG_SLUG, _resetLegacyOrgIdForTesting } from "@/server/db/org/legacy";
import {
  loadGatewayCredential,
  saveGatewayCredential,
} from "@/server/payments/gateway-credentials.service";
import { POST as signupRoute } from "@/app/api/auth/signup/route";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { mockNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * Phase 4b: the security perimeter around self-serve signup.
 *
 * Two invariants the tests guard:
 *
 *  1. Payments fail closed when a non-legacy tenant has no per-org
 *     gateway credentials — they MUST NOT silently fall back to the
 *     platform's env-based Stripe account. (loadGatewayCredential)
 *
 *  2. Reserved slugs (`admin`, `api`, `payops`, …) get suffix-resolved
 *     instead of being granted to the first signup that asks. (signup)
 */

const masterKey = randomBytes(32).toString("base64");
let headers: Awaited<ReturnType<typeof mockNextHeaders>>;

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
  process.env.TRACETXN_MASTER_KEY = masterKey;
  _resetMasterKeyForTesting();
  _resetLegacyOrgIdForTesting();
  headers = await mockNextHeaders();
});

afterEach(async () => {
  await headers.restore();
  delete process.env.TRACETXN_MASTER_KEY;
  _resetMasterKeyForTesting();
  _resetLegacyOrgIdForTesting();
});

function newOrgId(): string {
  return new Types.ObjectId().toString();
}

async function seedLegacyOrg(): Promise<string> {
  // Owner is required on the Organization schema. We bypass the
  // signup flow here because we want the legacy tenant to look
  // exactly like the migration script's output.
  const ownerId = new Types.ObjectId();
  await User.create({
    _id: ownerId,
    name: "Legacy Owner",
    email: `legacy-${ownerId.toString().slice(-6)}@tracetxn.test`,
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

describe("loadGatewayCredential — env-fallback restricted to legacy", () => {
  it("LEGACY org with no per-org row falls back to env (back-compat)", async () => {
    const legacyOrgId = await seedLegacyOrg();
    const creds = await loadGatewayCredential(
      legacyOrgId,
      PaymentGatewayKey.STRIPE,
    );
    expect(creds).not.toBeNull();
    expect(creds?.source).toBe("env");
  });

  it("NEW tenant with no per-org row returns null — refuses env fallback", async () => {
    await seedLegacyOrg();
    const newTenantId = newOrgId();
    const creds = await loadGatewayCredential(
      newTenantId,
      PaymentGatewayKey.STRIPE,
    );
    // ← Critical assertion: must be null, not env-derived. Otherwise
    // a brand-new signup's first order would route money to the
    // platform's Stripe account.
    expect(creds).toBeNull();
  });

  it("NEW tenant with their OWN per-org row resolves to that row", async () => {
    await seedLegacyOrg();
    const newTenantId = newOrgId();
    const actorId = new Types.ObjectId().toString();
    await saveGatewayCredential(
      {
        gateway: PaymentGatewayKey.STRIPE,
        mode: GatewayMode.TEST,
        secretKey: "sk_test_NEW_TENANT_KEY",
        webhookSecret: "whsec_new_tenant_secret",
      },
      {
        actor: { id: actorId, name: "Founder", role: UserRole.SUPER_ADMIN },
        orgId: newTenantId,
        request: null,
      },
    );

    const creds = await loadGatewayCredential(
      newTenantId,
      PaymentGatewayKey.STRIPE,
    );
    expect(creds?.source).toBe("org");
    expect(creds?.secretKey).toBe("sk_test_NEW_TENANT_KEY");
  });

  it("no orgId at all → env fallback (un-migrated legacy callers)", async () => {
    await seedLegacyOrg();
    const creds = await loadGatewayCredential(null, PaymentGatewayKey.STRIPE);
    expect(creds?.source).toBe("env");
  });

  it("no legacy org exists AT ALL → env fallback for null orgId still works", async () => {
    // No seedLegacyOrg call. Fresh install with no migration.
    const creds = await loadGatewayCredential(null, PaymentGatewayKey.STRIPE);
    // This path keeps working for compatibility with brand-new
    // deploys before the migration script runs.
    expect(creds?.source).toBe("env");
  });
});

describe("Signup — reserved slug denylist", () => {
  const baseBody = {
    name: "Ada Lovelace",
    password: "Hunter2Hunter2",
  };

  async function signup(orgName: string, email: string) {
    return signupRoute(
      buildRequest("/api/auth/signup", {
        method: "POST",
        body: { ...baseBody, email, orgName },
      }),
    );
  }

  it("rejects 'admin' as a slug — gets a -2 suffix instead", async () => {
    const res = await signup("admin", "a@x.test");
    const { body } = await jsonBody(res);
    const slug = (body as { data: { orgSlug: string } }).data.orgSlug;
    expect(slug).not.toBe("admin");
    expect(slug).toMatch(/^admin-\d+$/);
  });

  it("rejects 'payops' as a slug — platform brand reserved", async () => {
    const res = await signup("PayOps", "b@x.test");
    const { body } = await jsonBody(res);
    const slug = (body as { data: { orgSlug: string } }).data.orgSlug;
    expect(slug).not.toBe("payops");
  });

  it("rejects 'legacy' as a slug — collides with the migration tenant", async () => {
    const res = await signup("Legacy", "c@x.test");
    const { body } = await jsonBody(res);
    const slug = (body as { data: { orgSlug: string } }).data.orgSlug;
    expect(slug).not.toBe("legacy");
  });

  it("rejects 'google' — common squat target", async () => {
    const res = await signup("Google", "d@x.test");
    const { body } = await jsonBody(res);
    const slug = (body as { data: { orgSlug: string } }).data.orgSlug;
    expect(slug).not.toBe("google");
  });

  it("non-reserved names still mint their natural slug", async () => {
    const res = await signup("Acme Rentals", "e@x.test");
    const { body } = await jsonBody(res);
    expect((body as { data: { orgSlug: string } }).data.orgSlug).toBe(
      "acme-rentals",
    );
  });
});
