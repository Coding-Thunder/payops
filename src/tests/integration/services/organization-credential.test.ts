import { beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import { PaymentGatewayKey, RecordState, UserRole } from "@/lib/constants/enums";
import {
  CredentialField,
  CredentialProvider,
  Organization,
  OrganizationCredential,
  OrganizationMember,
} from "@/server/db/models";
import {
  deleteSecret,
  getSecret,
  isVaultConfigured,
  listCredentialMetadata,
  putSecret,
} from "@/server/services/organization-credential.service";
import { ensureMongo } from "@/tests/utils/db";

/**
 * Organization credential vault.
 *
 * The guarantees pinned here are the ones that make it safe to hold two
 * merchants' live payment keys in one database:
 *
 *   - a secret stored for one organization is not readable as another's,
 *     even by an attacker who can move rows between documents
 *   - ordinary queries cannot surface ciphertext at all
 *   - nothing sensitive survives serialisation to JSON
 *   - the vault degrades to "no credential" rather than throwing when it is
 *     unconfigured, which is what lets this ship ahead of the key rollout
 */

let orgA: Types.ObjectId;
let orgB: Types.ObjectId;

async function makeOrg(slug: string, isDefault = false) {
  const doc = await Organization.create({
    slug,
    name: slug,
    brandName: slug,
    isDefault,
    payments: { provider: PaymentGatewayKey.STRIPE },
  });
  return doc._id as Types.ObjectId;
}

beforeEach(async () => {
  await ensureMongo();
  orgA = await makeOrg("rentalconfirmation", true);
  orgB = await makeOrg("tripreservations");
});

describe("vault configuration", () => {
  it("is configured in the integration environment", () => {
    expect(isVaultConfigured()).toBe(true);
  });
});

describe("round trip", () => {
  it("stores and retrieves a secret", async () => {
    await putSecret({
      organizationId: String(orgA),
      provider: CredentialProvider.STRIPE,
      field: CredentialField.SECRET_KEY,
      value: "sk_live_orgA_secret",
    });

    const got = await getSecret({
      organizationId: String(orgA),
      provider: CredentialProvider.STRIPE,
      field: CredentialField.SECRET_KEY,
    });
    expect(got).toBe("sk_live_orgA_secret");
  });

  it("returns null for a credential that was never stored", async () => {
    expect(
      await getSecret({
        organizationId: String(orgA),
        provider: CredentialProvider.PAYPAL,
        field: CredentialField.CLIENT_SECRET,
      }),
    ).toBeNull();
  });

  it("returns null for a malformed organization id instead of throwing", async () => {
    expect(
      await getSecret({
        organizationId: "not-an-object-id",
        provider: CredentialProvider.STRIPE,
        field: CredentialField.SECRET_KEY,
      }),
    ).toBeNull();
  });

  it("rotates in place and stamps lastRotatedAt", async () => {
    const ref = {
      organizationId: String(orgA),
      provider: CredentialProvider.STRIPE,
      field: CredentialField.SECRET_KEY,
    };
    await putSecret({ ...ref, value: "sk_live_first" });
    const first = await OrganizationCredential.findOne({
      organizationId: orgA,
    }).lean<{ lastRotatedAt: Date | null } | null>();
    expect(first?.lastRotatedAt).toBeNull();

    await putSecret({ ...ref, value: "sk_live_second" });

    expect(await getSecret(ref)).toBe("sk_live_second");
    // Rotation replaces, never duplicates.
    expect(await OrganizationCredential.countDocuments({})).toBe(1);
    const after = await OrganizationCredential.findOne({
      organizationId: orgA,
    }).lean<{ lastRotatedAt: Date | null } | null>();
    expect(after?.lastRotatedAt).toBeInstanceOf(Date);
  });

  it("refuses to store an empty value", async () => {
    await expect(
      putSecret({
        organizationId: String(orgA),
        provider: CredentialProvider.STRIPE,
        field: CredentialField.SECRET_KEY,
        value: "",
      }),
    ).rejects.toThrow(/empty/i);
  });

  it("deletes a credential so the organization falls back to env", async () => {
    const ref = {
      organizationId: String(orgA),
      provider: CredentialProvider.SMTP,
      field: CredentialField.PASSWORD,
    };
    await putSecret({ ...ref, value: "hunter2" });
    expect(await deleteSecret(ref)).toBe(true);
    expect(await getSecret(ref)).toBeNull();
    expect(await deleteSecret(ref)).toBe(false);
  });
});

describe("cross-organization isolation", () => {
  it("keeps two organizations' secrets for the same provider distinct", async () => {
    await putSecret({
      organizationId: String(orgA),
      provider: CredentialProvider.STRIPE,
      field: CredentialField.SECRET_KEY,
      value: "sk_live_A",
    });
    await putSecret({
      organizationId: String(orgB),
      provider: CredentialProvider.STRIPE,
      field: CredentialField.SECRET_KEY,
      value: "sk_live_B",
    });

    expect(
      await getSecret({
        organizationId: String(orgA),
        provider: CredentialProvider.STRIPE,
        field: CredentialField.SECRET_KEY,
      }),
    ).toBe("sk_live_A");
    expect(
      await getSecret({
        organizationId: String(orgB),
        provider: CredentialProvider.STRIPE,
        field: CredentialField.SECRET_KEY,
      }),
    ).toBe("sk_live_B");
  });

  it("refuses a ciphertext physically moved to another organization", async () => {
    // The attack: someone with write access copies org A's encrypted Stripe
    // key into org B's row. AAD binding means it cannot be opened there —
    // org B does not silently start charging through org A's account.
    await putSecret({
      organizationId: String(orgA),
      provider: CredentialProvider.STRIPE,
      field: CredentialField.SECRET_KEY,
      value: "sk_live_A",
    });
    const stolen = await OrganizationCredential.findOne({
      organizationId: orgA,
    })
      .select("+iv +ciphertext +authTag")
      .lean<{
        iv: string;
        ciphertext: string;
        authTag: string;
        keyVersion: number;
      } | null>();

    await OrganizationCredential.create({
      organizationId: orgB,
      provider: CredentialProvider.STRIPE,
      field: CredentialField.SECRET_KEY,
      keyVersion: stolen!.keyVersion,
      iv: stolen!.iv,
      ciphertext: stolen!.ciphertext,
      authTag: stolen!.authTag,
      hint: "ve_A",
    });

    await expect(
      getSecret({
        organizationId: String(orgB),
        provider: CredentialProvider.STRIPE,
        field: CredentialField.SECRET_KEY,
      }),
    ).rejects.toThrow(/could not be opened/i);
  });

  it("allows only one row per (organization, provider, field)", async () => {
    await OrganizationCredential.init();
    await putSecret({
      organizationId: String(orgA),
      provider: CredentialProvider.STRIPE,
      field: CredentialField.SECRET_KEY,
      value: "sk_live_A",
    });
    await expect(
      OrganizationCredential.create({
        organizationId: orgA,
        provider: CredentialProvider.STRIPE,
        field: CredentialField.SECRET_KEY,
        keyVersion: 1,
        iv: "x",
        ciphertext: "y",
        authTag: "z",
      }),
    ).rejects.toThrow(/duplicate key/i);
  });
});

describe("secrets never leak through ordinary access", () => {
  beforeEach(async () => {
    await putSecret({
      organizationId: String(orgA),
      provider: CredentialProvider.STRIPE,
      field: CredentialField.SECRET_KEY,
      value: "sk_live_super_secret",
    });
  });

  it("omits the envelope from an unqualified query", async () => {
    const row = await OrganizationCredential.findOne({
      organizationId: orgA,
    }).lean<Record<string, unknown> | null>();
    expect(row).toBeTruthy();
    expect(row!.provider).toBe(CredentialProvider.STRIPE);
    // select:false — the envelope is simply absent.
    expect(row!.ciphertext).toBeUndefined();
    expect(row!.iv).toBeUndefined();
    expect(row!.authTag).toBeUndefined();
  });

  it("strips the envelope from JSON even when explicitly selected", async () => {
    const doc = await OrganizationCredential.findOne({
      organizationId: orgA,
    }).select("+iv +ciphertext +authTag");
    const json = JSON.parse(JSON.stringify(doc));
    expect(json.ciphertext).toBeUndefined();
    expect(json.iv).toBeUndefined();
    expect(json.authTag).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain("sk_live");
  });

  it("never stores the plaintext anywhere in the document", async () => {
    const raw = await OrganizationCredential.findOne({ organizationId: orgA })
      .select("+iv +ciphertext +authTag")
      .lean();
    expect(JSON.stringify(raw)).not.toContain("sk_live_super_secret");
  });

  it("exposes only a 4-character hint through metadata listing", async () => {
    const meta = await listCredentialMetadata(String(orgA));
    expect(meta).toHaveLength(1);
    expect(meta[0]!.hint).toBe("cret");
    expect(JSON.stringify(meta)).not.toContain("sk_live_super_secret");
  });
});

describe("organization model constraints", () => {
  it("permits only one default organization", async () => {
    await Organization.init();
    await expect(makeOrg("third-brand", true)).rejects.toThrow(
      /duplicate key/i,
    );
  });

  it("allows many non-default organizations", async () => {
    await Organization.init();
    await expect(makeOrg("fourth-brand")).resolves.toBeDefined();
  });

  it("rejects a slug that is not url-safe", async () => {
    await expect(makeOrg("Not A Slug")).rejects.toThrow();
  });

  it("defaults a new organization to ACTIVE on Stripe", async () => {
    const doc = await Organization.findById(orgB).lean<{
      status: string;
      payments: { provider: string; sandbox: boolean };
      email: { transport: { port: number } };
    } | null>();
    expect(doc!.status).toBe(RecordState.ACTIVE);
    expect(doc!.payments.provider).toBe(PaymentGatewayKey.STRIPE);
    expect(doc!.payments.sandbox).toBe(false);
    // Nested sub-schema defaults materialise without being written.
    expect(doc!.email.transport.port).toBe(587);
  });
});

describe("organization membership constraints", () => {
  it("allows one membership row per (organization, user)", async () => {
    await OrganizationMember.init();
    const userId = new Types.ObjectId();
    await OrganizationMember.create({
      organizationId: orgA,
      userId,
      role: UserRole.ADMIN,
    });
    await expect(
      OrganizationMember.create({
        organizationId: orgA,
        userId,
        role: UserRole.STAFF,
      }),
    ).rejects.toThrow(/duplicate key/i);

    // ...but the same user may belong to a second organization.
    await expect(
      OrganizationMember.create({
        organizationId: orgB,
        userId,
        role: UserRole.STAFF,
      }),
    ).resolves.toBeDefined();
  });
});
