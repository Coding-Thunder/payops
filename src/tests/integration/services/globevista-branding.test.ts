import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import {
  CaptureMode,
  PaymentGatewayKey,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import {
  Branding,
  Organization,
  OrganizationMember,
} from "@/server/db/models";
import { orgCookieName } from "@/server/auth/org-cookie";
import { resolvePublicBrand, resolvePublicBrandForOrder } from "@/server/email/identity";
import { createOrder } from "@/server/services/order.service";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { setNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo } from "@/tests/utils/db";
import { validFlightOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * GlobeVista is the OPERATIONS name. FlightBizz is the only name a customer
 * is ever allowed to read.
 *
 * Two organizations already exist with the internal name and the customer
 * brand set to the same string, so nothing before this tenant could tell the
 * two apart — the distinction is untested by construction. Here it is load
 * bearing: the organization document carries `name: "GlobeVista"` and
 * `brandName: "FlightBizz"`, and every customer-facing surface resolves the
 * brand, never the name.
 *
 * The second half re-pins the incumbents' branding through the same
 * function. `brand-leak.test.ts` already asserts these; repeating them in
 * the tenant-onboarding file is deliberate, because the plausible way to
 * break them is a change made while adding a third tenant.
 */

const actor = actorFor(UserRole.ADMIN);

/** The deployment Branding singleton — RentalConfirmation's, in production. */
const DEPLOYMENT = {
  brandName: "Rental Confirmation",
  supportEmail: "support@rentalconfirmation.com",
  supportPhone: "+15513071441",
};

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

async function seedBranding() {
  await Branding.findOneAndUpdate(
    { key: "default" },
    { $set: { key: "default", ...DEPLOYMENT, primaryColor: "#0B1220" } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
}

async function withMembership(id: Types.ObjectId) {
  await OrganizationMember.create({
    organizationId: id,
    userId: new Types.ObjectId(actor.id),
    role: UserRole.ADMIN,
    status: RecordState.ACTIVE,
  });
  return id;
}

/** GlobeVista, exactly as `scripts/seed-globevista.ts` writes it. */
async function makeGlobeVista(): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: "globevista",
    // INTERNAL name.
    name: "GlobeVista",
    // The ONLY name a customer sees.
    brandName: "FlightBizz",
    isDefault: false,
    branding: {
      logo: "",
      primaryColor: "#0E7490",
      onPrimaryColor: "#FFFFFF",
      footerTagline: "",
    },
    support: { email: "", phone: "" },
    email: {
      fromName: "FlightBizz",
      fromEmail: "",
      replyTo: "",
      transport: { host: "", port: 587, secure: false, user: "" },
    },
    payments: {
      provider: PaymentGatewayKey.STRIPE,
      enabledProviders: [PaymentGatewayKey.STRIPE],
      captureMode: CaptureMode.MANUAL,
    },
    serviceTypes: [ServiceType.FLIGHT, ServiceType.HOTEL, ServiceType.CAR_RENTAL],
  });
  return withMembership(doc._id as Types.ObjectId);
}

/** RentalConfirmation: the default organization / compatibility anchor. */
async function makeRentalConfirmation(): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: "rentalconfirmation",
    name: "Rental Confirmation",
    brandName: "Rental Confirmation",
    isDefault: true,
    payments: { provider: PaymentGatewayKey.STRIPE },
  });
  return withMembership(doc._id as Types.ObjectId);
}

/** TripReservations, as configured in production: own support address, NO
 *  phone number, PayPal. */
async function makeTripReservations(): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: "tripreservations",
    name: "Trip Reservations",
    brandName: "Trip Reservations",
    isDefault: false,
    payments: { provider: PaymentGatewayKey.PAYPAL },
    email: {
      fromName: "Trip Reservations",
      fromEmail: "contact@tripreservations.test",
      replyTo: "",
      transport: {
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        user: "contact@tripreservations.test",
      },
    },
    support: { email: "contact@tripreservations.test", phone: "" },
  });
  return withMembership(doc._id as Types.ObjectId);
}

function actingAs(orgId: Types.ObjectId) {
  setNextHeaders({ cookies: { [orgCookieName()]: String(orgId) } });
}

/**
 * Everything in the resolved brand that a customer could ever READ.
 *
 * `slug` is excluded on purpose and is the one field that is not customer
 * copy: it is the lowercase lookup key `resolvePublicBrand` hands back so
 * callers can find this organization's `ORG_<SLUG>_*` overrides. It is never
 * rendered. The literal internal name "GlobeVista" is separately asserted to
 * be absent from the WHOLE object, slug included.
 */
