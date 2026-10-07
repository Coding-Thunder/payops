import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Types } from "mongoose";
import type { ReactElement } from "react";

import {
  AuditAction,
  PaymentGatewayKey,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { ValidationError } from "@/lib/errors";
import AdminSettingsPage from "@/app/app/admin/settings/page";
import { SettingsForm } from "@/components/features/settings/settings-form";
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
  DEFAULT_HOTEL_CANCELLATION_POLICY,
  DEFAULT_HOTEL_LEGAL_VERSION,
  DEFAULT_HOTEL_TERMS_AND_CONDITIONS,
} from "@/server/db/models/setting.model";
import { orgCookieName } from "@/server/auth/org-cookie";
import { createOrder } from "@/server/services/order.service";
import { createSettings } from "@/tests/factories/settings.factory";
import {
  validCreateOrderInput,
  validFlightOrderInput,
  validHotelOrderInput,
} from "@/tests/fixtures/order-input.fixture";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";

/**
 * Terms & Conditions follow the services an organization SELLS — its
 * `serviceTypes`, the same list that decides which order forms it gets.
 *
 *   - Admin → Settings offers car rental terms (the deployment-wide text),
 *     flight terms and hotel terms only for a service the selected
 *     organization sells.
 *   - The API enforces exactly the same rule, whatever the page shows: a
 *     direct or manipulated request for a service the organization does not
 *     sell is refused and writes nothing.
 *   - Each service's text is its own: editing one never changes another,
 *     and never another organization's.
 *   - An order freezes its OWN organization's text for its OWN service:
 *     flight and hotel fall back only to their built-in defaults — never to
 *     car terms, never to another brand.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: () => {},
    push: () => {},
    replace: () => {},
    back: () => {},
    prefetch: () => {},
  }),
  usePathname: () => "/app/admin/settings",
  useSearchParams: () => new URLSearchParams(),
}));

const admin = actorFor(UserRole.ADMIN, { name: "Admin User" });

const ORG_CAR_TERMS = "CARFLIGHT CAR TERMS: the main driver must be 25 or older.";
const ORG_CAR_POLICY = "CARFLIGHT CAR POLICY: free cancellation up to two days ahead.";
const A_FLIGHT_TERMS = "ALPHA-ONLY FLIGHT TERMS: tickets follow the operating airline's fare rules.";
const A_FLIGHT_POLICY = "ALPHA-ONLY FLIGHT POLICY: refunds follow the airline's release of the fare.";
const HOTEL_TERMS = "TRIO HOTEL TERMS: the lead guest checks in with photo ID.";
const HOTEL_POLICY = "TRIO HOTEL POLICY: free cancellation until 48 hours before arrival.";

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
/** Car rental only. */
let carOnly: Types.ObjectId;
/** Flights only. */
let flightOnly: Types.ObjectId;
/** Car rental + flights, with organization-wide (car) text of its own. */
let carFlight: Types.ObjectId;
/** Car rental + flights + hotels. */
let trio: Types.ObjectId;

async function makeOrg(opts: {
  slug: string;
  brandName: string;
  serviceTypes: ServiceType[];
  legal?: Record<string, unknown>;
}): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: opts.slug,
    name: opts.slug,
    brandName: opts.brandName,
    isDefault: false,
    payments: { provider: PaymentGatewayKey.STRIPE },
    serviceTypes: opts.serviceTypes,
    ...(opts.legal ? { legal: opts.legal } : {}),
  });
  const id = doc._id as Types.ObjectId;
  await OrganizationMember.create({
    organizationId: id,
    userId: new Types.ObjectId(admin.id),
    role: admin.role,
    status: RecordState.ACTIVE,
  });
  return id;
}

function actingAs(orgId: Types.ObjectId | null) {
  setNextHeaders(orgId ? { cookies: { [orgCookieName()]: String(orgId) } } : {});
}

