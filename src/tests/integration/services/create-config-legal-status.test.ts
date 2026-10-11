import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Types } from "mongoose";

import CreateOrderPage from "@/app/app/orders/create/page";
import { GET as getCreateConfig } from "@/app/api/orders/create-config/route";
import { PATCH as patchLegalRoute } from "@/app/api/admin/settings/legal/route";
import { PageHeader } from "@/components/common/page-header";
import { CreateFlightOrderForm } from "@/components/features/orders/create-flight-order-form";
import { CreateHotelOrderForm } from "@/components/features/orders/create-hotel-order-form";
import { CreateOrderForm } from "@/components/features/orders/create-order-form";
import { ServiceTabs } from "@/components/features/orders/service-tabs";
import {
  CURRENCIES,
  PaymentGatewayKey,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { Organization, OrganizationMember } from "@/server/db/models";
import { orgCookieName } from "@/server/auth/org-cookie";
import { listActiveProviders } from "@/server/services/provider.service";
import { getSettings } from "@/server/services/settings.service";
import { createSettings } from "@/tests/factories/settings.factory";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";

/**
 * Terms need nothing from an admin, so nothing before an order is created
 * talks about them.
 *
 * Every order freezes its own service's pre-written terms and cancellation
 * policy (`resolveServiceTerms`): the brand's own text where it chose to
 * customise it, else the deployment's car text for car rental and the
 * built-in flight / hotel text. Nothing is ever missing, so there is nothing
 * to warn about:
 *
 *   - the create page is exactly its header and its form(s) — for every
 *     service, whether or not the brand ever saved terms, for an admin and
 *     for staff alike — with no "Built-in … terms in use" notice, no
 *     "of its own yet", no "Admin → Settings" errand;
 *   - `GET /api/orders/create-config` returns only what the form binds
 *     against — no `legalStatus`.
 *
 * (This file once pinned that notice and the additive `legalStatus` field;
 * both were removed, and it now pins their absence. A car-only
 * organization's page is pinned, as before, as exactly the header and the
 * car form.)
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: () => {},
    push: () => {},
    replace: () => {},
    back: () => {},
    prefetch: () => {},
  }),
  usePathname: () => "/app/orders/create",
  useSearchParams: () => new URLSearchParams(),
}));

const admin = actorFor(UserRole.ADMIN, { name: "Admin User" });
const staff = actorFor(UserRole.STAFF, { name: "Staff User" });

const FLIGHT_TERMS = "SKYLINE FLIGHT TERMS: tickets follow the operating airline's fare rules.";
const FLIGHT_POLICY = "SKYLINE FLIGHT POLICY: refunds follow the airline's release of the fare.";
const HOTEL_TERMS = "SKYLINE HOTEL TERMS: the lead guest checks in with photo ID.";
const HOTEL_POLICY = "SKYLINE HOTEL POLICY: free cancellation until 48 hours before arrival.";

/** Everything the removed notice said, in any of its variants. */
const REMOVED_NOTICE_WORDING = [
  /of its own yet/i,
  /built-in/i,
  /terms in use/i,
  /cancellation policy in use/i,
  /will freeze/i,
  /Admin → Settings/,
  /ask an admin/i,
];

/** Exactly what create-config returned before `legalStatus` was added —
 *  and returns again. */
const CREATE_CONFIG_KEYS = [
  "allowedBookingTypes",
  "allowedCurrencies",
  "defaultCurrency",
  "providers",
  "serviceTypes",
];

const SINGLE_SERVICE_DESCRIPTION =
  "Capture booking details. The payment link is generated when you send the request email.";
const MULTI_SERVICE_DESCRIPTION =
  "Pick a service, then capture the booking details. The payment link is generated when you send the request email.";

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
let carOnly: Types.ObjectId;
let flightOnly: Types.ObjectId;
let hotelOnly: Types.ObjectId;
/** Sells all three, car first — the order its tabs follow. */
let allThree: Types.ObjectId;

async function makeOrg(slug: string, serviceTypes: ServiceType[]): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug,
    name: slug,
    brandName: slug,
    isDefault: false,
    payments: { provider: PaymentGatewayKey.PAYPAL },
    serviceTypes,
  });
  const id = doc._id as Types.ObjectId;
  for (const user of [admin, staff]) {
    await OrganizationMember.create({
      organizationId: id,
      userId: new Types.ObjectId(user.id),
      role: user.role,
      status: RecordState.ACTIVE,
    });
  }
  return id;
}