function customerVisibleStrings(brand: Record<string, unknown>): string[] {
  return [
    "brandName",
    "supportEmail",
    "supportPhone",
    "logo",
    "footerTagline",
  ].map((k) => String(brand[k] ?? ""));
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await seedBranding();
  sessionMock = await mockSession(actor);
  // Deterministic: the resolver consults these before the document.
  delete process.env.ORG_GLOBEVISTA_EMAIL_FROM;
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  delete process.env.ORG_GLOBEVISTA_EMAIL_FROM;
});

/* ------------------------------------------------------------------ *
 * Requirement 11 — the customer sees FlightBizz, never GlobeVista
 * ------------------------------------------------------------------ */

describe("requirement 11: GlobeVista's customer-facing brand is FlightBizz", () => {
  it("resolvePublicBrand returns brandName FlightBizz for the GlobeVista organization", async () => {
    const gv = await makeGlobeVista();
    const brand = await resolvePublicBrand(String(gv), DEPLOYMENT);

    expect(brand.brandName).toBe("FlightBizz");
    expect(brand.isDefault).toBe(false);
  });

  it("does NOT put the internal name GlobeVista anywhere in the customer-facing output", async () => {
    const gv = await makeGlobeVista();
    const brand = await resolvePublicBrand(String(gv), DEPLOYMENT);

    for (const value of customerVisibleStrings(
      brand as unknown as Record<string, unknown>,
    )) {
      expect(value).not.toMatch(/globevista/i);
    }
    // And the internal name as spelled, across the entire resolved object.
    expect(JSON.stringify(brand)).not.toContain("GlobeVista");
  });

  it("does not leak the internal name even when the org's own name is read back", async () => {
    // The document deliberately carries BOTH: `name` for operations,
    // `brandName` for customers. If they were ever collapsed into one field,
    // this is the assertion that notices.
    const gv = await makeGlobeVista();
    const doc = await Organization.findById(gv).lean<{
      name: string;
      brandName: string;
    } | null>();

    expect(doc!.name).toBe("GlobeVista");
    expect(doc!.brandName).toBe("FlightBizz");

    const brand = await resolvePublicBrand(String(gv), DEPLOYMENT);
    expect(brand.brandName).toBe(doc!.brandName);
    expect(brand.brandName).not.toBe(doc!.name);
  });

  it("never falls back to the incumbent's brand or support contacts", async () => {
    // A non-default organization must not inherit the deployment singleton.
    // Printing RentalConfirmation's US support number on a FlightBizz
    // booking is the exact leak this resolver exists to close.
    const gv = await makeGlobeVista();
    const brand = await resolvePublicBrand(String(gv), DEPLOYMENT);

    expect(brand.brandName).not.toBe(DEPLOYMENT.brandName);
    expect(brand.supportEmail).not.toBe(DEPLOYMENT.supportEmail);
    expect(brand.supportPhone).not.toBe(DEPLOYMENT.supportPhone);
    // Unset means "this brand publishes no support contact" — callers render
    // the block conditionally rather than substituting the incumbent's.
    expect(brand.supportEmail).toBe("");
    expect(brand.supportPhone).toBe("");
    expect(JSON.stringify(brand)).not.toContain("rentalconfirmation");
  });

  it("uses GlobeVista's own primary colour, not the deployment's", async () => {
    const gv = await makeGlobeVista();
    const brand = await resolvePublicBrand(String(gv), DEPLOYMENT);
    expect(brand.primaryColor).toBe("#0E7490");
    expect(brand.primaryColor).not.toBe("#0B1220");
  });

  it("still says FlightBizz when the sender address comes from the environment", async () => {
    // `ORG_<SLUG>_EMAIL_FROM` is the support-email fallback. The env key is
    // spelled with the internal slug; the value the customer reads must not
    // be.
    process.env.ORG_GLOBEVISTA_EMAIL_FROM = "bookings@flightbizz.test";
    const gv = await makeGlobeVista();
    const brand = await resolvePublicBrand(String(gv), DEPLOYMENT);

    expect(brand.brandName).toBe("FlightBizz");
    expect(brand.supportEmail).toBe("bookings@flightbizz.test");
    expect(JSON.stringify(brand)).not.toContain("GlobeVista");
  });

  it("resolves the same brand from an actual GlobeVista ORDER", async () => {
    // The real call path: almost every customer surface holds an order id,
    // not an organization id, and resolves the brand from the order's own
    // organization rather than ambient request context.
    const gv = await makeGlobeVista();
    actingAs(gv);
    const { order } = await createOrder(validFlightOrderInput(), { actor });

    const brand = await resolvePublicBrandForOrder(order.id, DEPLOYMENT);
    expect(brand.brandName).toBe("FlightBizz");
    expect(brand.isDefault).toBe(false);
    expect(JSON.stringify(brand)).not.toContain("GlobeVista");
  });
});