/** The settings page exactly as an admin of the selected organization gets it. */
async function renderSettings(): Promise<string> {
  return renderToStaticMarkup(await AdminSettingsPage());
}

/** Which sections the page rendered: each service's per-brand form, and
 *  the deployment DEFAULT car text editor — found by its field labels, which
 *  predate this change, so the same check catches the old page offering it
 *  inside a brand. */
function sectionsShown(html: string) {
  return {
    car: html.includes("Car rental terms &amp; cancellation policy"),
    flight: html.includes("Flight terms &amp; cancellation policy"),
    hotel: html.includes("Hotel terms &amp; cancellation policy"),
    deploymentDefault:
      html.includes(">Terms text</label>") || html.includes(">Policy text</label>"),
  };
}

function findElement(node: unknown, type: unknown): ReactElement | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === type) return node as ReactElement;
  return findElement(el.props?.children, type);
}

/** What the page hands the settings form — i.e. what reaches the browser
 *  and what a save posts back. */
async function settingsFormProps() {
  const form = findElement(await AdminSettingsPage(), SettingsForm);
  expect(form).not.toBeNull();
  return form!.props as {
    initial: Record<string, unknown>;
    showCarRentalLegal?: boolean;
  };
}

function getLegal(serviceType?: string) {
  return getLegalRoute(
    buildRequest("/api/admin/settings/legal", {
      ...(serviceType ? { searchParams: { serviceType } } : {}),
    }),
  );
}

function patchLegal(body: unknown) {
  return patchLegalRoute(
    buildRequest("/api/admin/settings/legal", { method: "PATCH", body }),
  );
}

function patchSettings(body: unknown) {
  return patchSettingsRoute(
    buildRequest("/api/admin/settings", { method: "PATCH", body }),
  );
}

function legalBody(
  serviceType: string,
  termsAndConditions: string,
  cancellationPolicy: string,
  extra: Record<string, unknown> = {},
) {
  return { serviceType, termsAndConditions, cancellationPolicy, ...extra };
}

/** The whole settings form, as the page posts it, from what is stored. */
async function settingsForm(over: Record<string, unknown> = {}) {
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

/** The stored settings, minus `updatedAt`: every PATCH first runs the
 *  pre-existing `ensureSettingsDocument` upsert, which touches it even when
 *  the request is then refused. */
async function storedSettings() {
  const s = await Setting.findOne({ key: SETTINGS_KEY }).lean<Record<string, unknown> | null>();
  if (!s) return s;
  delete s.updatedAt;
  return s;
}

async function rawLegal(orgId: Types.ObjectId) {
  const org = await Organization.findById(orgId).lean<{
    legal?: Record<string, unknown> & {
      services?: Record<string, Record<string, string> | null> | null;
    };
  } | null>();
  return org!.legal;
}

async function legalAudits() {
  return AuditLog.find({ action: AuditAction.ORGANIZATION_LEGAL_UPDATED }).lean<
    { organizationId: Types.ObjectId | null; metadata: { serviceType: string } }[]
  >();
}

async function frozen(orderId: string) {
  return Order.findById(orderId).lean<{
    terms: { text: string; version: string };
    policy: { text: string; version: string };
  } | null>();
}

async function errorMessage(res: Response) {
  const { body } = await jsonBody<{ ok: false; error: { message: string } }>(res);
  return body.error.message;
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sessionMock = await mockSession(admin);
  carOnly = await makeOrg({
    slug: "carsonly",
    brandName: "Cars Only",
    serviceTypes: [ServiceType.CAR_RENTAL],
  });
  flightOnly = await makeOrg({
    slug: "flightsonly",
    brandName: "Flights Only",
    serviceTypes: [ServiceType.FLIGHT],
  });
  carFlight = await makeOrg({
    slug: "carflight",
    brandName: "Car And Flight",
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT],
    legal: {
      termsAndConditions: ORG_CAR_TERMS,
      termsVersion: "v3",
      cancellationPolicy: ORG_CAR_POLICY,
      cancellationPolicyVersion: "v3",
    },
  });
  trio = await makeOrg({
    slug: "trio",
    brandName: "Trio Travel",
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT, ServiceType.HOTEL],
  });
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  setNextHeaders({});
});

