import { Types } from "mongoose";
import { beforeEach, describe, expect, it } from "vitest";

import { Branding, BRANDING_KEY, Organization, Setting, SETTINGS_KEY, User } from "@/server/db/models";
import { ensureBrandingDocument, getBranding, updateBranding } from "@/server/services/branding.service";
import { getSettings, updateSettings } from "@/server/services/settings.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";
import { UserRole } from "@/lib/constants/enums";
import type { UpdateSettingsInput } from "@/lib/validation";

/** Test helper: the route handler validates via Zod and only forwards
 *  the fields a user actually changed. The service's diff loop only
 *  acts on supplied fields. We cast a partial here because the Zod
 *  inferred type is strict — runtime behaviour is partial-update. */
function patch(input: Partial<UpdateSettingsInput>): UpdateSettingsInput {
  return input as UpdateSettingsInput;
}

/**
 * Phase-2 lazy-provisioning + per-org isolation.
 *
 * The invariants under test:
 *   1. Legacy callers (no orgId) keep reading the {key:"default"} singleton.
 *   2. A new orgId on first access lazily provisions a per-org row seeded
 *      from the legacy singleton. Subsequent reads hit the per-org row.
 *   3. Updates land on the per-org row, not the legacy singleton — proving
 *      no cross-tenant write leak.
 *   4. Two orgs are independent: writes to A don't show up in B.
 */

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
});

function newOrgId(): string {
  return new Types.ObjectId().toString();
}

describe("settings — scoped singleton + lazy provisioning", () => {
  it("legacy caller (no orgId) reads the {key:'default'} singleton unchanged", async () => {
    // Seed a legacy singleton row with a non-default cancellationPolicy
    // so we can recognise it on read.
    await Setting.create({
      key: SETTINGS_KEY,
      paymentExpiryHours: 24,
      orderPrefix: "ORD",
      defaultCurrency: "USD",
      successRedirectUrl: "http://localhost/pay/success",
      cancelRedirectUrl: "http://localhost/pay/cancelled",
      cancellationPolicy: "LEGACY POLICY MARKER",
      cancellationPolicyVersion: "v7",
      consentMode: "ADVISORY",
      consentMessage: "x",
    });

    const out = await getSettings(); // no orgId
    expect(out.cancellationPolicy).toBe("LEGACY POLICY MARKER");
    expect(out.cancellationPolicyVersion).toBe("v7");
  });

  it("lazy-provisions a per-org row by cloning the legacy singleton", async () => {
    // Same legacy seed.
    await Setting.create({
      key: SETTINGS_KEY,
      paymentExpiryHours: 24,
      orderPrefix: "ORD",
      defaultCurrency: "USD",
      successRedirectUrl: "http://localhost/pay/success",
      cancelRedirectUrl: "http://localhost/pay/cancelled",
      cancellationPolicy: "CLONED FROM LEGACY",
      cancellationPolicyVersion: "v3",
      consentMode: "ADVISORY",
      consentMessage: "x",
    });

    const orgA = newOrgId();
    const out = await getSettings(orgA);
    expect(out.cancellationPolicy).toBe("CLONED FROM LEGACY");
    expect(out.cancellationPolicyVersion).toBe("v3");

    // The per-org row now exists physically and has NO `key` (so the
    // partial-unique on key doesn't fire).
    const perOrg = await Setting.findOne({
      orgId: new Types.ObjectId(orgA),
    }).lean<{ key?: string | null }>();
    expect(perOrg).toBeTruthy();
    expect(perOrg?.key).toBeFalsy(); // null or missing

    // Legacy row also still exists, untouched.
    const legacy = await Setting.findOne({ key: SETTINGS_KEY }).lean();
    expect(legacy).toBeTruthy();
  });

  it("seeds env defaults when no legacy singleton exists", async () => {
    const orgA = newOrgId();
    const out = await getSettings(orgA);
    // env.server.DEFAULT_CURRENCY defaults to "USD" via the env schema.
    expect(out.defaultCurrency).toBe("USD");
    expect(out.consentMode).toBe("ADVISORY");
  });

  it("updates target the per-org row, never the legacy singleton", async () => {
    // Legacy row with a marker we'll watch.
    await Setting.create({
      key: SETTINGS_KEY,
      paymentExpiryHours: 24,
      orderPrefix: "LEG",
      defaultCurrency: "USD",
      successRedirectUrl: "http://localhost/pay/success",
      cancelRedirectUrl: "http://localhost/pay/cancelled",
      cancellationPolicy: "LEGACY",
      cancellationPolicyVersion: "v1",
      consentMode: "ADVISORY",
      consentMessage: "legacy-message",
    });
    const orgA = newOrgId();

    await updateSettings(
      patch({ orderPrefix: "TENANT_A" }),
      {
        actorId: new Types.ObjectId().toString(),
        actorName: "Ada",
        actorRole: UserRole.ADMIN,
        orgId: orgA,
        request: null,
      },
    );

    // Per-org row reflects the change.
    const perOrg = await getSettings(orgA);
    expect(perOrg.orderPrefix).toBe("TENANT_A");

    // Legacy singleton was NOT touched — cross-tenant write leak guard.
    const legacy = await Setting.findOne({ key: SETTINGS_KEY }).lean<{
      orderPrefix: string;
    }>();
    expect(legacy?.orderPrefix).toBe("LEG");
  });

  it("two orgs are independent", async () => {
    const orgA = newOrgId();
    const orgB = newOrgId();
    // Provision both via lazy read.
    await getSettings(orgA);
    await getSettings(orgB);

    await updateSettings(
      patch({ orderPrefix: "AAA" }),
      {
        actorId: new Types.ObjectId().toString(),
        actorName: "A",
        actorRole: UserRole.ADMIN,
        orgId: orgA,
        request: null,
      },
    );

    const a = await getSettings(orgA);
    const b = await getSettings(orgB);
    expect(a.orderPrefix).toBe("AAA");
    expect(b.orderPrefix).not.toBe("AAA");
  });
});

