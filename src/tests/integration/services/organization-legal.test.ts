import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  PaymentGatewayKey,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import {
  GET as getLegalRoute,
  PATCH as patchLegalRoute,
} from "@/app/api/admin/settings/legal/route";
import { PATCH as patchSettingsRoute } from "@/app/api/admin/settings/route";
import {
  AuditLog,
  Order,
  Organization,
  OrganizationMember,
  Setting,
  SETTINGS_KEY,
} from "@/server/db/models";
import {
  DEFAULT_FLIGHT_CANCELLATION_POLICY,
  DEFAULT_FLIGHT_LEGAL_VERSION,
  DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
} from "@/server/db/models/setting.model";
import { orgCookieName } from "@/server/auth/org-cookie";
import { createOrder } from "@/server/services/order.service";
import {
  getOrganizationFlightLegal,
  type OrganizationFlightLegal,
  updateOrganizationFlightLegal,
} from "@/server/services/organization-legal.service";
import { resolveOrganizationServiceTypes } from "@/server/services/organization-service-types";
import { createSettings } from "@/tests/factories/settings.factory";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";
import {
  validCreateOrderInput,
  validFlightOrderInput,
} from "@/tests/fixtures/order-input.fixture";

/**
 * Admin → Settings → Flight terms: each organization's OWN flight terms and
 * cancellation policy (`legal.services.FLIGHT`).
 *
 * Organization-scoped, unlike the rest of that page (the deployment Settings
 * singleton is shared by every brand). So the properties pinned here:
 *
 *   - the organization comes ONLY from the request's validated selection —
 *     never from the body — so an admin can only change the brand they are
 *     working in;
 *   - a brand that does not sell flights has no flight terms to set;
 *   - versions move only when the text moves (v1 is the built-in default's,
 *     so an organization's first text of its own is v2), every change is
 *     audited against the organization, and nothing else is written;
 *   - new flight orders freeze the new text; existing orders keep theirs;
 *   - the deployment-wide settings PATCH behaves exactly as before.
 */

const admin = actorFor(UserRole.ADMIN, { name: "Admin User" });
const staff = actorFor(UserRole.STAFF, { name: "Staff User" });

const OWN_TERMS = "ALPHA FLIGHT TERMS: tickets follow the fare rules of the operating airline.";
const OWN_POLICY = "ALPHA FLIGHT POLICY: refunds are released once the airline refunds the fare.";

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
let alpha: Types.ObjectId;
let bravo: Types.ObjectId;
let carOnly: Types.ObjectId;

async function makeOrg(opts: {
  slug: string;
  serviceTypes?: ServiceType[];
  legal?: Record<string, unknown>;
  isDefault?: boolean;
}): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: opts.slug,
    name: opts.slug,
    brandName: `${opts.slug} brand`,
    isDefault: opts.isDefault ?? false,
    payments: { provider: PaymentGatewayKey.STRIPE },
    ...(opts.serviceTypes ? { serviceTypes: opts.serviceTypes } : {}),
    ...(opts.legal ? { legal: opts.legal } : {}),
  });
  const id = doc._id as Types.ObjectId;
  for (const actor of [admin, staff]) {
    await OrganizationMember.create({
      organizationId: id,
      userId: new Types.ObjectId(actor.id),
      role: actor.role,
      status: RecordState.ACTIVE,
    });
  }
  return id;
}

function actingAs(orgId: Types.ObjectId | null) {
  setNextHeaders(orgId ? { cookies: { [orgCookieName()]: String(orgId) } } : {});
}

const ctx = {
  actorId: admin.id,
  actorName: admin.name,
  actorRole: admin.role,
};

function input(over: { termsAndConditions?: string; cancellationPolicy?: string } = {}) {
  return {
    serviceType: ServiceType.FLIGHT,
    termsAndConditions: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
    cancellationPolicy: DEFAULT_FLIGHT_CANCELLATION_POLICY,
    ...over,
  };
}

async function rawLegal(orgId: Types.ObjectId) {
  const org = await Organization.findById(orgId).lean<{
    legal?: Record<string, unknown> & {
      services?: { FLIGHT?: Record<string, string> | null } | null;
    };
    updatedBy?: Types.ObjectId | null;
  } | null>();
  return org!;
}