/* ------------------------------------------------------------------ *
 * Admin UI
 * ------------------------------------------------------------------ */

describe("Admin → Settings offers terms only for the services the selected organization sells", () => {
  it.each([
    {
      who: "Car only",
      org: () => carOnly,
      expected: { car: true, flight: false, hotel: false, deploymentDefault: false },
    },
    {
      who: "Flight only",
      org: () => flightOnly,
      expected: { car: false, flight: true, hotel: false, deploymentDefault: false },
    },
    {
      who: "Car + Flight",
      org: () => carFlight,
      expected: { car: true, flight: true, hotel: false, deploymentDefault: false },
    },
    {
      who: "Car + Flight + Hotel",
      org: () => trio,
      expected: { car: true, flight: true, hotel: true, deploymentDefault: false },
    },
  ])("$who", async ({ org, expected }) => {
    actingAs(org());
    expect(sectionsShown(await renderSettings())).toEqual(expected);
  });

  it("names the selected brand on each per-organization section", async () => {
    actingAs(trio);
    const html = await renderSettings();
    expect(html).toContain("Car rental terms &amp; cancellation policy — Trio Travel");
    expect(html).toContain("Flight terms &amp; cancellation policy — Trio Travel");
    expect(html).toContain("Hotel terms &amp; cancellation policy — Trio Travel");
  });

  it("inside a brand, never offers the deployment default editor; each car form shows what THAT brand's car orders freeze", async () => {
    const settings = await storedSettings();
    const carLine = String(settings!.termsAndConditions).split("\n")[0]!.slice(0, 40);

    for (const org of [carOnly, flightOnly, carFlight, trio]) {
      actingAs(org);
      const form = await settingsFormProps();
      expect(form.showCarRentalLegal).toBe(false);
      expect(form.initial).not.toHaveProperty("termsAndConditions");
      expect(form.initial).not.toHaveProperty("cancellationPolicy");
    }

    // A brand with no car text of its own: its form shows the inherited
    // deployment default, flagged as such.
    actingAs(carOnly);
    const inherited = await renderSettings();
    expect(inherited).toContain(carLine);
    expect(inherited).toContain("Deployment default in use");

    // A brand with its own: only its own.
    actingAs(carFlight);
    const own = await renderSettings();
    expect(own).toContain(ORG_CAR_TERMS);
    expect(own).not.toContain(carLine);

    // A brand that does not sell car rental: no car text at all.
    actingAs(flightOnly);
    expect(await renderSettings()).not.toContain(carLine);
  });

  it("offers only the deployment default car text with no organization selected, as before", async () => {
    actingAs(null);
    expect(sectionsShown(await renderSettings())).toEqual({
      car: false,
      flight: false,
      hotel: false,
      deploymentDefault: true,
    });
  });
});

/* ------------------------------------------------------------------ *
 * The same rule through the API — direct and manipulated requests
 * ------------------------------------------------------------------ */