function actingAs(orgId: Types.ObjectId | null) {
  setNextHeaders(orgId ? { cookies: { [orgCookieName()]: String(orgId) } } : {});
}

async function signIn(user: typeof admin) {
  sessionMock?.restore();
  sessionMock = await mockSession(user);
}

/** The forms' catalog pickers read through React Query. */
function withQueryClient(ui: ReactElement): ReactElement {
  return createElement(QueryClientProvider, { client: new QueryClient() }, ui);
}

async function renderCreatePage(): Promise<string> {
  return renderToStaticMarkup(withQueryClient(await CreateOrderPage()));
}

/**
 * The page's whole tree built by hand from the same parts — the header and
 * the given form(s) in the page's <div>, with the props the page passes —
 * and nothing else. A page that rendered anything more (a notice, an
 * alert, a link) would not be byte-identical to it.
 */
async function headerAndForms(
  orgId: Types.ObjectId,
  serviceTypes: ServiceType[],
): Promise<string> {
  const settings = await getSettings();
  const single = serviceTypes.length === 1 ? serviceTypes[0]! : null;
  const providers = await listActiveProviders({
    organizationId: String(orgId),
    serviceType: single ?? undefined,
  });
  const shared = {
    allowedBookingTypes: settings.allowedBookingTypes,
    defaultCurrency: settings.defaultCurrency,
    allowedCurrencies: CURRENCIES,
  };
  const form =
    single === ServiceType.FLIGHT
      ? createElement(CreateFlightOrderForm, { ...shared, providers })
      : single === ServiceType.HOTEL
        ? createElement(CreateHotelOrderForm, { ...shared, providers })
        : single === ServiceType.CAR_RENTAL
          ? createElement(CreateOrderForm, { ...shared, providers })
          : createElement(ServiceTabs, { ...shared, serviceTypes, providers });
  return renderToStaticMarkup(
    withQueryClient(
      createElement(
        "div",
        { className: "space-y-6" },
        createElement(PageHeader, {
          title: "Create order",
          description: single ? SINGLE_SERVICE_DESCRIPTION : MULTI_SERVICE_DESCRIPTION,
        }),
        form,
      ),
    ),
  );
}

/** The page's visible text, for "is this sentence on the page" checks:
 *  tags dropped (an inline link without a gap), entities decoded,
 *  whitespace collapsed. */