async function legalAudits() {
  return AuditLog.find({ action: AuditAction.ORGANIZATION_LEGAL_UPDATED }).lean<
    {
      entityType: string;
      entityId: string;
      organizationId: Types.ObjectId | null;
      metadata: { serviceType: string; changes: Record<string, { from: unknown; to: unknown }> };
    }[]
  >();
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sessionMock = await mockSession(admin);
  alpha = await makeOrg({
    slug: "alphaair",
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT],
    legal: {
      termsAndConditions: "ALPHA CAR TERMS: drivers must be 25 or older.",
      termsVersion: "v2",
      cancellationPolicy: "ALPHA CAR POLICY: free cancellation up to two days ahead.",
      cancellationPolicyVersion: "v2",
    },
  });
  bravo = await makeOrg({
    slug: "bravotrips",
    serviceTypes: [ServiceType.FLIGHT],
  });
  carOnly = await makeOrg({ slug: "carsonly" });
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  setNextHeaders({});
});

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

describe("getOrganizationFlightLegal", () => {
  const DEFAULT_VIEW = {
    termsAndConditions: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
    termsVersion: DEFAULT_FLIGHT_LEGAL_VERSION,
    cancellationPolicy: DEFAULT_FLIGHT_CANCELLATION_POLICY,
    cancellationPolicyVersion: DEFAULT_FLIGHT_LEGAL_VERSION,
    termsIsDefault: true,
    policyIsDefault: true,
  };

  it("shows the built-in default, flagged as such, for an organization with no flight text", async () => {
    const view = await getOrganizationFlightLegal(alpha);
    expect(view).toEqual({
      organizationId: String(alpha),
      brandName: "alphaair brand",
      sellsFlight: true,
      ...DEFAULT_VIEW,
      // Alpha has organization-wide (car / hotel) text — which flight orders
      // never use; the editor says so.
      hasOrganizationWideText: true,
    });
    expect((await getOrganizationFlightLegal(bravo)).hasOrganizationWideText).toBe(false);
  });

  it("does the same whatever shape 'no text' is stored in", async () => {
    // services null (the schema default), FLIGHT null, the seed's empty
    // block, and no `services` key at all (a document written before it).
    const shapes: Record<string, unknown>[] = [
      { $set: { "legal.services": null } },
      { $set: { "legal.services": { FLIGHT: null } } },
      {
        $set: {
          "legal.services": {
            FLIGHT: {
              termsAndConditions: "",
              termsVersion: "",
              cancellationPolicy: "",
              cancellationPolicyVersion: "",
            },
          },
        },
      },
      { $unset: { "legal.services": "" } },
    ];
    for (const update of shapes) {
      await Organization.collection.updateOne({ _id: alpha }, update);
      expect(await getOrganizationFlightLegal(alpha)).toMatchObject(DEFAULT_VIEW);
    }
  });

  it("shows the organization's own text with its own version", async () => {
    await Organization.updateOne(
      { _id: alpha },
      {
        $set: {
          "legal.services": {
            FLIGHT: {
              termsAndConditions: OWN_TERMS,
              termsVersion: "v4",
              cancellationPolicy: OWN_POLICY,
              cancellationPolicyVersion: "",
            },
          },
        },
      },
    );
    expect(await getOrganizationFlightLegal(alpha)).toMatchObject({
      termsAndConditions: OWN_TERMS,
      termsVersion: "v4",
      cancellationPolicy: OWN_POLICY,
      // Own text with no stored version reads as v1.
      cancellationPolicyVersion: "v1",
      termsIsDefault: false,
      policyIsDefault: false,
    });
  });

  it("knows which organizations sell flights", async () => {
    expect((await getOrganizationFlightLegal(bravo)).sellsFlight).toBe(true);
    // No stored list reads as [CAR_RENTAL].
    expect((await getOrganizationFlightLegal(carOnly)).sellsFlight).toBe(false);
  });

  it("refuses an organization that does not exist", async () => {
    await expect(getOrganizationFlightLegal(new Types.ObjectId())).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Writing — the service
 * ------------------------------------------------------------------ */

describe("updateOrganizationFlightLegal", () => {
  it("refuses with 403 when no organization is selected", async () => {
    actingAs(null);
    const err = await updateOrganizationFlightLegal(input({ termsAndConditions: OWN_TERMS }), ctx).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).statusCode).toBe(403);
    expect((err as Error).message).toBe("Select an organization to continue");
  });

  it("refuses with 422 for an organization that does not sell flights", async () => {
    actingAs(carOnly);
    const err = await updateOrganizationFlightLegal(input({ termsAndConditions: OWN_TERMS }), ctx).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).statusCode).toBe(422);
    expect((err as Error).message).toMatch(/does not sell flights/);
    expect((await rawLegal(carOnly)).legal?.services ?? null).toBeNull();
  });

  it("treats saving the untouched defaults — or whitespace-only edits — as no change", async () => {
    actingAs(alpha);
    await expect(updateOrganizationFlightLegal(input(), ctx)).rejects.toThrow(
      "No changes to apply",
    );
    await expect(
      updateOrganizationFlightLegal(
        input({ termsAndConditions: `  ${DEFAULT_FLIGHT_TERMS_AND_CONDITIONS}\n` }),
        ctx,
      ),
    ).rejects.toThrow("No changes to apply");
    expect(await legalAudits()).toHaveLength(0);
  });

  it("re-versions only what changed, audits it against the organization, and writes nothing else", async () => {
    actingAs(alpha);
    const before = await rawLegal(alpha);

    const view = await updateOrganizationFlightLegal(input({ termsAndConditions: OWN_TERMS }), ctx);

    // The first text of its own is v2 (v1 is the built-in default's); the
    // untouched policy stays on the default.
    expect(view).toMatchObject<Partial<OrganizationFlightLegal>>({
      termsAndConditions: OWN_TERMS,
      termsVersion: "v2",
      termsIsDefault: false,
      cancellationPolicy: DEFAULT_FLIGHT_CANCELLATION_POLICY,
      cancellationPolicyVersion: DEFAULT_FLIGHT_LEGAL_VERSION,
      policyIsDefault: true,
    });

    const after = await rawLegal(alpha);
    // The car / general top-level text is never touched.
    for (const key of [
      "termsAndConditions",
      "termsVersion",
      "cancellationPolicy",
      "cancellationPolicyVersion",
    ]) {
      expect(after.legal![key]).toEqual(before.legal![key]);
    }
    expect(after.legal!.services!.FLIGHT).toMatchObject({
      termsAndConditions: OWN_TERMS,
      termsVersion: "v2",
      cancellationPolicy: "",
    });
    expect(String(after.updatedBy)).toBe(admin.id);

    const audits = await legalAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.entityType).toBe(AuditEntity.ORGANIZATION);
    expect(audits[0]!.entityId).toBe(String(alpha));
    expect(String(audits[0]!.organizationId)).toBe(String(alpha));
    expect(audits[0]!.metadata.serviceType).toBe(ServiceType.FLIGHT);
    expect(Object.keys(audits[0]!.metadata.changes).sort()).toEqual([
      "termsAndConditions",
      "termsVersion",
    ]);
    expect(audits[0]!.metadata.changes.termsVersion).toEqual({ from: "v1", to: "v2" });
  });

  it("bumps v2 → v3 on the next edit and keeps the other text", async () => {
    actingAs(alpha);
    await updateOrganizationFlightLegal(input({ termsAndConditions: OWN_TERMS }), ctx);
    const second = await updateOrganizationFlightLegal(
      input({ termsAndConditions: OWN_TERMS, cancellationPolicy: OWN_POLICY }),
      ctx,
    );
    expect(second).toMatchObject({
      termsAndConditions: OWN_TERMS,
      termsVersion: "v2",
      cancellationPolicy: OWN_POLICY,
      cancellationPolicyVersion: "v2",
    });

    const third = await updateOrganizationFlightLegal(
      input({ termsAndConditions: `${OWN_TERMS} Revised.`, cancellationPolicy: OWN_POLICY }),
      ctx,
    );
    expect(third.termsVersion).toBe("v3");
    expect(third.cancellationPolicyVersion).toBe("v2");
    expect(third.cancellationPolicy).toBe(OWN_POLICY);
  });

  it("bumps from a stale stored label even when its text is empty", async () => {
    await Organization.updateOne(
      { _id: alpha },
      {
        $set: {
          "legal.services": {
            FLIGHT: {
              termsAndConditions: "",
              termsVersion: "v5",
              cancellationPolicy: "",
              cancellationPolicyVersion: "",
            },
          },
        },
      },
    );
    actingAs(alpha);
    const view = await updateOrganizationFlightLegal(input({ termsAndConditions: OWN_TERMS }), ctx);
    expect(view.termsVersion).toBe("v6");
  });

  it("saves through every stored shape of 'no flight text'", async () => {
    for (const update of [
      { $set: { "legal.services": null } },
      { $set: { "legal.services": { FLIGHT: null } } },
      { $unset: { "legal.services": "" } },
      { $unset: { legal: "" } },
    ]) {
      await Organization.collection.updateOne({ _id: bravo }, update as never);
      actingAs(bravo);
      const view = await updateOrganizationFlightLegal(
        input({ termsAndConditions: OWN_TERMS }),
        ctx,
      );
      expect(view.termsAndConditions).toBe(OWN_TERMS);
      expect((await rawLegal(bravo)).legal!.services!.FLIGHT!.termsAndConditions).toBe(
        OWN_TERMS,
      );
    }
  });

  it("writes ONLY the selected organization", async () => {
    actingAs(alpha);
    const bravoBefore = await rawLegal(bravo);
    await updateOrganizationFlightLegal(input({ termsAndConditions: OWN_TERMS }), ctx);
    expect(await rawLegal(bravo)).toEqual(bravoBefore);
    expect((await getOrganizationFlightLegal(bravo)).termsIsDefault).toBe(true);
  });
});