describe("the API enforces the same service rule as the page", () => {
  it("Car only: every flight or hotel read and write is refused, and nothing is written", async () => {
    actingAs(carOnly);
    const before = await rawLegal(carOnly);

    const reads = [await getLegal(), await getLegal("FLIGHT"), await getLegal("HOTEL")];
    expect(reads.map((r) => r.status)).toEqual([422, 422, 422]);
    expect(await errorMessage(await getLegal("FLIGHT"))).toBe(
      "Cars Only does not sell flights, so it has no flight terms to set.",
    );
    expect(await errorMessage(await getLegal("HOTEL"))).toBe(
      "Cars Only does not sell hotel stays, so it has no hotel terms to set.",
    );

    const flightSave = await patchLegal(legalBody("FLIGHT", A_FLIGHT_TERMS, A_FLIGHT_POLICY));
    expect(flightSave.status).toBe(422);
    const hotelSave = await patchLegal(legalBody("HOTEL", HOTEL_TERMS, HOTEL_POLICY));
    expect(hotelSave.status).toBe(422);

    expect(await rawLegal(carOnly)).toEqual(before);
    expect(await legalAudits()).toHaveLength(0);
  });

  it("Car only: its OWN car rental terms are edited — never the deployment default, never another brand's", async () => {
    actingAs(carOnly);
    const settingsBefore = await storedSettings();
    const trioBefore = await rawLegal(trio);
    const carFlightBefore = await rawLegal(carFlight);

    const res = await patchLegal(
      legalBody("CAR_RENTAL", "CARS ONLY — its own car rental terms.", String(settingsBefore!.cancellationPolicy)),
    );
    expect(res.status).toBe(200);
    expect(await rawLegal(carOnly)).toMatchObject({
      termsAndConditions: "CARS ONLY — its own car rental terms.",
      termsVersion: "v2",
    });
    // The policy was saved untouched, so it stays on the inherited default.
    expect((await rawLegal(carOnly))!.cancellationPolicy ?? "").toBe("");
    expect(await storedSettings()).toEqual(settingsBefore);
    expect(await rawLegal(trio)).toEqual(trioBefore);
    expect(await rawLegal(carFlight)).toEqual(carFlightBefore);

    // The deployment default cannot be changed from inside a brand.
    const viaSettings = await patchSettings(
      await settingsForm({ termsAndConditions: "CARS ONLY trying to change every brand's car terms." }),
    );
    expect(viaSettings.status).toBe(422);
    expect(await storedSettings()).toEqual(settingsBefore);
  });

  it("Flight only: car rental terms cannot be changed, but the rest of the form still saves", async () => {
    actingAs(flightOnly);
    const before = await storedSettings();

    const carEdit = await patchSettings(
      await settingsForm({ termsAndConditions: "SNEAKED-IN car rental terms from a flight brand." }),
    );
    expect(carEdit.status).toBe(422);
    expect(await errorMessage(carEdit)).toBe(
      "Car rental terms are set per brand. Edit Flights Only's own under its Car rental terms in Admin → Settings.",
    );
    const carSlot = await patchLegal(legalBody("CAR_RENTAL", "SNEAKED-IN car terms for a flight brand.", A_FLIGHT_POLICY));
    expect(carSlot.status).toBe(422);
    expect(await errorMessage(carSlot)).toBe(
      "Flights Only does not sell car rental, so it has no car rental terms to set.",
    );
    expect((await getLegal("CAR_RENTAL")).status).toBe(422);
    const policyEdit = await patchSettings(
      await settingsForm({ cancellationPolicy: "SNEAKED-IN car rental policy from a flight brand." }),
    );
    expect(policyEdit.status).toBe(422);
    expect(await storedSettings()).toEqual(before);

    // What the page posts for this brand: the car fields back unchanged.
    const ok = await patchSettings(await settingsForm({ paymentExpiryHours: 36 }));
    expect(ok.status).toBe(200);
    const after = await storedSettings();
    expect(after!.paymentExpiryHours).toBe(36);
    expect(after!.termsAndConditions).toBe(before!.termsAndConditions);
    expect(after!.termsVersion).toBe(before!.termsVersion);
  });

  it("Flight only: the page's own save works even on a settings row stored before the car text existed", async () => {
    // An older deployment's row: no car text stored at all, so the page
    // would show — and once posted back — the built-in car defaults.
    await Setting.collection.updateOne(
      { key: SETTINGS_KEY },
      {
        $unset: {
          termsAndConditions: "",
          termsVersion: "",
          cancellationPolicy: "",
          cancellationPolicyVersion: "",
        },
      },
    );
    actingAs(flightOnly);
    const { initial } = await settingsFormProps();
    const res = await patchSettings({ ...initial, paymentExpiryHours: 30 });
    expect(res.status).toBe(200);
    const after = await Setting.findOne({ key: SETTINGS_KEY }).lean<Record<string, unknown> | null>();
    expect(after!.paymentExpiryHours).toBe(30);
    expect(after).not.toHaveProperty("termsAndConditions");
    expect(after).not.toHaveProperty("cancellationPolicy");
  });

  it("Flight only: flight terms save; hotel terms are refused", async () => {
    actingAs(flightOnly);
    const saved = await patchLegal(legalBody("FLIGHT", A_FLIGHT_TERMS, A_FLIGHT_POLICY));
    expect(saved.status).toBe(200);
    expect((await rawLegal(flightOnly))!.services!.FLIGHT).toMatchObject({
      termsAndConditions: A_FLIGHT_TERMS,
      termsVersion: "v2",
    });
    const hotel = await patchLegal(legalBody("HOTEL", HOTEL_TERMS, HOTEL_POLICY));
    expect(hotel.status).toBe(422);
    expect((await rawLegal(flightOnly))!.services!.HOTEL ?? null).toBeNull();
  });

  it("Car + Flight + Hotel: hotel terms read and save like flight terms", async () => {
    actingAs(trio);
    const view = await jsonBody<{ ok: true; data: Record<string, unknown> }>(await getLegal("HOTEL"));
    expect(view.status).toBe(200);
    expect(view.body.data).toEqual({
      organizationId: String(trio),
      brandName: "Trio Travel",
      sellsHotel: true,
      termsAndConditions: DEFAULT_HOTEL_TERMS_AND_CONDITIONS,
      termsVersion: DEFAULT_HOTEL_LEGAL_VERSION,
      cancellationPolicy: DEFAULT_HOTEL_CANCELLATION_POLICY,
      cancellationPolicyVersion: DEFAULT_HOTEL_LEGAL_VERSION,
      termsIsDefault: true,
      policyIsDefault: true,
      hasOrganizationWideText: false,
    });

    const saved = await patchLegal(legalBody("HOTEL", HOTEL_TERMS, HOTEL_POLICY));
    expect(saved.status).toBe(200);
    const audits = await legalAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata.serviceType).toBe(ServiceType.HOTEL);
    expect(String(audits[0]!.organizationId)).toBe(String(trio));
  });

  it("refuses an unknown service, by query or by body", async () => {
    actingAs(trio);
    expect((await getLegal("TRAIN")).status).toBe(422);
    expect((await patchLegal(legalBody("TRAIN", A_FLIGHT_TERMS, A_FLIGHT_POLICY))).status).toBe(422);
  });

  it("writes only the selected organization, whatever organization a manipulated body names", async () => {
    actingAs(trio);
    const res = await patchLegal(
      legalBody("HOTEL", HOTEL_TERMS, HOTEL_POLICY, { organizationId: String(carFlight) }),
    );
    expect(res.status).toBe(200);
    expect((await rawLegal(trio))!.services!.HOTEL).toMatchObject({ termsAndConditions: HOTEL_TERMS });
    expect((await rawLegal(carFlight))!.services ?? null).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Each service's text is its own
 * ------------------------------------------------------------------ */

describe("each supported service is configured independently", () => {
  it("Car + Flight: changing the flight terms changes no car terms, and the reverse", async () => {
    actingAs(carFlight);
    const settingsBefore = await storedSettings();

    expect((await patchLegal(legalBody("FLIGHT", A_FLIGHT_TERMS, A_FLIGHT_POLICY))).status).toBe(200);
    expect(await storedSettings()).toEqual(settingsBefore);
    const afterFlight = await rawLegal(carFlight);
    expect(afterFlight).toMatchObject({
      termsAndConditions: ORG_CAR_TERMS,
      termsVersion: "v3",
      cancellationPolicy: ORG_CAR_POLICY,
      cancellationPolicyVersion: "v3",
    });

    const carEdit = await patchLegal(
      legalBody("CAR_RENTAL", "CAR AND FLIGHT — revised car rental terms.", ORG_CAR_POLICY),
    );
    expect(carEdit.status).toBe(200);
    expect((await rawLegal(carFlight))!.services!.FLIGHT).toEqual(afterFlight!.services!.FLIGHT);
    expect(await storedSettings()).toEqual(settingsBefore);

    const { order: car } = await createOrder(validCreateOrderInput(), { actor: admin });
    expect((await frozen(car.id))!.terms).toEqual({
      text: "CAR AND FLIGHT — revised car rental terms.",
      version: "v4",
    });
    const { order: flight } = await createOrder(validFlightOrderInput(), { actor: admin });
    expect((await frozen(flight.id))!.terms).toEqual({ text: A_FLIGHT_TERMS, version: "v2" });
  });

  it.each([
    ["flight first, then hotel", ["FLIGHT", "HOTEL"]],
    ["hotel first, then flight", ["HOTEL", "FLIGHT"]],
  ])("Car + Flight + Hotel: saving %s keeps both", async (_label, order) => {
    actingAs(trio);
    const text = {
      FLIGHT: [A_FLIGHT_TERMS, A_FLIGHT_POLICY],
      HOTEL: [HOTEL_TERMS, HOTEL_POLICY],
    } as const;
    for (const service of order as ("FLIGHT" | "HOTEL")[]) {
      const [terms, policy] = text[service];
      expect((await patchLegal(legalBody(service, terms, policy))).status).toBe(200);
    }
    const services = (await rawLegal(trio))!.services!;
    expect(services.FLIGHT).toMatchObject({ termsAndConditions: A_FLIGHT_TERMS, termsVersion: "v2" });
    expect(services.HOTEL).toMatchObject({ termsAndConditions: HOTEL_TERMS, termsVersion: "v2" });
  });

  it("Car + Flight + Hotel: simultaneous first saves of flight and hotel terms keep both", async () => {
    actingAs(trio);
    const [flight, hotel] = await Promise.all([
      patchLegal(legalBody("FLIGHT", A_FLIGHT_TERMS, A_FLIGHT_POLICY)),
      patchLegal(legalBody("HOTEL", HOTEL_TERMS, HOTEL_POLICY)),
    ]);
    expect([flight.status, hotel.status]).toEqual([200, 200]);
    const services = (await rawLegal(trio))!.services!;
    expect(services.FLIGHT).toMatchObject({ termsAndConditions: A_FLIGHT_TERMS, termsVersion: "v2" });
    expect(services.HOTEL).toMatchObject({ termsAndConditions: HOTEL_TERMS, termsVersion: "v2" });
  });

  it("never erases flight terms stored before hotel terms existed", async () => {
    // A document written before the HOTEL slot: `legal.services` holds only
    // FLIGHT, with no HOTEL key at all.
    await Organization.collection.updateOne(
      { _id: trio },
      {
        $set: {
          "legal.services": {
            FLIGHT: {
              termsAndConditions: A_FLIGHT_TERMS,
              termsVersion: "v4",
              cancellationPolicy: A_FLIGHT_POLICY,
              cancellationPolicyVersion: "v4",
            },
          },
        },
      },
    );
    actingAs(trio);
    expect((await patchLegal(legalBody("HOTEL", HOTEL_TERMS, HOTEL_POLICY))).status).toBe(200);
    const services = (await rawLegal(trio))!.services!;
    expect(services.FLIGHT).toEqual({
      termsAndConditions: A_FLIGHT_TERMS,
      termsVersion: "v4",
      cancellationPolicy: A_FLIGHT_POLICY,
      cancellationPolicyVersion: "v4",
    });
    expect(services.HOTEL).toMatchObject({ termsAndConditions: HOTEL_TERMS, termsVersion: "v2" });
  });
});

/* ------------------------------------------------------------------ *
 * Organization isolation
 * ------------------------------------------------------------------ */

describe("one organization's terms never reach another", () => {
  beforeEach(async () => {
    actingAs(carFlight);
    expect((await patchLegal(legalBody("FLIGHT", A_FLIGHT_TERMS, A_FLIGHT_POLICY))).status).toBe(200);
  });

  it("Org A's flight terms cannot be read while working in Org B", async () => {
    actingAs(flightOnly);
    const { body } = await jsonBody<{ ok: true; data: { termsAndConditions: string; organizationId: string } }>(
      await getLegal("FLIGHT"),
    );
    expect(body.data.organizationId).toBe(String(flightOnly));
    expect(body.data.termsAndConditions).toBe(DEFAULT_FLIGHT_TERMS_AND_CONDITIONS);
    expect(await renderSettings()).not.toContain(A_FLIGHT_TERMS);
  });

  it("Org A's flight terms cannot be written while working in Org B", async () => {
    const aBefore = await rawLegal(carFlight);
    actingAs(flightOnly);
    // A tab still showing Org A is refused…
    const stale = await patchLegal(
      legalBody("FLIGHT", "OVERWRITE ATTEMPT on Org A's flight terms.", A_FLIGHT_POLICY, {
        expectedOrganizationId: String(carFlight),
      }),
    );
    expect(stale.status).toBe(409);
    // …and a plain save lands on Org B only.
    const b = await patchLegal(legalBody("FLIGHT", "FLIGHTS ONLY own flight terms, version two.", A_FLIGHT_POLICY));
    expect(b.status).toBe(200);
    expect(await rawLegal(carFlight)).toEqual(aBefore);
  });

  it("a flight order freezes its OWN organization's flight terms — never another's, never car terms", async () => {
    actingAs(carFlight);
    const { order: aFlight } = await createOrder(validFlightOrderInput(), { actor: admin });
    actingAs(flightOnly);
    const { order: bFlight } = await createOrder(validFlightOrderInput(), { actor: admin });

    expect((await frozen(aFlight.id))!.terms).toEqual({ text: A_FLIGHT_TERMS, version: "v2" });
    expect((await frozen(aFlight.id))!.policy).toMatchObject({ text: A_FLIGHT_POLICY, version: "v2" });
    expect((await frozen(bFlight.id))!.terms).toEqual({
      text: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });
  });

  it("a car order still freezes its organization's car terms, exactly as before", async () => {
    actingAs(carFlight);
    const { order: aCar } = await createOrder(validCreateOrderInput(), { actor: admin });
    expect((await frozen(aCar.id))!.terms).toEqual({ text: ORG_CAR_TERMS, version: "v3" });
    expect((await frozen(aCar.id))!.policy).toMatchObject({ text: ORG_CAR_POLICY, version: "v3" });

    const settings = await storedSettings();
    actingAs(carOnly);
    const { order: cCar } = await createOrder(validCreateOrderInput(), { actor: admin });
    expect((await frozen(cCar.id))!.terms).toEqual({
      text: settings!.termsAndConditions,
      version: settings!.termsVersion,
    });
  });
});

/* ------------------------------------------------------------------ *
 * Fallbacks
 * ------------------------------------------------------------------ */

describe("a supported service with no text of its own falls back to ITS built-in default only", () => {
  it("flight: the built-in flight default — never car terms", async () => {
    actingAs(carFlight);
    const { order } = await createOrder(validFlightOrderInput(), { actor: admin });
    const doc = await frozen(order.id);
    expect(doc!.terms).toEqual({
      text: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });
    expect(doc!.policy).toMatchObject({
      text: DEFAULT_FLIGHT_CANCELLATION_POLICY,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });
    expect(doc!.terms.text).not.toBe(ORG_CAR_TERMS);
  });

  it("hotel: the built-in hotel default — never the organization's car terms or the deployment's", async () => {
    await Organization.updateOne(
      { _id: trio },
      { $set: { "legal.termsAndConditions": ORG_CAR_TERMS, "legal.cancellationPolicy": ORG_CAR_POLICY } },
    );
    const settings = await storedSettings();
    actingAs(trio);
    const { order } = await createOrder(validHotelOrderInput(), { actor: admin });
    const doc = await frozen(order.id);
    expect(doc!.terms).toEqual({
      text: DEFAULT_HOTEL_TERMS_AND_CONDITIONS,
      version: DEFAULT_HOTEL_LEGAL_VERSION,
    });
    expect(doc!.policy).toMatchObject({
      text: DEFAULT_HOTEL_CANCELLATION_POLICY,
      version: DEFAULT_HOTEL_LEGAL_VERSION,
    });
    expect([ORG_CAR_TERMS, settings!.termsAndConditions]).not.toContain(doc!.terms.text);
    expect([ORG_CAR_POLICY, settings!.cancellationPolicy]).not.toContain(doc!.policy.text);
  });

  it("hotel: the organization's own hotel terms once it has them", async () => {
    actingAs(trio);
    expect((await patchLegal(legalBody("HOTEL", HOTEL_TERMS, HOTEL_POLICY))).status).toBe(200);
    const { order } = await createOrder(validHotelOrderInput(), { actor: admin });
    const doc = await frozen(order.id);
    expect(doc!.terms).toEqual({ text: HOTEL_TERMS, version: "v2" });
    expect(doc!.policy).toMatchObject({ text: HOTEL_POLICY, version: "v2" });
  });
});

/* ------------------------------------------------------------------ *
 * Runtime enforcement at order creation
 * ------------------------------------------------------------------ */

describe("an order for a flight or hotel the organization does not sell is refused", () => {
  it.each([
    { who: "Car only", org: () => carOnly, brand: "Cars Only", kind: "flight" as const },
    { who: "Car only", org: () => carOnly, brand: "Cars Only", kind: "hotel" as const },
    { who: "Flight only", org: () => flightOnly, brand: "Flights Only", kind: "hotel" as const },
    { who: "Car + Flight", org: () => carFlight, brand: "Car And Flight", kind: "hotel" as const },
  ])("$who — $kind", async ({ org, brand, kind }) => {
    actingAs(org());
    const input = kind === "flight" ? validFlightOrderInput() : validHotelOrderInput();
    const err = await createOrder(input, { actor: admin }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toBe(
      `${brand} does not sell ${kind === "flight" ? "flights" : "hotel stays"}, so this order cannot be created for it.`,
    );
    expect(await Order.countDocuments({})).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Turning a service off
 * ------------------------------------------------------------------ */

describe("a service taken off an organization keeps its stored text", () => {
  it("hides and refuses it, deletes nothing, and shows it again when the service returns", async () => {
    actingAs(trio);
    expect((await patchLegal(legalBody("FLIGHT", A_FLIGHT_TERMS, A_FLIGHT_POLICY))).status).toBe(200);
    expect((await patchLegal(legalBody("HOTEL", HOTEL_TERMS, HOTEL_POLICY))).status).toBe(200);
    const stored = (await rawLegal(trio))!.services;

    await Organization.updateOne({ _id: trio }, { $pull: { serviceTypes: ServiceType.FLIGHT } });
    expect(sectionsShown(await renderSettings())).toMatchObject({ flight: false, hotel: true });
    expect((await getLegal("FLIGHT")).status).toBe(422);
    expect((await patchLegal(legalBody("FLIGHT", "A NEWER flight text that must be refused.", A_FLIGHT_POLICY))).status).toBe(422);
    expect((await rawLegal(trio))!.services).toEqual(stored);

    await Organization.updateOne({ _id: trio }, { $addToSet: { serviceTypes: ServiceType.FLIGHT } });
    const { body } = await jsonBody<{ ok: true; data: { termsAndConditions: string } }>(await getLegal("FLIGHT"));
    expect(body.data.termsAndConditions).toBe(A_FLIGHT_TERMS);
  });
});
