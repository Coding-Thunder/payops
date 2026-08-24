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
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { resolveOrganizationId } from "@/server/auth/organization";

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

let trip: Types.ObjectId;

beforeEach(async () => {
  await ensureMongo();
  sessionMock = await mockSession(actor);
  trip = await makeOrg("tripreservations", false);
});

/**
 * Template versioning and rollback.
 *
 * The per-organization override tests that used to lead this file are gone
 * with the second organization — "brand A's copy must not render in brand B's
 * email" has no subject on a single-tenant deployment. What survives is the
 * versioning machinery itself, which is ordinary product behaviour: an admin
 * edits copy, that becomes a new version, and a bad edit can be rolled back.
 */
describe("versioning and rollback", () => {
  it("lets an organization roll back its own version", async () => {
    const v1 = await createTemplateVersion(
      "payment-request",
      copy("Trip v1"),
      ctx,
    );
    await createTemplateVersion("payment-request", copy("Trip v2"), ctx);

    await activateTemplateVersion("payment-request", v1.id, ctx);
    const active = await getActiveTemplateContent(
      "payment-request",
      await resolveOrganizationId(),
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
      await getActiveTemplateContent("payment-confirmation", await resolveOrganizationId()),
    ).toBeNull();
  });
});

// Keep the session mock from leaking between files.
afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
});
