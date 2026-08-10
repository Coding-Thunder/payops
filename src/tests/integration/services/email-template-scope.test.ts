import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import {
  PaymentGatewayKey,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import {
  EmailTemplate,
  type EmailTemplateKey,
  Organization,
  OrganizationMember,
} from "@/server/db/models";
import type { CreateEmailTemplateVersionInput } from "@/lib/validation";
import {
  activateTemplateVersion,
  createTemplateVersion,
  getActiveTemplateContent,
  listTemplateVersions,
} from "@/server/services/email-template.service";
import { orgCookieName } from "@/server/auth/org-cookie";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { setNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo } from "@/tests/utils/db";

/**
 * The no-code email-template editor, per organization.
 *
 * `email_templates` carries the organizationScope plugin and the model's own
 * comment promised a resolver — but the service queried
 * `{ templateKey, active: true }` with no scope at all. Whatever one brand's
 * admin typed became the live subject/greeting/intro for BOTH brands, and
 * saving a version switched off the other brand's live template.
 *
 * The resolution rule is OVERRIDE-THEN-SHARED: a row stamped with the
 * organization wins, otherwise the shared (null) row applies. The null bucket
 * is a deliberate deployment-wide default here, not pre-migration residue.
 */

const actor = actorFor(UserRole.ADMIN);
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

async function makeOrg(slug: string, isDefault: boolean) {
  const doc = await Organization.create({
    slug,
    name: slug,
    brandName: `${slug} brand`,
    isDefault,
    payments: { provider: PaymentGatewayKey.STRIPE },
  });
  const id = doc._id as Types.ObjectId;
  await OrganizationMember.create({
    organizationId: id,
    userId: new Types.ObjectId(actor.id),
    role: UserRole.ADMIN,
    status: RecordState.ACTIVE,
  });
  return id;
}

function actingAs(orgId: Types.ObjectId | null) {
  setNextHeaders(orgId ? { cookies: { [orgCookieName()]: String(orgId) } } : {});
}

const ctx = { actor: { id: actor.id, name: actor.name, role: actor.role } };

/** Only `subject` matters to these tests; the input type wants every field. */
function copy(subject: string): CreateEmailTemplateVersionInput {
  return {
    subject,
    greeting: null,
    intro: null,
    note: null,
    supportHeadline: null,
    supportDescription: null,
    footerNote: null,
  };
}

/** A deployment-wide default row: the shared bucket every brand falls back
 *  to. Written directly because no service path authors an unowned row. */
async function sharedRow(templateKey: EmailTemplateKey, subject: string) {
  await EmailTemplate.create({
    templateKey,
    organizationId: null,
    version: 1,
    active: true,
    subject,
    createdBy: { userId: new Types.ObjectId(actor.id), name: actor.name },
  });
}

let rc: Types.ObjectId;
let trip: Types.ObjectId;

beforeEach(async () => {
  await ensureMongo();
  sessionMock = await mockSession(actor);
  rc = await makeOrg("rentalconfirmation", true);
  trip = await makeOrg("tripreservations", false);
});

describe("one brand's template copy never renders in the other's email", () => {
  it("does not serve an organization's override to a different organization", async () => {
    actingAs(rc);
    await createTemplateVersion(
      "payment-request",
      copy("RC ONLY subject"),
      ctx,
    );

    const forTrip = await getActiveTemplateContent(
      "payment-request",
      String(trip),
    );
    expect(forTrip?.subject ?? null).not.toBe("RC ONLY subject");
  });

  it("serves an organization its own override", async () => {
    actingAs(trip);
    await createTemplateVersion(
      "payment-request",
      copy("Trip subject"),
      ctx,
    );

    const forTrip = await getActiveTemplateContent(
      "payment-request",
      String(trip),
    );
    expect(forTrip?.subject).toBe("Trip subject");
  });

  it("falls back to a shared (null-organization) row when the brand has no override", async () => {
    // A row written before organizations existed, or a deliberate
    // deployment-wide default.
    await sharedRow("payment-request", "Shared default subject");

    const forTrip = await getActiveTemplateContent(
      "payment-request",
      String(trip),
    );
    expect(forTrip?.subject).toBe("Shared default subject");
  });

  it("prefers the organization's own row over the shared one", async () => {
    await sharedRow("payment-request", "Shared default subject");
    actingAs(trip);
    await createTemplateVersion(
      "payment-request",
      copy("Trip override"),
      ctx,
    );

    const forTrip = await getActiveTemplateContent(
      "payment-request",
      String(trip),
    );
    expect(forTrip?.subject).toBe("Trip override");
    // ...and the other brand still gets the shared copy.
    const forRc = await getActiveTemplateContent("payment-request", String(rc));
    expect(forRc?.subject).toBe("Shared default subject");
  });
});

describe("saving a version does not disturb the other brand", () => {
  it("leaves the other organization's active row active", async () => {
    actingAs(rc);
    await createTemplateVersion("payment-request", copy("RC v1"), ctx);
    actingAs(trip);
    await createTemplateVersion("payment-request", copy("Trip v1"), ctx);

    // Before the fix, `updateMany({templateKey, active:true})` flipped off
    // every organization's live row, so RC silently lost its copy.
    const rcActive = await getActiveTemplateContent(
      "payment-request",
      String(rc),
    );
    expect(rcActive?.subject).toBe("RC v1");
  });

  it("numbers versions per organization, so both brands can hold a version 1", async () => {
    actingAs(rc);
    const a = await createTemplateVersion(
      "payment-request",
      copy("RC v1"),
      ctx,
    );
    actingAs(trip);
    const b = await createTemplateVersion(
      "payment-request",
      copy("Trip v1"),
      ctx,
    );
    expect(a.version).toBe(1);
    expect(b.version).toBe(1);
  });

  it("increments within an organization", async () => {
    actingAs(trip);
    await createTemplateVersion("payment-request", copy("v1"), ctx);
    const second = await createTemplateVersion(
      "payment-request",
      copy("v2"),
      ctx,
    );
    expect(second.version).toBe(2);
    const active = await getActiveTemplateContent(
      "payment-request",
      String(trip),
    );
    expect(active?.subject).toBe("v2");
  });
});

describe("the admin screens are scoped", () => {
  it("does not list another organization's versions", async () => {
    actingAs(rc);
    const rcVersion = await createTemplateVersion(
      "payment-request",
      copy("RC v1"),
      ctx,
    );

    actingAs(trip);
    const listed = await listTemplateVersions("payment-request");
    expect(listed.map((v) => v.id)).not.toContain(rcVersion.id);
  });

  it("refuses to activate another organization's version, as NOT FOUND", async () => {
    // Forbidden would confirm the id exists and let one brand's admin
    // enumerate the other's version ids.
    actingAs(rc);
    const a = await createTemplateVersion(
      "payment-request",
      copy("RC v1"),
      ctx,
    );
    await createTemplateVersion("payment-request", copy("RC v2"), ctx);

    actingAs(trip);
    await expect(
      activateTemplateVersion("payment-request", a.id, ctx),
    ).rejects.toThrow(/not found/i);
  });

  it("lets an organization roll back its own version", async () => {
    actingAs(trip);
    const v1 = await createTemplateVersion(
      "payment-request",
      copy("Trip v1"),
      ctx,
    );
    await createTemplateVersion("payment-request", copy("Trip v2"), ctx);

    await activateTemplateVersion("payment-request", v1.id, ctx);
    const active = await getActiveTemplateContent(
      "payment-request",
      String(trip),
    );
    expect(active?.subject).toBe("Trip v1");
  });
});

describe("sends with no organization still work", () => {
  it("resolves the shared row for an unattributed order", async () => {
    await sharedRow("payment-confirmation", "Shared confirmation");
    const content = await getActiveTemplateContent(
      "payment-confirmation",
      null,
    );
    expect(content?.subject).toBe("Shared confirmation");
  });

  it("returns null when nothing is configured at all", async () => {
    expect(
      await getActiveTemplateContent("payment-confirmation", String(trip)),
    ).toBeNull();
  });
});

// Keep the session mock from leaking between files.
afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
});