describe("stale-tab guards — the organization still comes only from the selection", () => {
  it("refuses with 409 a save from a tab that was showing another brand", async () => {
    actingAs(alpha);
    const err = await updateOrganizationFlightLegal(
      { ...input({ termsAndConditions: OWN_TERMS }), expectedOrganizationId: String(bravo) },
      ctx,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).statusCode).toBe(409);
    // Neither brand was written, nothing was audited.
    expect((await getOrganizationFlightLegal(alpha)).termsIsDefault).toBe(true);
    expect((await getOrganizationFlightLegal(bravo)).termsIsDefault).toBe(true);
    expect(await legalAudits()).toHaveLength(0);
  });

  it("saves when the tab was showing the selected brand", async () => {
    actingAs(alpha);
    const view = await updateOrganizationFlightLegal(
      {
        ...input({ termsAndConditions: OWN_TERMS }),
        expectedOrganizationId: String(alpha),
        expectedTermsVersion: DEFAULT_FLIGHT_LEGAL_VERSION,
        expectedCancellationPolicyVersion: DEFAULT_FLIGHT_LEGAL_VERSION,
      },
      ctx,
    );
    expect(view.termsVersion).toBe("v2");
  });

  it("refuses with 409 a save over a newer edit of the same text", async () => {
    actingAs(alpha);
    await updateOrganizationFlightLegal(input({ termsAndConditions: OWN_TERMS }), ctx);

    // A second tab still showing v1 tries to save its own wording.
    const err = await updateOrganizationFlightLegal(
      {
        ...input({ termsAndConditions: `${OWN_TERMS} From a stale tab.` }),
        expectedTermsVersion: "v1",
      },
      ctx,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((await getOrganizationFlightLegal(alpha)).termsAndConditions).toBe(OWN_TERMS);

    const policyErr = await updateOrganizationFlightLegal(
      {
        ...input({ termsAndConditions: OWN_TERMS, cancellationPolicy: OWN_POLICY }),
        expectedCancellationPolicyVersion: "v7",
      },
      ctx,
    ).catch((e) => e);
    expect(policyErr).toBeInstanceOf(ConflictError);
    expect(await legalAudits()).toHaveLength(1);
  });

  it("answers 409 through the route, writing nothing", async () => {
    actingAs(alpha);
    const res = await patchLegalRoute(
      buildRequest("/api/admin/settings/legal", {
        method: "PATCH",
        body: { ...input({ termsAndConditions: OWN_TERMS }), expectedOrganizationId: String(bravo) },
      }),
    );
    expect(res.status).toBe(409);
    expect((await rawLegal(alpha)).legal?.services ?? null).toBeNull();
    expect((await rawLegal(bravo)).legal?.services ?? null).toBeNull();
  });
});

