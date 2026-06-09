import { Types } from "mongoose";
import { beforeEach, describe, expect, it } from "vitest";

import { UserRole } from "@/lib/constants/enums";
import { EmailTemplate } from "@/server/db/models";
import {
  activateTemplateVersion,
  createTemplateVersion,
  getActiveTemplate,
  getActiveTemplateContent,
  listTemplateVersions,
} from "@/server/services/email-template.service";
import type { CreateEmailTemplateVersionInput } from "@/lib/validation";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/** Schema is strict on the full content shape; tests only care about
 *  one field per case. The runtime path treats missing fields as
 *  nulls, but the input type insists on all keys. Cast through this
 *  helper so call sites stay readable. */
function content(
  partial: Partial<CreateEmailTemplateVersionInput>,
): CreateEmailTemplateVersionInput {
  return partial as CreateEmailTemplateVersionInput;
}

/**
 * Phase 3d: per-org email-template versioning. Each tenant has their
 * own version stream, Tenant #2 saving v1 doesn't see / collide with
 * Tenant #1's v17.
 */

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
});

function newOrgId(): string {
  return new Types.ObjectId().toString();
}

function actor(orgId: string) {
  return {
    actor: {
      id: new Types.ObjectId().toString(),
      name: "Ada",
      role: UserRole.SUPER_ADMIN,
    },
    orgId,
    request: null,
  };
}

describe("createTemplateVersion + getActiveTemplate, per-org", () => {
  it("each org gets its own version 1", async () => {
    const orgA = newOrgId();
    const orgB = newOrgId();

    const a = await createTemplateVersion(
      "payment-confirmation",
      content({ greeting: "Hi from orgA," }),
      actor(orgA),
    );
    const b = await createTemplateVersion(
      "payment-confirmation",
      content({ greeting: "Hi from orgB," }),
      actor(orgB),
    );
    expect(a.version).toBe(1);
    expect(b.version).toBe(1);

    // Each org's active version is its own row.
    const activeA = await getActiveTemplate("payment-confirmation", orgA);
    const activeB = await getActiveTemplate("payment-confirmation", orgB);
    expect(activeA?.greeting).toBe("Hi from orgA,");
    expect(activeB?.greeting).toBe("Hi from orgB,");
  });

  it("saving a new version only deactivates THIS tenant's previous active", async () => {
    const orgA = newOrgId();
    const orgB = newOrgId();
    await createTemplateVersion(
      "payment-confirmation",
      content({ greeting: "A v1" }),
      actor(orgA),
    );
    await createTemplateVersion(
      "payment-confirmation",
      content({ greeting: "B v1" }),
      actor(orgB),
    );
    // OrgA rolls forward to v2, B's v1 stays active.
    await createTemplateVersion(
      "payment-confirmation",
      content({ greeting: "A v2" }),
      actor(orgA),
    );

    const activeA = await getActiveTemplate("payment-confirmation", orgA);
    const activeB = await getActiveTemplate("payment-confirmation", orgB);
    expect(activeA?.greeting).toBe("A v2");
    expect(activeB?.greeting).toBe("B v1");

    const versionsA = await listTemplateVersions("payment-confirmation", orgA);
    expect(versionsA.length).toBe(2);
    const versionsB = await listTemplateVersions("payment-confirmation", orgB);
    expect(versionsB.length).toBe(1);
  });

  it("getActiveTemplateContent returns null when no per-org template exists", async () => {
    const orgA = newOrgId();
    const content = await getActiveTemplateContent(
      "payment-confirmation",
      orgA,
    );
    // Null falls through to the code's hardcoded copy, the email
    // renderer treats this as "use defaults", which is the right
    // behaviour for a tenant that hasn't customized anything.
    expect(content).toBeNull();
  });
});

describe("activateTemplateVersion, cross-tenant guard", () => {
  it("orgB can't activate orgA's version by id", async () => {
    const orgA = newOrgId();
    const orgB = newOrgId();
    const a = await createTemplateVersion(
      "payment-confirmation",
      content({ greeting: "A v1" }),
      actor(orgA),
    );
    // OrgB tries to activate orgA's version id, refused as not found.
    await expect(
      activateTemplateVersion("payment-confirmation", a.id, actor(orgB)),
    ).rejects.toThrow(/not found/i);
  });

  it("a tenant can re-activate an older version of their own template", async () => {
    const orgA = newOrgId();
    const v1 = await createTemplateVersion(
      "payment-confirmation",
      content({ greeting: "v1" }),
      actor(orgA),
    );
    await createTemplateVersion(
      "payment-confirmation",
      content({ greeting: "v2" }),
      actor(orgA),
    );
    // Re-activate v1.
    const rolled = await activateTemplateVersion(
      "payment-confirmation",
      v1.id,
      actor(orgA),
    );
    expect(rolled.version).toBe(1);
    expect(rolled.active).toBe(true);
    // Exactly one active row for this (org, templateKey).
    const activeRows = await EmailTemplate.countDocuments({
      orgId: new Types.ObjectId(orgA),
      templateKey: "payment-confirmation",
      active: true,
    });
    expect(activeRows).toBe(1);
  });
});
