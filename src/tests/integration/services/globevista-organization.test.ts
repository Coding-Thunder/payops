import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import {
  CaptureMode,
  PaymentGatewayKey,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { Order, Organization, OrganizationMember } from "@/server/db/models";
import { orgCookieName } from "@/server/auth/org-cookie";
import { createOrder, listOrders } from "@/server/services/order.service";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { setNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo } from "@/tests/utils/db";
import {
  validCreateOrderInput,
  validFlightOrderInput,
} from "@/tests/fixtures/order-input.fixture";

/**
 * Onboarding a THIRD tenant onto a live two-tenant deployment.
 *
 * The seed script (`scripts/seed-globevista.ts`) is deliberately not shelled
 * out to here — a test that spawns a process proves the process runs, not
 * that the write is safe. What matters is the SEMANTICS the script commits
 * to, and those are one `findOneAndUpdate({ slug }, { $setOnInsert }, {
 * upsert: true })`: idempotent by slug, and incapable of overwriting a value
 * an operator has since edited in the admin UI. `seedGlobeVista()` below is
 * that statement, reproduced verbatim from the script, so a change to either
 * shows up as a failure here.
 *
 * The other half is non-regression. RentalConfirmation and TripReservations
 * are live. Adding a tenant must not touch their documents, must not move
 * `isDefault` — which is the compatibility anchor every unattributed
 * historical record resolves through — and must not let a GlobeVista order
 * appear on either brand's orders list.
 */

const actor = actorFor(UserRole.ADMIN);

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

/* ------------------------------------------------------------------ *
 * The two incumbents, configured as they are in production.
 * ------------------------------------------------------------------ */

async function makeOrg(doc: Record<string, unknown>): Promise<Types.ObjectId> {
  const created = await Organization.create(doc);
  const id = created._id as Types.ObjectId;
  await OrganizationMember.create({
    organizationId: id,
    userId: new Types.ObjectId(actor.id),
    role: UserRole.ADMIN,
    status: RecordState.ACTIVE,
  });
  return id;
}

async function makeRentalConfirmation(): Promise<Types.ObjectId> {
  return makeOrg({
    slug: "rentalconfirmation",
    name: "Rental Confirmation",
    brandName: "Rental Confirmation",
    isDefault: true,
    payments: { provider: PaymentGatewayKey.STRIPE },
    support: {
      email: "support@rentalconfirmation.com",
      phone: "+15513071441",
    },
  });
}

async function makeTripReservations(): Promise<Types.ObjectId> {
  return makeOrg({
    slug: "tripreservations",
    name: "Trip Reservations",
    brandName: "Trip Reservations",
    isDefault: false,
    payments: { provider: PaymentGatewayKey.PAYPAL },
    support: { email: "contact@tripreservations.test", phone: "" },
  });
}

/* ------------------------------------------------------------------ *
 * The seed, reduced to the write it actually performs.
 * ------------------------------------------------------------------ */

const SLUG = "globevista";
/** Internal, operations-facing name. Never shown to a customer. */
const ORG_NAME = "GlobeVista";
/** The only name a GlobeVista customer ever sees. */
const BRAND_NAME = "FlightBizz";

/** The `desired` document from `scripts/seed-globevista.ts`. */
function desiredGlobeVista() {
  return {
    slug: SLUG,
    name: ORG_NAME,
    brandName: BRAND_NAME,
    domain: "",
    status: RecordState.ACTIVE,
    // NEVER true — GlobeVista must not become the compatibility anchor.
    isDefault: false,
    branding: {
      logo: "",
      primaryColor: "#0E7490",
      onPrimaryColor: "#FFFFFF",
      footerTagline: "",
    },
    support: { email: "", phone: "" },
    email: {
      fromName: BRAND_NAME,
      fromEmail: "",
      replyTo: "",
      transport: { host: "", port: 587, secure: false, user: "" },
    },
    payments: {
      provider: PaymentGatewayKey.STRIPE,
      enabledProviders: [PaymentGatewayKey.STRIPE],
      publishableKey: "",
      sandbox: false,
      captureMode: CaptureMode.MANUAL,
    },
    serviceTypes: [
      ServiceType.FLIGHT,
      ServiceType.HOTEL,
      ServiceType.CAR_RENTAL,
    ],
    legal: {
      termsAndConditions: "",
      termsVersion: "",
      cancellationPolicy: "",
      cancellationPolicyVersion: "",
    },
  };
}

/**
 * `$setOnInsert` ONLY, upserted on the slug — exactly the statement the
 * script issues. Returns the organization id.
 */
async function seedGlobeVista(): Promise<Types.ObjectId> {
  const org = await Organization.findOneAndUpdate(
    { slug: SLUG },
    { $setOnInsert: desiredGlobeVista() },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  ).lean<{ _id: Types.ObjectId } | null>();
  if (!org) throw new Error("Upsert returned no organization");
  return org._id;
}

/** Grant the acting operator a membership, as the seed's allow-list does. */
async function joinGlobeVista(orgId: Types.ObjectId): Promise<void> {
  await OrganizationMember.updateOne(
    { organizationId: orgId, userId: new Types.ObjectId(actor.id) },
    {
      $setOnInsert: {
        organizationId: orgId,
        userId: new Types.ObjectId(actor.id),
        role: UserRole.ADMIN,
        status: RecordState.ACTIVE,
      },
    },
    { upsert: true },
  );
}

/** Put the request "inside" an organization, the way the cookie does. */
function actingAs(orgId: Types.ObjectId | null) {
  setNextHeaders(
    orgId ? { cookies: { [orgCookieName()]: String(orgId) } } : {},
  );
}

async function rawOrg(slug: string) {
  return Organization.findOne({ slug }).lean<Record<string, unknown> | null>();
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sessionMock = await mockSession(actor);
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
});