describe("what new and existing flight orders freeze after an edit", () => {
  it("new flight orders take the new text; earlier orders and car orders keep theirs", async () => {
    actingAs(alpha);
    const { order: before } = await createOrder(validFlightOrderInput(), { actor: admin });

    await updateOrganizationFlightLegal(
      input({ termsAndConditions: OWN_TERMS, cancellationPolicy: OWN_POLICY }),
      ctx,
    );

    const { order: after } = await createOrder(validFlightOrderInput(), { actor: admin });
    const { order: car } = await createOrder(validCreateOrderInput(), { actor: admin });

    const docs = await Order.find({ _id: { $in: [before.id, after.id, car.id] } }).lean<
      { _id: Types.ObjectId; terms: { text: string; version: string }; policy: { text: string; version: string } }[]
    >();
    const byId = (id: string) => docs.find((d) => String(d._id) === id)!;

    expect(byId(before.id).terms).toEqual({
      text: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });
    expect(byId(after.id).terms).toEqual({ text: OWN_TERMS, version: "v2" });
    expect(byId(after.id).policy).toMatchObject({ text: OWN_POLICY, version: "v2" });
    // Alpha's car orders still freeze its car text.
    expect(byId(car.id).terms).toEqual({
      text: "ALPHA CAR TERMS: drivers must be 25 or older.",
      version: "v2",
    });
  });
});