function text(html: string): string {
  return html
    .replace(/<\/?a\b[^>]*>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/** No trace of the removed notice: its words, its settings link, its alert. */
function expectNoTermsNotice(html: string, where: string) {
  const visible = text(html);
  for (const wording of REMOVED_NOTICE_WORDING) {
    expect(visible, `${where}: ${wording}`).not.toMatch(wording);
  }
  expect(html, `${where}: settings link`).not.toContain('href="/app/admin/settings"');
  expect(html, `${where}: alert`).not.toContain('role="alert"');
}

async function createConfig(): Promise<Record<string, unknown> & { serviceTypes: ServiceType[] }> {
  const res = await getCreateConfig();
  const { status, body } = await jsonBody<{
    ok: true;
    data: Record<string, unknown> & { serviceTypes: ServiceType[] };
  }>(res);
  expect(status).toBe(200);
  return body.data;
}

async function saveLegal(serviceType: ServiceType, terms: string, policy: string) {
  const res = await patchLegalRoute(
    buildRequest("/api/admin/settings/legal", {
      method: "PATCH",
      body: { serviceType, termsAndConditions: terms, cancellationPolicy: policy },
    }),
  );
  expect(res.status).toBe(200);
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await signIn(admin);
  carOnly = await makeOrg("carsonly", [ServiceType.CAR_RENTAL]);
  flightOnly = await makeOrg("flightsonly", [ServiceType.FLIGHT]);
  hotelOnly = await makeOrg("hotelsonly", [ServiceType.HOTEL]);
  allThree = await makeOrg("allthree", [
    ServiceType.CAR_RENTAL,
    ServiceType.FLIGHT,
    ServiceType.HOTEL,
  ]);
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  setNextHeaders({});
});

/* ------------------------------------------------------------------ *
 * Car rental — unchanged
 * ------------------------------------------------------------------ */

describe("a car-only organization's create page is exactly what it always was", () => {
  it("renders the header and the car form — no tabs, no notice, nothing else", async () => {
    actingAs(carOnly);
    const settings = await getSettings();
    const providers = await listActiveProviders({
      organizationId: String(carOnly),
      serviceType: ServiceType.CAR_RENTAL,
    });
    // The page's whole tree, built by hand from the same parts: same
    // header copy, the car form with the same props, in the same <div>.
    const expected = renderToStaticMarkup(
      withQueryClient(
        createElement(
          "div",
          { className: "space-y-6" },
          createElement(PageHeader, {
            title: "Create order",
            description:
              "Capture booking details. The payment link is generated when you send the request email.",
          }),
          createElement(CreateOrderForm, {
            allowedBookingTypes: settings.allowedBookingTypes,
            defaultCurrency: settings.defaultCurrency,
            allowedCurrencies: CURRENCIES,
            providers,
          }),
        ),
      ),
    );
    const html = await renderCreatePage();
    expect(html).toBe(expected);
    expect(html).not.toContain('role="tablist"');
    expect(text(html)).not.toContain("built-in");
  });

  it("is the same with no organization selected — and create-config carries no legal status", async () => {
    actingAs(null);
    const html = await renderCreatePage();
    expect(html).not.toContain('role="tablist"');
    expect(text(html)).not.toContain("built-in");
    expectNoTermsNotice(html, "no organization");
    const config = await createConfig();
    expect(config.serviceTypes).toEqual([ServiceType.CAR_RENTAL]);
    expect(config).not.toHaveProperty("legalStatus");
  });

  it("create-config reports no legal status for car rental", async () => {
    actingAs(carOnly);
    const config = await createConfig();
    expect(config.serviceTypes).toEqual([ServiceType.CAR_RENTAL]);
    expect(config).not.toHaveProperty("legalStatus");
  });
});

/* ------------------------------------------------------------------ *
 * create-config — no legal status, for anyone
 * ------------------------------------------------------------------ */

describe("GET /api/orders/create-config returns only what the form binds against — no legalStatus", () => {
  it("for every organization, whatever it sells, and with none selected", async () => {
    const cases: Array<[string, Types.ObjectId | null, ServiceType[]]> = [
      ["no organization", null, [ServiceType.CAR_RENTAL]],
      ["car only", carOnly, [ServiceType.CAR_RENTAL]],
      ["flight only", flightOnly, [ServiceType.FLIGHT]],
      ["hotel only", hotelOnly, [ServiceType.HOTEL]],
      ["all three", allThree, [ServiceType.CAR_RENTAL, ServiceType.FLIGHT, ServiceType.HOTEL]],
    ];
    for (const [who, orgId, serviceTypes] of cases) {
      actingAs(orgId);
      const config = await createConfig();
      expect(config.serviceTypes, who).toEqual(serviceTypes);
      expect(config, who).not.toHaveProperty("legalStatus");
      expect(Object.keys(config).sort(), who).toEqual(CREATE_CONFIG_KEYS);
    }
  });

  it("is identical before and after the brand saves its own flight and hotel terms — terms are not an input", async () => {
    actingAs(allThree);
    const before = await createConfig();
    await saveLegal(ServiceType.FLIGHT, FLIGHT_TERMS, FLIGHT_POLICY);
    expect(await createConfig()).toEqual(before);
    await saveLegal(ServiceType.HOTEL, HOTEL_TERMS, HOTEL_POLICY);
    const after = await createConfig();
    expect(after).toEqual(before);
    expect(after).not.toHaveProperty("legalStatus");
  });

  it("is unchanged by another organization's saved terms", async () => {
    actingAs(allThree);
    const before = await createConfig();
    actingAs(flightOnly);
    await saveLegal(ServiceType.FLIGHT, FLIGHT_TERMS, FLIGHT_POLICY);
    actingAs(allThree);
    expect(await createConfig()).toEqual(before);
  });
});

/* ------------------------------------------------------------------ *
 * Flight and hotel — no notice, exactly the header and the form(s)
 * ------------------------------------------------------------------ */

describe("the create page shows no terms notice — flight and hotel included", () => {
  it("flight only: exactly the header and the flight form, ready to submit — byte-identical before and after the brand saves its own flight terms", async () => {
    actingAs(flightOnly);
    const before = await renderCreatePage();
    expect(before).toBe(await headerAndForms(flightOnly, [ServiceType.FLIGHT]));
    expectNoTermsNotice(before, "flight only, built-in terms");
    // Nothing to set up first: the flight form and its submit are there.
    expect(text(before)).toContain("Create order & generate link");
    expect(before).not.toContain('role="tablist"');

    await saveLegal(ServiceType.FLIGHT, FLIGHT_TERMS, FLIGHT_POLICY);
    const after = await renderCreatePage();
    expect(after).toBe(before);
    expect(text(after)).toContain("Create order & generate link");
  });

  it("a brand with its own flight terms but no policy of its own: still no notice, still exactly the header and the form", async () => {
    await Organization.collection.updateOne(
      { _id: flightOnly },
      {
        $set: {
          "legal.services": {
            FLIGHT: { termsAndConditions: FLIGHT_TERMS, termsVersion: "v2" },
          },
        },
      },
    );
    actingAs(flightOnly);
    expect(await createConfig()).not.toHaveProperty("legalStatus");
    const html = await renderCreatePage();
    expectNoTermsNotice(html, "flight terms only");
    expect(html).toBe(await headerAndForms(flightOnly, [ServiceType.FLIGHT]));
  });

  it("hotel only: exactly the header and the hotel form — no notice", async () => {
    actingAs(hotelOnly);
    const html = await renderCreatePage();
    expect(html).toBe(await headerAndForms(hotelOnly, [ServiceType.HOTEL]));
    expectNoTermsNotice(html, "hotel only");
    expect(text(html)).not.toContain("flight terms");
    expect(html).not.toContain('role="tablist"');
  });

  it("several services: exactly the header and the tabs — no tab carries a notice, before or after one service's terms are saved", async () => {
    actingAs(allThree);
    const html = await renderCreatePage();
    expect(html).toBe(
      await headerAndForms(allThree, [ServiceType.CAR_RENTAL, ServiceType.FLIGHT, ServiceType.HOTEL]),
    );
    expect(html).toContain('role="tablist"');
    // Every panel is force-mounted, so the hidden ones are checked too.
    expect(html.match(/role="tabpanel"/g)).toHaveLength(3);
    expectNoTermsNotice(html, "all three");
    expect(text(html)).not.toMatch(/car rental terms|rental terms/i);

    await saveLegal(ServiceType.HOTEL, HOTEL_TERMS, HOTEL_POLICY);
    expect(await renderCreatePage()).toBe(html);
  });

  it("staff get the same page as an admin — no 'ask an admin', no dead link", async () => {
    actingAs(flightOnly);
    const asAdmin = await renderCreatePage();
    await signIn(staff);
    actingAs(flightOnly);
    const asStaff = await renderCreatePage();
    expectNoTermsNotice(asStaff, "staff");
    expect(text(asStaff)).not.toContain("Ask an admin to add the brand's own in Admin → Settings.");
    expect(asStaff).not.toContain('href="/app/admin/settings"');
    expect(asStaff).toBe(asAdmin);
  });
});