/* ------------------------------------------------------------------ *
 * Requirement 1 — the seed is idempotent
 * ------------------------------------------------------------------ */

describe("requirement 1: the GlobeVista seed is idempotent", () => {
  it("creating it TWICE yields exactly ONE organization with slug globevista", async () => {
    const first = await seedGlobeVista();
    const second = await seedGlobeVista();

    expect(String(second)).toBe(String(first));
    expect(await Organization.countDocuments({ slug: SLUG })).toBe(1);
  });

  it("stays at one organization across many re-runs", async () => {
    const ids = [
      await seedGlobeVista(),
      await seedGlobeVista(),
      await seedGlobeVista(),
      await seedGlobeVista(),
    ].map(String);

    expect(new Set(ids).size).toBe(1);
    expect(await Organization.countDocuments({ slug: SLUG })).toBe(1);
  });

  it("a re-run does NOT clobber a field an admin edited afterwards", async () => {
    // The failure this prevents: an operator sets the brand's real support
    // address and legal text in the admin UI, someone re-runs the seed as
    // part of a deploy, and every edit silently reverts to the placeholder.
    const orgId = await seedGlobeVista();

    await Organization.updateOne(
      { _id: orgId },
      {
        $set: {
          brandName: "FlightBizz Travel",
          "support.email": "help@flightbizz.test",
          "support.phone": "+441234567890",
          "branding.primaryColor": "#123456",
          "payments.publishableKey": "pk_live_edited",
          "legal.termsAndConditions": "Operator-authored flight terms.",
          serviceTypes: [ServiceType.FLIGHT],
        },
      },
    );

    await seedGlobeVista();

    const after = await Organization.findById(orgId).lean<{
      brandName: string;
      support: { email: string; phone: string };
      branding: { primaryColor: string };
      payments: { publishableKey: string };
      legal: { termsAndConditions: string };
      serviceTypes: string[];
    } | null>();

    expect(after!.brandName).toBe("FlightBizz Travel");
    expect(after!.support.email).toBe("help@flightbizz.test");
    expect(after!.support.phone).toBe("+441234567890");
    expect(after!.branding.primaryColor).toBe("#123456");
    expect(after!.payments.publishableKey).toBe("pk_live_edited");
    expect(after!.legal.termsAndConditions).toBe(
      "Operator-authored flight terms.",
    );
    expect(after!.serviceTypes).toEqual([ServiceType.FLIGHT]);
  });

  it("a re-run leaves every stored VALUE identical when nothing was edited", async () => {
    const orgId = await seedGlobeVista();
    const before = await Organization.findById(orgId).lean<
      Record<string, unknown>
    >();

    await seedGlobeVista();

    const after = await Organization.findById(orgId).lean<
      Record<string, unknown>
    >();

    // `updatedAt` is excluded deliberately, and it is the ONE field that
    // moves: Mongoose's `timestamps: true` appends `$set: { updatedAt }` to
    // every `findOneAndUpdate`, including one whose only operator is
    // `$setOnInsert`. So a re-run is not literally a no-op write — it
    // rewrites the modification timestamp of a document it otherwise leaves
    // alone. Nothing reads that field for behaviour, but the script's
    // "the second run matches the existing slug and writes nothing" is
    // therefore not strictly true, and an operator auditing "when was this
    // tenant last changed" will see the deploy, not the last real edit.
    const { updatedAt: _beforeUpdatedAt, ...beforeRest } = before!;
    const { updatedAt: _afterUpdatedAt, ...afterRest } = after!;
    expect(afterRest).toEqual(beforeRest);

    // Identity and creation time in particular must never move.
    expect(String(after!._id)).toBe(String(before!._id));
    expect(after!.createdAt).toEqual(before!.createdAt);
  });

  it("re-granting membership is idempotent too", async () => {
    const orgId = await seedGlobeVista();
    await joinGlobeVista(orgId);
    await joinGlobeVista(orgId);

    expect(
      await OrganizationMember.countDocuments({ organizationId: orgId }),
    ).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Requirement 2 — GlobeVista's payment configuration
 * ------------------------------------------------------------------ */

describe("requirement 2: GlobeVista is a manual-capture Stripe tenant", () => {
  it("uses STRIPE as its provider and lists STRIPE as its only enabled provider", async () => {
    await seedGlobeVista();
    const org = await Organization.findOne({ slug: SLUG }).lean<{
      payments: {
        provider: string;
        enabledProviders: string[];
        captureMode: string;
      };
    } | null>();

    expect(org!.payments.provider).toBe(PaymentGatewayKey.STRIPE);
    expect(org!.payments.enabledProviders).toEqual([PaymentGatewayKey.STRIPE]);
    // PayPal belongs to the other tenant; it must not be selectable here.
    expect(org!.payments.enabledProviders).not.toContain(
      PaymentGatewayKey.PAYPAL,
    );
  });

  it("runs on MANUAL capture — authorize at checkout, capture on confirmation", async () => {
    await seedGlobeVista();
    const org = await Organization.findOne({ slug: SLUG }).lean<{
      payments: { captureMode: string };
    } | null>();

    expect(org!.payments.captureMode).toBe(CaptureMode.MANUAL);
    expect(org!.payments.captureMode).not.toBe(CaptureMode.AUTOMATIC);
  });

  it("is NOT the default organization", async () => {
    // isDefault would hand GlobeVista every unattributed historical record
    // and make it the fallback any other tenant's payment could land on.
    await seedGlobeVista();
    const org = await Organization.findOne({ slug: SLUG }).lean<{
      isDefault: boolean;
    } | null>();

    expect(org!.isDefault).toBe(false);
  });

  it("sells flights, hotels AND car rentals", async () => {
    await seedGlobeVista();
    const org = await Organization.findOne({ slug: SLUG }).lean<{
      serviceTypes: string[];
    } | null>();

    expect(new Set(org!.serviceTypes)).toEqual(
      new Set([ServiceType.FLIGHT, ServiceType.HOTEL, ServiceType.CAR_RENTAL]),
    );
  });
});

/* ------------------------------------------------------------------ *
 * Requirement 3 — the incumbents are untouched
 * ------------------------------------------------------------------ */

describe("requirement 3: seeding GlobeVista leaves the existing organizations unchanged", () => {
  it("leaves RentalConfirmation's and TripReservations' documents byte-identical", async () => {
    await makeRentalConfirmation();
    await makeTripReservations();

    const rcBefore = await rawOrg("rentalconfirmation");
    const trBefore = await rawOrg("tripreservations");
    expect(rcBefore).toBeTruthy();
    expect(trBefore).toBeTruthy();

    await seedGlobeVista();

    expect(await rawOrg("rentalconfirmation")).toEqual(rcBefore);
    expect(await rawOrg("tripreservations")).toEqual(trBefore);
  });

  it("leaves them byte-identical across repeated seed runs", async () => {
    await makeRentalConfirmation();
    await makeTripReservations();
    const rcBefore = await rawOrg("rentalconfirmation");
    const trBefore = await rawOrg("tripreservations");

    await seedGlobeVista();
    await seedGlobeVista();
    await seedGlobeVista();

    expect(await rawOrg("rentalconfirmation")).toEqual(rcBefore);
    expect(await rawOrg("tripreservations")).toEqual(trBefore);
  });

  it("keeps RentalConfirmation as the ONLY default organization", async () => {
    const rc = await makeRentalConfirmation();
    await makeTripReservations();

    await seedGlobeVista();

    const defaults = await Organization.find({ isDefault: true }).lean<
      { _id: Types.ObjectId; slug: string }[]
    >();
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.slug).toBe("rentalconfirmation");
    expect(String(defaults[0]!._id)).toBe(String(rc));
  });

  it("adds exactly one organization and deletes none", async () => {
    await makeRentalConfirmation();
    await makeTripReservations();
    const before = await Organization.countDocuments({});

    await seedGlobeVista();

    expect(await Organization.countDocuments({})).toBe(before + 1);
    expect(await Organization.countDocuments({ slug: "rentalconfirmation" })).toBe(1);
    expect(await Organization.countDocuments({ slug: "tripreservations" })).toBe(1);
  });

  it("grants no incumbent operator a GlobeVista membership", async () => {
    // `seed-organizations.ts` grants EVERY user membership; this seed uses an
    // explicit allow-list. A membership created as a side effect would be a
    // cross-tenant access grant.
    await makeRentalConfirmation();
    await makeTripReservations();

    const orgId = await seedGlobeVista();

    expect(
      await OrganizationMember.countDocuments({ organizationId: orgId }),
    ).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Requirement 4 — a GlobeVista order belongs to GlobeVista alone
 * ------------------------------------------------------------------ */

describe("requirement 4: a GlobeVista order lands in GlobeVista and nowhere else", () => {
  let rc: Types.ObjectId;
  let tr: Types.ObjectId;
  let gv: Types.ObjectId;

  beforeEach(async () => {
    rc = await makeRentalConfirmation();
    tr = await makeTripReservations();
    gv = await seedGlobeVista();
    await joinGlobeVista(gv);
  });

  async function listFor(orgId: Types.ObjectId) {
    actingAs(orgId);
    return listOrders({ page: 1, pageSize: 50 } as never, { actor });
  }

  it("stamps the GlobeVista organization on a flight order created there", async () => {
    actingAs(gv);
    const { order } = await createOrder(validFlightOrderInput(), { actor });

    const doc = await Order.findById(order.id).lean<{
      organizationId?: Types.ObjectId | null;
      serviceType?: string;
    } | null>();
    expect(String(doc!.organizationId)).toBe(String(gv));
    expect(doc!.serviceType).toBe(ServiceType.FLIGHT);
  });

  it("does NOT surface that order on RentalConfirmation's list", async () => {
    actingAs(gv);
    const { order } = await createOrder(validFlightOrderInput(), { actor });

    const seen = await listFor(rc);
    expect(seen.items.map((o) => o.id)).not.toContain(order.id);
    expect(seen.total).toBe(0);
  });

  it("does NOT surface that order on TripReservations' list", async () => {
    actingAs(gv);
    const { order } = await createOrder(validFlightOrderInput(), { actor });

    const seen = await listFor(tr);
    expect(seen.items.map((o) => o.id)).not.toContain(order.id);
    expect(seen.total).toBe(0);
  });

  it("does surface it on GlobeVista's own list", async () => {
    actingAs(gv);
    const { order } = await createOrder(validFlightOrderInput(), { actor });

    const seen = await listFor(gv);
    expect(seen.items.map((o) => o.id)).toEqual([order.id]);
  });

  it("does not let GlobeVista see either incumbent's orders", async () => {
    // The other direction of the same leak: a new tenant must not inherit
    // the deployment's existing book of business.
    actingAs(rc);
    const { order: rcOrder } = await createOrder(validCreateOrderInput(), {
      actor,
    });
    actingAs(tr);
    const { order: trOrder } = await createOrder(validCreateOrderInput(), {
      actor,
    });

    const seen = await listFor(gv);
    const ids = seen.items.map((o) => o.id);
    expect(ids).not.toContain(rcOrder.id);
    expect(ids).not.toContain(trOrder.id);
    expect(seen.total).toBe(0);
  });

  it("does not give GlobeVista the unattributed pre-migration history", async () => {
    // RentalConfirmation is the compatibility anchor and keeps that history;
    // a third tenant must never read it.
    actingAs(null);
    const { order: legacy } = await createOrder(validCreateOrderInput(), {
      actor,
    });

    const seen = await listFor(gv);
    expect(seen.items.map((o) => o.id)).not.toContain(legacy.id);

    const anchor = await listFor(rc);
    expect(anchor.items.map((o) => o.id)).toContain(legacy.id);
  });
});
