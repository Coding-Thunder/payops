import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Types } from "mongoose";

import CreateOrderPage from "@/app/app/orders/create/page";
import { GET as getCreateConfig } from "@/app/api/orders/create-config/route";
import { PATCH as patchLegalRoute } from "@/app/api/admin/settings/legal/route";
import { PageHeader } from "@/components/common/page-header";
import { CreateOrderForm } from "@/components/features/orders/create-order-form";
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
 * Before an order is created, the create page says when it would freeze
 * BUILT-IN terms.
 *
 * Every order freezes its organization's terms and cancellation policy for
 * its service (`resolveServiceTerms`). A brand that sells flights or hotel
 * stays but has not written its own text for that service gets the
 * built-in, brand-neutral text — frozen onto every order created until it
 * does. So the create page, and `GET /api/orders/create-config`, carry each
 * sold flight / hotel service's `{ termsIsDefault, policyIsDefault }`, and
 * the form warns (without blocking) while either is the default.
 *
 * Car rental is excluded: inheriting the deployment's car text is the
 * established design, and a car-only organization's create page is pinned
 * here as exactly the header and the car form — nothing added.
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

const FLIGHT_NOTICE =
  "This brand has no flight terms or cancellation policy of its own yet. New flight orders will freeze the built-in flight terms and cancellation policy.";
const HOTEL_NOTICE =
  "This brand has no hotel terms or cancellation policy of its own yet. New hotel orders will freeze the built-in hotel terms and cancellation policy.";

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

interface CreateConfig {
  serviceTypes: ServiceType[];
  legalStatus: Record<string, { termsIsDefault: boolean; policyIsDefault: boolean }>;
}

async function createConfig(): Promise<CreateConfig> {
  const res = await getCreateConfig();
  const { status, body } = await jsonBody<{ ok: true; data: CreateConfig }>(res);
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

  it("is the same with no organization selected", async () => {
    actingAs(null);
    const html = await renderCreatePage();
    expect(html).not.toContain('role="tablist"');
    expect(text(html)).not.toContain("built-in");
    expect((await createConfig()).legalStatus).toEqual({});
  });

  it("create-config reports no legal status for car rental", async () => {
    actingAs(carOnly);
    const config = await createConfig();
    expect(config.serviceTypes).toEqual([ServiceType.CAR_RENTAL]);
    expect(config.legalStatus).toEqual({});
  });
});

/* ------------------------------------------------------------------ *
 * Flight and hotel — the warning
 * ------------------------------------------------------------------ */

describe("create-config reports, per sold flight / hotel service, whether built-in text would be frozen", () => {
  it("flags both while the brand has written none, and never car rental", async () => {
    actingAs(allThree);
    const config = await createConfig();
    expect(config.serviceTypes).toEqual([
      ServiceType.CAR_RENTAL,
      ServiceType.FLIGHT,
      ServiceType.HOTEL,
    ]);
    expect(config.legalStatus).toEqual({
      FLIGHT: { termsIsDefault: true, policyIsDefault: true },
      HOTEL: { termsIsDefault: true, policyIsDefault: true },
    });
  });

  it("clears a service's flags once its own text is saved — and only that service's", async () => {
    actingAs(allThree);
    await saveLegal(ServiceType.FLIGHT, FLIGHT_TERMS, FLIGHT_POLICY);
    expect((await createConfig()).legalStatus).toEqual({
      FLIGHT: { termsIsDefault: false, policyIsDefault: false },
      HOTEL: { termsIsDefault: true, policyIsDefault: true },
    });
    await saveLegal(ServiceType.HOTEL, HOTEL_TERMS, HOTEL_POLICY);
    expect((await createConfig()).legalStatus).toEqual({
      FLIGHT: { termsIsDefault: false, policyIsDefault: false },
      HOTEL: { termsIsDefault: false, policyIsDefault: false },
    });
  });

  it("reports only the services the organization sells", async () => {
    actingAs(flightOnly);
    expect((await createConfig()).legalStatus).toEqual({
      FLIGHT: { termsIsDefault: true, policyIsDefault: true },
    });
    actingAs(hotelOnly);
    expect((await createConfig()).legalStatus).toEqual({
      HOTEL: { termsIsDefault: true, policyIsDefault: true },
    });
  });

  it("never reads another organization's text", async () => {
    actingAs(flightOnly);
    await saveLegal(ServiceType.FLIGHT, FLIGHT_TERMS, FLIGHT_POLICY);
    actingAs(allThree);
    expect((await createConfig()).legalStatus.FLIGHT).toEqual({
      termsIsDefault: true,
      policyIsDefault: true,
    });
  });
});

describe("the create page warns before freezing built-in flight or hotel terms", () => {
  it("flight only: the notice is shown while the FLIGHT slot is empty, and gone once saved", async () => {
    actingAs(flightOnly);
    const before = await renderCreatePage();
    expect(text(before)).toContain(FLIGHT_NOTICE);
    expect(text(before)).toContain("Add the brand's own in Admin → Settings.");
    expect(before).toContain('href="/app/admin/settings"');
    // Non-blocking: the flight form and its submit are still there.
    expect(text(before)).toContain("Create order & generate link");
    expect(before).not.toContain('role="tablist"');

    await saveLegal(ServiceType.FLIGHT, FLIGHT_TERMS, FLIGHT_POLICY);
    const after = await renderCreatePage();
    expect(text(after)).not.toContain("built-in");
    expect(after).not.toContain('href="/app/admin/settings"');
    expect(text(after)).toContain("Create order & generate link");
  });

  it("names only what is missing", async () => {
    // The brand wrote its flight terms but not its cancellation policy.
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
    expect((await createConfig()).legalStatus).toEqual({
      FLIGHT: { termsIsDefault: false, policyIsDefault: true },
    });
    expect(text(await renderCreatePage())).toContain(
      "This brand has no flight cancellation policy of its own yet. New flight orders will freeze the built-in flight cancellation policy.",
    );
  });

  it("hotel only: the hotel form carries the hotel notice", async () => {
    actingAs(hotelOnly);
    const html = await renderCreatePage();
    expect(text(html)).toContain(HOTEL_NOTICE);
    expect(text(html)).not.toContain("flight terms");
    expect(html).not.toContain('role="tablist"');
  });

  it("several services: each tab carries its own notice, the car tab none", async () => {
    actingAs(allThree);
    const html = await renderCreatePage();
    expect(html).toContain('role="tablist"');
    expect(text(html)).toContain(FLIGHT_NOTICE);
    expect(text(html)).toContain(HOTEL_NOTICE);
    expect(text(html)).not.toMatch(/car rental terms|rental terms/i);

    await saveLegal(ServiceType.HOTEL, HOTEL_TERMS, HOTEL_POLICY);
    const after = text(await renderCreatePage());
    expect(after).toContain(FLIGHT_NOTICE);
    expect(after).not.toContain(HOTEL_NOTICE);
  });

  it("an agent who cannot edit settings is told to ask an admin — no dead link", async () => {
    await signIn(staff);
    actingAs(flightOnly);
    const html = await renderCreatePage();
    expect(text(html)).toContain(FLIGHT_NOTICE);
    expect(text(html)).toContain("Ask an admin to add the brand's own in Admin → Settings.");
    expect(html).not.toContain('href="/app/admin/settings"');
  });
});
