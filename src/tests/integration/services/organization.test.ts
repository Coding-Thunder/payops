import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserRole } from "@/lib/constants/enums";
import { Organization, User } from "@/server/db/models";
import {
  getOrganization,
  renameOrganization,
} from "@/server/services/organization.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * organization.service — renames + reads. Slug stays immutable post-
 * creation (no mutation surface for it on this service) so the only
 * thing to test is the rename audit trail + validation.
 */

describe("organization.service", () => {
  let orgId: string;
  const actor = {
    id: new Types.ObjectId().toString(),
    name: "Ada Lovelace",
    role: UserRole.SUPER_ADMIN,
  };

  beforeEach(async () => {
    await ensureMongo();
    const ownerId = new Types.ObjectId();
    await User.create({
      _id: ownerId,
      name: "Ada",
      email: `o-${ownerId.toString().slice(-6)}@x.test`,
      passwordHash: "x".repeat(60),
      role: UserRole.SUPER_ADMIN,
      status: "ACTIVE",
    });
    const org = await Organization.create({
      slug: `t-${ownerId.toString().slice(-8)}`,
      name: "Original Name",
      ownerUserId: ownerId,
      status: "ACTIVE",
    });
    orgId = String(org._id);
  });

  afterEach(async () => {
    await resetDatabase();
  });

  it("getOrganization returns the persisted shape", async () => {
    const dto = await getOrganization(orgId);
    expect(dto.id).toBe(orgId);
    expect(dto.name).toBe("Original Name");
    expect(dto.slug).toMatch(/^t-/);
  });

  it("renameOrganization updates the name", async () => {
    const dto = await renameOrganization(
      orgId,
      { name: "Acme Coffee" },
      { actor },
    );
    expect(dto.name).toBe("Acme Coffee");

    const reread = await getOrganization(orgId);
    expect(reread.name).toBe("Acme Coffee");
  });

  it("rename is a no-op (no error, no audit row) when the name is unchanged", async () => {
    const dto = await renameOrganization(
      orgId,
      { name: "Original Name" },
      { actor },
    );
    expect(dto.name).toBe("Original Name");
  });

  it("rejects an empty name", async () => {
    await expect(
      renameOrganization(orgId, { name: "   " }, { actor }),
    ).rejects.toThrow(/between 1 and 120/);
  });

  it("rejects a name longer than 120 chars", async () => {
    await expect(
      renameOrganization(orgId, { name: "x".repeat(121) }, { actor }),
    ).rejects.toThrow(/between 1 and 120/);
  });

  it("throws NotFound for an unknown org", async () => {
    await expect(
      renameOrganization(
        new Types.ObjectId().toString(),
        { name: "Ghost Inc" },
        { actor },
      ),
    ).rejects.toThrow(/not found/i);
  });

  it("does NOT mutate the slug on rename", async () => {
    const before = await getOrganization(orgId);
    await renameOrganization(orgId, { name: "Renamed Again" }, { actor });
    const after = await getOrganization(orgId);
    expect(after.slug).toBe(before.slug);
  });
});