/* ------------------------------------------------------------------ *
 * The route
 * ------------------------------------------------------------------ */

describe("/api/admin/settings/legal", () => {
  function patch(body: unknown) {
    return patchLegalRoute(
      buildRequest("/api/admin/settings/legal", { method: "PATCH", body }),
    );
  }

  it("GET returns the selected organization's flight terms", async () => {
    actingAs(bravo);
    const { status, body } = await jsonBody<{ ok: true; data: OrganizationFlightLegal }>(
      await getLegalRoute(),
    );
    expect(status).toBe(200);
    expect(body.data.organizationId).toBe(String(bravo));
    expect(body.data.termsIsDefault).toBe(true);
  });

  it("GET refuses without a selected organization", async () => {
    actingAs(null);
    const res = await getLegalRoute();
    expect(res.status).toBe(403);
  });

  it("refuses STAFF on both GET and PATCH", async () => {
    sessionMock?.restore();
    sessionMock = await mockSession(staff);
    actingAs(alpha);
    expect((await getLegalRoute()).status).toBe(403);
    expect(
      (await patch(input({ termsAndConditions: OWN_TERMS }))).status,
    ).toBe(403);
    expect((await rawLegal(alpha)).legal?.services ?? null).toBeNull();
  });

  it("PATCH writes the cookie's organization and ignores an organizationId in the body", async () => {
    actingAs(alpha);
    const { status, body } = await jsonBody<{ ok: true; data: OrganizationFlightLegal }>(
      await patch({
        ...input({ termsAndConditions: OWN_TERMS }),
        organizationId: String(bravo),
      }),
    );
    expect(status).toBe(200);
    expect(body.data.organizationId).toBe(String(alpha));
    expect((await getOrganizationFlightLegal(alpha)).termsAndConditions).toBe(OWN_TERMS);
    expect((await getOrganizationFlightLegal(bravo)).termsIsDefault).toBe(true);
  });

  it("PATCH answers 422 for an invalid body, and for a service other than FLIGHT", async () => {
    actingAs(alpha);
    expect((await patch({ ...input(), termsAndConditions: "too short" })).status).toBe(422);
    expect(
      (await patch({ ...input({ termsAndConditions: OWN_TERMS }), serviceType: ServiceType.HOTEL }))
        .status,
    ).toBe(422);
  });

  it("PATCH never touches the deployment Settings singleton", async () => {
    const before = await Setting.findOne({ key: SETTINGS_KEY }).lean<Record<string, unknown>>();
    actingAs(alpha);
    await patch(input({ termsAndConditions: OWN_TERMS }));
    const after = await Setting.findOne({ key: SETTINGS_KEY }).lean<Record<string, unknown>>();
    expect(after).toEqual(before);
  });
});