/* ------------------------------------------------------------------ *
 * Requirement 12 — the incumbents keep their branding
 * ------------------------------------------------------------------ */

describe("requirement 12: the existing organizations retain their branding", () => {
  it("gives the DEFAULT organization the deployment singleton verbatim", async () => {
    const rc = await makeRentalConfirmation();
    const brand = await resolvePublicBrand(String(rc), DEPLOYMENT);

    expect(brand.brandName).toBe(DEPLOYMENT.brandName);
    expect(brand.supportEmail).toBe(DEPLOYMENT.supportEmail);
    expect(brand.supportPhone).toBe(DEPLOYMENT.supportPhone);
    expect(brand.isDefault).toBe(true);
  });

  it("keeps giving it the singleton once GlobeVista exists alongside it", async () => {
    const rc = await makeRentalConfirmation();
    await makeTripReservations();
    await makeGlobeVista();

    const brand = await resolvePublicBrand(String(rc), DEPLOYMENT);
    expect(brand.brandName).toBe(DEPLOYMENT.brandName);
    expect(brand.supportEmail).toBe(DEPLOYMENT.supportEmail);
    expect(brand.supportPhone).toBe(DEPLOYMENT.supportPhone);
    expect(brand.isDefault).toBe(true);
    expect(JSON.stringify(brand)).not.toContain("FlightBizz");
  });

  it("still gives an UNATTRIBUTED order the deployment singleton", async () => {
    await makeGlobeVista();
    const brand = await resolvePublicBrand(null, DEPLOYMENT);
    expect(brand.brandName).toBe(DEPLOYMENT.brandName);
    expect(brand.isDefault).toBe(true);
  });

  it("keeps TripReservations' own brand, support address and EMPTY phone", async () => {
    const tr = await makeTripReservations();
    await makeGlobeVista();

    const brand = await resolvePublicBrand(String(tr), DEPLOYMENT);
    expect(brand.brandName).toBe("Trip Reservations");
    expect(brand.supportEmail).toBe("contact@tripreservations.test");
    // The pinned leak: an unset phone must NOT inherit the incumbent's US
    // number and get printed as a "Call us" link in a UK brand's email.
    expect(brand.supportPhone).toBe("");
    expect(brand.supportPhone).not.toBe(DEPLOYMENT.supportPhone);
    expect(brand.isDefault).toBe(false);
  });

  it("keeps the three brands mutually non-overlapping", async () => {
    const rc = await makeRentalConfirmation();
    const tr = await makeTripReservations();
    const gv = await makeGlobeVista();

    const [rcBrand, trBrand, gvBrand] = await Promise.all([
      resolvePublicBrand(String(rc), DEPLOYMENT),
      resolvePublicBrand(String(tr), DEPLOYMENT),
      resolvePublicBrand(String(gv), DEPLOYMENT),
    ]);

    expect([
      rcBrand.brandName,
      trBrand.brandName,
      gvBrand.brandName,
    ]).toEqual(["Rental Confirmation", "Trip Reservations", "FlightBizz"]);

    // Exactly one of them is the compatibility anchor.
    expect(
      [rcBrand, trBrand, gvBrand].filter((b) => b.isDefault),
    ).toHaveLength(1);

    // No brand's string appears in another brand's output.
    expect(JSON.stringify(rcBrand)).not.toContain("FlightBizz");
    expect(JSON.stringify(rcBrand)).not.toContain("Trip Reservations");
    expect(JSON.stringify(trBrand)).not.toContain("FlightBizz");
    expect(JSON.stringify(trBrand)).not.toContain("Rental Confirmation");
    expect(JSON.stringify(gvBrand)).not.toContain("Trip Reservations");
    expect(JSON.stringify(gvBrand)).not.toContain("Rental Confirmation");
  });
});