describe("branding — scoped singleton + lazy provisioning", () => {
  it("legacy caller (no orgId) reads the {key:'default'} singleton unchanged", async () => {
    await Branding.create({
      key: BRANDING_KEY,
      brandName: "LegacyBrand",
      supportEmail: "support@legacy.example",
      supportPhone: "+1-555-0000",
      primaryColor: "#FF0000",
    });
    const out = await getBranding();
    expect(out.brandName).toBe("LegacyBrand");
  });

  it("lazy-provisions per-org row from the org's OWN data (NOT the legacy singleton)", async () => {
    // Cross-tenant leak guard: even if a legacy singleton exists with
    // some other tenant's brand, a fresh tenant's seed must come from
    // THEIR Organization + founder data — never from the singleton.
    await Branding.create({
      key: BRANDING_KEY,
      brandName: "PlatformLegacyBrand",
      supportEmail: "support@legacy.example",
      supportPhone: "+1-555-0000",
      primaryColor: "#FF0000",
      footerTagline: "the legacy tagline",
    });
    const { orgId, ownerEmail, orgName } = await createOrgWithOwner(
      "Acme Bicycles",
    );
    const out = await getBranding(orgId);
    expect(out.brandName).toBe(orgName); // NOT "PlatformLegacyBrand"
    expect(out.supportEmail).toBe(ownerEmail);

    const perOrg = await Branding.findOne({
      orgId: new Types.ObjectId(orgId),
    }).lean<{ key?: string | null; brandName: string }>();
    expect(perOrg?.key).toBeFalsy();
    expect(perOrg?.brandName).toBe(orgName);
  });

  it("updateBranding writes to per-org row only, never the legacy singleton", async () => {
    await Branding.create({
      key: BRANDING_KEY,
      brandName: "PlatformLegacyBrand",
      supportEmail: "support@legacy.example",
      supportPhone: "+1-555-0000",
      primaryColor: "#FF0000",
    });
    const { orgId } = await createOrgWithOwner("TenantA");
    await ensureBrandingDocument(orgId);

    await updateBranding(
      { brandName: "TenantABrand" },
      {
        actor: {
          id: new Types.ObjectId().toString(),
          name: "Ada",
          role: UserRole.ADMIN,
        },
        orgId,
        request: null,
      },
    );

    const a = await getBranding(orgId);
    expect(a.brandName).toBe("TenantABrand");

    const legacy = await Branding.findOne({ key: BRANDING_KEY }).lean<{
      brandName: string;
    }>();
    expect(legacy?.brandName).toBe("PlatformLegacyBrand");
  });

  it("concurrent first-access doesn't produce duplicate per-org rows", async () => {
    // The dedupe-on-race guard inside `loadScopedSingleton` relies on
    // the partial-unique on `orgId`. In production the migration script
    // runs `syncIndexes` once; in this test we sync explicitly because
    // Mongoose's lazy autoIndex hasn't necessarily built it before the
    // first concurrent insert fires.
    await Branding.syncIndexes();
    const { orgId, orgName } = await createOrgWithOwner("RaceCondition Co");
    // Fire 5 concurrent first-access reads against the same orgId.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => getBranding(orgId)),
    );
    // All five return the same brand name (the tenant's own org name).
    expect(new Set(results.map((r) => r.brandName))).toEqual(
      new Set([orgName]),
    );
    // Exactly one per-org row exists.
    const rows = await Branding.find({
      orgId: new Types.ObjectId(orgId),
    }).lean();
    expect(rows.length).toBe(1);
  });
});

/** Create a real Organization + owner User so branding seed has tenant
 *  data to read. Returns the identifiers the asserting tests need. */
async function createOrgWithOwner(orgName: string): Promise<{
  orgId: string;
  ownerEmail: string;
  orgName: string;
}> {
  const ownerId = new Types.ObjectId();
  const ownerEmail = `owner-${ownerId.toString().slice(-6)}@x.test`;
  await User.create({
    _id: ownerId,
    name: "Founder",
    email: ownerEmail,
    passwordHash: "x".repeat(60),
    role: UserRole.SUPER_ADMIN,
    status: "ACTIVE",
  });
  const org = await Organization.create({
    slug: `s-${ownerId.toString().slice(-8)}`,
    name: orgName,
    ownerUserId: ownerId,
    status: "ACTIVE",
  });
  return {
    orgId: String(org._id),
    ownerEmail,
    orgName,
  };
}