describe("the deployment-wide settings PATCH is unchanged", () => {
  function patchSettings(body: unknown) {
    return patchSettingsRoute(buildRequest("/api/admin/settings", { method: "PATCH", body }));
  }

  /** The whole form, as the settings page posts it, from what is stored. */
  async function currentSettingsForm(over: Record<string, unknown> = {}) {
    const s = await Setting.findOne({ key: SETTINGS_KEY }).lean<Record<string, unknown> | null>();
    return {
      paymentExpiryHours: s!.paymentExpiryHours,
      orderPrefix: s!.orderPrefix,
      allowedBookingTypes: s!.allowedBookingTypes,
      defaultCurrency: s!.defaultCurrency,
      successRedirectUrl: s!.successRedirectUrl,
      cancelRedirectUrl: s!.cancelRedirectUrl,
      cancellationPolicy: s!.cancellationPolicy,
      consentMode: s!.consentMode,
      consentMessage: s!.consentMessage,
      termsAndConditions: s!.termsAndConditions,
      ...over,
    };
  }

  it("re-versions changed car terms, audits the diff, and leaves every organization alone", async () => {
    const orgBefore = await rawLegal(alpha);
    actingAs(alpha);
    const newTerms = "SETTINGS CAR TERMS, REVISED: present a valid licence when collecting the car.";
    const { status, body } = await jsonBody<{
      ok: true;
      data: { termsAndConditions: string; termsVersion: string; cancellationPolicyVersion: string };
    }>(await patchSettings(await currentSettingsForm({ termsAndConditions: newTerms })));

    expect(status).toBe(200);
    expect(body.data.termsAndConditions).toBe(newTerms);
    expect(body.data.termsVersion).toBe("v2");
    expect(body.data.cancellationPolicyVersion).toBe("v1");

    const audit = await AuditLog.findOne({ action: AuditAction.SETTINGS_UPDATED }).lean<{
      entityType: string;
      metadata: { changes: Record<string, unknown> };
    } | null>();
    expect(audit!.entityType).toBe(AuditEntity.SETTINGS);
    expect(Object.keys(audit!.metadata.changes).sort()).toEqual([
      "termsAndConditions",
      "termsVersion",
    ]);
    expect(await rawLegal(alpha)).toEqual(orgBefore);
    expect(await legalAudits()).toHaveLength(0);
  });

  it("still refuses a save that changes nothing", async () => {
    actingAs(alpha);
    const res = await patchSettings(await currentSettingsForm());
    const { status, body } = await jsonBody<{ ok: false; error: { message: string } }>(res);
    expect(status).toBe(422);
    expect(body.error.message).toBe("No changes to apply");
  });
});

describe("resolveOrganizationServiceTypes", () => {
  it("reads the stored list, defaulting an absent one to [CAR_RENTAL]", async () => {
    expect(await resolveOrganizationServiceTypes(String(alpha))).toEqual([
      ServiceType.CAR_RENTAL,
      ServiceType.FLIGHT,
    ]);
    expect(await resolveOrganizationServiceTypes(String(bravo))).toEqual([ServiceType.FLIGHT]);
    expect(await resolveOrganizationServiceTypes(String(carOnly))).toEqual([
      ServiceType.CAR_RENTAL,
    ]);
    await Organization.collection.updateOne({ _id: bravo }, { $set: { serviceTypes: [] } });
    expect(await resolveOrganizationServiceTypes(String(bravo))).toEqual([
      ServiceType.CAR_RENTAL,
    ]);
  });

  it("gives an unknown organization and no organization [CAR_RENTAL]", async () => {
    expect(await resolveOrganizationServiceTypes(String(new Types.ObjectId()))).toEqual([
      ServiceType.CAR_RENTAL,
    ]);
    expect(await resolveOrganizationServiceTypes(null)).toEqual([ServiceType.CAR_RENTAL]);
  });
});
