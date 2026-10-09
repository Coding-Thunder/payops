import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Types } from "mongoose";

import {
  EmailKind,
  OrderEvidenceEventType,
  OrderStatus,
  PaymentGatewayKey,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { ValidationError } from "@/lib/errors";
import {
  EmailTemplate,
  Order,
  Organization,
  OrganizationMember,
} from "@/server/db/models";
import {
  DEFAULT_CONSENT_MESSAGE,
  DEFAULT_FLIGHT_CANCELLATION_POLICY,
  DEFAULT_FLIGHT_LEGAL_VERSION,
  DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
  DEFAULT_HOTEL_CANCELLATION_POLICY,
  DEFAULT_HOTEL_LEGAL_VERSION,
  DEFAULT_HOTEL_TERMS_AND_CONDITIONS,
} from "@/server/db/models/setting.model";
import { orgCookieName } from "@/server/auth/org-cookie";
import { createOrder, initiatePayment } from "@/server/services/order.service";
import { createProvider } from "@/server/services/provider.service";
import { getEvidenceChain } from "@/server/services/evidence.service";
import { getPublicAcknowledgementView } from "@/server/services/acknowledgement.service";
import { generateAckToken } from "@/server/services/ack-token";
import { getPublicConsentView } from "@/server/services/consent.service";
import {
  resolveServiceTerms,
  updateOrganizationServiceLegal,
} from "@/server/services/organization-legal.service";
import {
  getActiveTemplateContent,
  listTemplateVersions,
} from "@/server/services/email-template.service";
import { getSettings } from "@/server/services/settings.service";
import { Setting, SETTINGS_KEY } from "@/server/db/models";
import { GET as getOrderRoute } from "@/app/api/orders/[id]/route";
import { POST as previewRoute } from "@/app/api/orders/[id]/payment-request-preview/route";
import { POST as templatePreviewRoute } from "@/app/api/admin/email-templates/[key]/preview/route";
import { POST as createTemplateRoute } from "@/app/api/admin/email-templates/[key]/route";
import { POST as activateTemplateRoute } from "@/app/api/admin/email-templates/[key]/[versionId]/activate/route";
import { PATCH as patchSettingsRoute } from "@/app/api/admin/settings/route";
import AdminEmailsPage from "@/app/app/admin/emails/page";
import AdminTemplateEditorPage from "@/app/app/admin/email-templates/[key]/page";
import PaymentSuccessPage from "@/app/pay/success/page";
import { createSettings } from "@/tests/factories/settings.factory";
import {
  roundTripFlightInput,
  validCreateOrderInput,
  validHotelOrderInput,
} from "@/tests/fixtures/order-input.fixture";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";
import type { OrderDTO } from "@/types";

/**
 * THE ORDER'S SERVICE TYPE AND THE ORDER'S ORGANIZATION DECIDE ITS T&C.
 *
 *   car rental order → that organization's CAR RENTAL terms
 *   flight order     → that organization's FLIGHT terms
 *   hotel order      → that organization's HOTEL terms
 *
 * Same organization, different service, different terms — and never another
 * organization's. Checked where the T&C text is actually shown: the order
 * API behind the operator's order page, the composer preview, the payment
 * request / confirmation / authorized emails (HTML and plain text), the
 * acknowledge page and the evidence chain (the evidence PDF's only input).
 * The consent page and the payment-success page show no T&C text at all;
 * they are checked to carry none of another service's or brand's either.
 * Every email preview — Admin → Email previews, the template editor and its
 * live-preview API — is checked per service and per brand, at the rendered
 * HTML: a preview names its service explicitly and goes through the same
 * resolver (`resolveServiceTerms`) that freezes a real order's terms.
 *
 * Every organization's terms here are set through the real per-brand
 * editors (`updateOrganizationServiceLegal`), as an admin working in that
 * brand would set them.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: () => {},
    push: () => {},
    replace: () => {},
    back: () => {},
    prefetch: () => {},
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));

const { sentMail } = vi.hoisted(() => ({
  sentMail: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/server/email/smtp", () => ({
  getMailer: () => ({
    sendMail: async (m: Record<string, unknown>) => {
      sentMail.push({ ...m });
      return { messageId: "<deployment>", response: "250 OK" };
    },
  }),
  getMailerFor: () => ({
    sendMail: async (m: Record<string, unknown>) => {
      sentMail.push({ ...m });
      return { messageId: "<organization>", response: "250 OK" };
    },
  }),
  verifyMailer: async () => {},
  _resetOrgMailersForTests: () => {},
}));

const {
  sendPaymentAuthorizedEmail,
  sendPaymentConfirmationEmail,
  sendPaymentRequestEmail,
} = await import("@/server/services/email.service");

const admin = actorFor(UserRole.ADMIN, { name: "Ops Admin" });

// The mandatory markers (no apostrophes, so they survive HTML escaping).
// No marker is a prefix or a substring of another.
const CAR_TERMS = "CAR TERMS TEST";
const CAR_POLICY = "CAR POLICY TEST";
const FLIGHT_TERMS = "FLIGHT TERMS TEST";
const FLIGHT_POLICY = "FLIGHT POLICY TEST";
const HOTEL_TERMS = "HOTEL TERMS TEST";
const HOTEL_POLICY = "HOTEL POLICY TEST";

/** Apostrophe-free lines that appear only in each default text. */
const DEFAULT_MARKERS = {
  /** The deployment Settings car text — what a brand without its own inherits. */
  car: {
    terms: ["The prepaid amount is charged today to secure your reservation."],
    policy: ["Cancellations made more than 24 hours before pick-up are eligible for a full refund."],
  },
  /** The built-in, brand-neutral flight text. */
  flight: {
    terms: ["The service charge shown is the only amount collected through this payment."],
    policy: [
      "Changes and cancellations to airline tickets are governed by the fare rules of the ticket issued.",
    ],
  },
  /** The built-in, brand-neutral hotel text. */
  hotel: {
    terms: ["Changes to the dates, rooms or guests may change the price and are subject to availability."],
    policy: [
      "Where a refund is due, it is made to your original payment method and is limited to the amount you paid online.",
    ],
  },
};

interface Markers {
  terms: string[];
  policy: string[];
}

const both = (m: Markers) => [...m.terms, ...m.policy];

/** One brand's own text for one service, as the brand's editor saved it. */
function brandMarkers(org: "A" | "B", service: "CAR" | "FLIGHT" | "HOTEL"): Markers {
  return { terms: [`ORG ${org} ${service} TERMS`], policy: [`ORG ${org} ${service} POLICY`] };
}

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
const ENV: Record<string, string> = {};

async function makeOrg(slug: string, serviceTypes: ServiceType[]): Promise<Types.ObjectId> {
  ENV[`ORG_${slug.toUpperCase()}_STRIPE_SECRET_KEY`] = `sk_test_${slug}_only`;
  ENV[`ORG_${slug.toUpperCase()}_STRIPE_WEBHOOK_SECRET`] = `whsec_${slug}_only`;
  Object.assign(process.env, ENV);
  const doc = await Organization.create({
    slug,
    name: slug,
    brandName: `${slug} brand`,
    isDefault: false,
    payments: { provider: PaymentGatewayKey.STRIPE },
    serviceTypes,
    email: {
      fromName: `${slug} brand`,
      fromEmail: `no-reply@${slug}.test`,
      replyTo: `help@${slug}.test`,
    },
    support: { email: `support@${slug}.test`, phone: "+442079460000" },
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

/** Set one brand's own terms for one service, through the per-brand editor,
 *  exactly as an admin working in that brand would. */
async function setTerms(
  orgId: Types.ObjectId,
  serviceType: ServiceType,
  termsAndConditions: string,
  cancellationPolicy: string,
) {
  actingAs(orgId);
  await updateOrganizationServiceLegal(
    {
      serviceType: serviceType as never,
      // The editor's minimum is 20 characters; the marker leads the text.
      termsAndConditions: `${termsAndConditions} — clause one.`,
      cancellationPolicy: `${cancellationPolicy} — rule one.`,
    },
    { actorId: admin.id, actorName: admin.name, actorRole: admin.role },
  );
}

async function setBrandTerms(orgId: Types.ObjectId, serviceType: ServiceType, m: Markers) {
  await setTerms(orgId, serviceType, m.terms[0]!, m.policy[0]!);
}

function lastSent(kind: EmailKind) {
  const msg = [...sentMail]
    .reverse()
    .find((m) => (m.headers as Record<string, string>)["X-Entity-Kind"] === kind);
  expect(msg, `no ${kind} email was sent`).toBeTruthy();
  return { html: String(msg!.html), text: String(msg!.text), subject: String(msg!.subject) };
}

async function orderApi(orderId: string): Promise<OrderDTO> {
  return (
    await jsonBody<{ ok: true; data: OrderDTO }>(
      await getOrderRoute(buildRequest(`/api/orders/${orderId}`), {
        params: Promise.resolve({ id: orderId }),
      }),
    )
  ).body.data;
}

type Kind = "car" | "flight" | "hotel";

const SERVICE_OF: Record<Kind, ServiceType> = {
  car: ServiceType.CAR_RENTAL,
  flight: ServiceType.FLIGHT,
  hotel: ServiceType.HOTEL,
};

function orderInput(kind: Kind) {
  switch (kind) {
    case "car":
      return validCreateOrderInput();
    case "flight":
      return roundTripFlightInput({ provider: "AIRINDIA" });
    case "hotel":
      return validHotelOrderInput();
  }
}

/** Surfaces that show the T&C (terms) text only. */
const TERMS_SURFACES = new Set([
  "frozen order terms",
  "order API terms (operator order page)",
  "acknowledge page",
]);
/** Surfaces that show the cancellation policy only. */
const POLICY_SURFACES = new Set(["frozen order policy", "order API policy"]);
// Every other shown surface (composer preview, emails, evidence genesis)
// shows both.

interface Surfaces {
  shown: Record<string, string>;
  all: Record<string, string>;
}

/**
 * Create one order of `kind` in `orgId` and collect every surface that shows
 * (or could show) its T&C, as the customer and the operator see them.
 */
async function surfaces(orgId: Types.ObjectId, kind: Kind) {
  actingAs(orgId);
  const { order } = await createOrder(orderInput(kind), { actor: admin });
  const { order: linked } = await initiatePayment(order.id, { actor: admin });

  const detail = await orderApi(order.id);
  const composerPreview = (
    await jsonBody<{ ok: true; data: { html: string } }>(
      await previewRoute(
        buildRequest(`/api/orders/${order.id}/payment-request-preview`, {
          method: "POST",
          body: {},
        }),
        { params: Promise.resolve({ id: order.id }) },
      ),
    )
  ).body.data.html;

  sentMail.length = 0;
  const { consentToken } = await sendPaymentRequestEmail(linked, {}, { actor: admin });
  await sendPaymentConfirmationEmail(linked);
  await sendPaymentAuthorizedEmail(linked);
  const request = lastSent(EmailKind.PAYMENT_LINK);
  const confirmation = lastSent(EmailKind.PAYMENT_CONFIRMATION);
  const authorized = lastSent(EmailKind.PAYMENT_AUTHORIZED);

  const consent = await getPublicConsentView(consentToken!, { brandName: "Deployment" });
  const ack = await getPublicAcknowledgementView(generateAckToken(order.id));
  const chain = await getEvidenceChain(order.id, { actor: admin });
  const genesis = chain.events.find((e) => e.eventType === OrderEvidenceEventType.ORDER_CREATED)!;

  await Order.updateOne(
    { _id: order.id },
    {
      $set: {
        status: OrderStatus.PAID,
        "payment.status": OrderStatus.PAID,
        "payment.paidAt": new Date("2026-10-07T10:00:00.000Z"),
        "payment.amountReceived": linked.pricing.amount,
      },
    },
  );
  const payPage = renderToStaticMarkup(
    await PaymentSuccessPage({
      searchParams: Promise.resolve({
        order: linked.orderNumber,
        session_id: linked.payment.paymentSessionId!,
      }),
    }),
  );

  const shown: Record<string, string> = {
    "frozen order terms": order.terms.text,
    "frozen order policy": order.policy.text,
    "order API terms (operator order page)": detail.terms.text,
    "order API policy": detail.policy.text,
    "composer preview": composerPreview,
    "payment request email (html)": request.html,
    "payment request email (text)": request.text,
    "confirmation email (html)": confirmation.html,
    "confirmation email (text)": confirmation.text,
    "authorized email (html)": authorized.html,
    "authorized email (text)": authorized.text,
    "acknowledge page": ack.termsText,
    "evidence genesis (evidence PDF input)": JSON.stringify(genesis.payload),
  };
  const all: Record<string, string> = {
    ...shown,
    "consent page": JSON.stringify(consent),
    "evidence chain": JSON.stringify(chain),
    "payment-success page": payPage,
  };
  return { order, shown, all };
}

/**
 * Re-read an EXISTING order from the database and render every surface that
 * still shows its T&C. The customer emails go out while the admin is working
 * in `viewer` — which must make no difference.
 */
async function rerendered(
  orderId: string,
  orgId: Types.ObjectId,
  viewer: Types.ObjectId,
): Promise<Surfaces> {
  actingAs(orgId);
  const detail = await orderApi(orderId);
  const chain = await getEvidenceChain(orderId, { actor: admin });
  actingAs(viewer);
  sentMail.length = 0;
  await sendPaymentConfirmationEmail(detail);
  await sendPaymentAuthorizedEmail(detail);
  const confirmation = lastSent(EmailKind.PAYMENT_CONFIRMATION);
  const authorized = lastSent(EmailKind.PAYMENT_AUTHORIZED);
  const ack = await getPublicAcknowledgementView(generateAckToken(orderId));
  const shown: Record<string, string> = {
    "order API terms (operator order page)": detail.terms.text,
    "order API policy": detail.policy.text,
    "confirmation email (html)": confirmation.html,
    "confirmation email (text)": confirmation.text,
    "authorized email (html)": authorized.html,
    "authorized email (text)": authorized.text,
    "acknowledge page": ack.termsText,
  };
  return { shown, all: { ...shown, "evidence chain": JSON.stringify(chain) } };
}

/** Every surface shows exactly `show` where it shows T&C, and no surface
 *  carries any of `mustNotShow`. */
function expectOnly(s: Surfaces, show: Markers, mustNotShow: string[]) {
  for (const [name, body] of Object.entries(s.shown)) {
    const expected = TERMS_SURFACES.has(name)
      ? show.terms
      : POLICY_SURFACES.has(name)
        ? show.policy
        : both(show);
    for (const marker of expected) {
      expect(body, `${name} must show "${marker}"`).toContain(marker);
    }
  }
  for (const [name, body] of Object.entries(s.all)) {
    for (const marker of mustNotShow) {
      expect(body, `${name} must NOT show "${marker}"`).not.toContain(marker);
    }
  }
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sessionMock = await mockSession(admin);
  sentMail.length = 0;
  for (const k of Object.keys(ENV)) delete ENV[k];
  await createProvider(
    {
      key: "AIRINDIA",
      name: "Air India",
      logo: "/providers/air-india.png",
      primaryColor: "#C8102E",
      onPrimaryColor: "#FFFFFF",
      tagline: "",
      sortOrder: 0,
      serviceTypes: [ServiceType.FLIGHT],
    } as Parameters<typeof createProvider>[0],
    { actor: admin },
  );
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  for (const k of Object.keys(ENV)) delete process.env[k];
  setNextHeaders({});
});

const CAR_TEST: Markers = { terms: [CAR_TERMS], policy: [CAR_POLICY] };
const FLIGHT_TEST: Markers = { terms: [FLIGHT_TERMS], policy: [FLIGHT_POLICY] };
const HOTEL_TEST: Markers = { terms: [HOTEL_TERMS], policy: [HOTEL_POLICY] };
const SERVICE_TEST: Record<Kind, Markers> = {
  car: CAR_TEST,
  flight: FLIGHT_TEST,
  hotel: HOTEL_TEST,
};
const ALL_SERVICES = [ServiceType.CAR_RENTAL, ServiceType.FLIGHT, ServiceType.HOTEL];
const KINDS: Kind[] = ["car", "flight", "hotel"];
const everyDefault = () => KINDS.flatMap((k) => both(DEFAULT_MARKERS[k]));

/** One organization selling all three services, with all three texts set
 *  through the per-brand editors. */
async function orgWithAllThree(slug: string, texts: Record<Kind, Markers>) {
  const org = await makeOrg(slug, ALL_SERVICES);
  for (const kind of KINDS) await setBrandTerms(org, SERVICE_OF[kind], texts[kind]);
  return org;
}

describe("SAME organization: car → car T&C, flight → flight T&C, hotel → hotel T&C", () => {
  it("each order's every surface — including all three real customer emails — shows its own service's text and no other", async () => {
    const org = await orgWithAllThree("sameorg", SERVICE_TEST);

    // Back to back, in mixed order, in the same brand.
    const rendered: Array<[Kind, Awaited<ReturnType<typeof surfaces>>]> = [];
    for (const kind of ["car", "flight", "hotel", "car", "hotel", "flight"] as Kind[]) {
      rendered.push([kind, await surfaces(org, kind)]);
    }
    for (const [kind, s] of rendered) {
      expect(s.order.serviceType).toBe(SERVICE_OF[kind]);
      const others = KINDS.filter((k) => k !== kind).flatMap((k) => both(SERVICE_TEST[k]));
      expectOnly(s, SERVICE_TEST[kind], [...others, ...everyDefault()]);
    }
  });

  it("an order keeps the text it froze: later edits to any service, in this brand or another, and the admin's current brand change nothing", async () => {
    const org = await orgWithAllThree("frozen", SERVICE_TEST);
    const other = await makeOrg("elsewhere", ALL_SERVICES);
    const orders = {} as Record<Kind, string>;
    for (const kind of KINDS) orders[kind] = (await surfaces(org, kind)).order.id;

    // Afterwards: every text of this brand edited, the other brand given
    // texts of its own, and the admin left working in the other brand.
    const foreign: string[] = [];
    for (const kind of KINDS) {
      const svc = SERVICE_OF[kind];
      const upper = kind.toUpperCase();
      await setTerms(org, svc, `${upper} TERMS EDITED LATER`, `${upper} POLICY EDITED LATER`);
      await setTerms(other, svc, `OTHER BRAND ${upper} TERMS`, `OTHER BRAND ${upper} POLICY`);
      foreign.push(
        `${upper} TERMS EDITED LATER`,
        `${upper} POLICY EDITED LATER`,
        `OTHER BRAND ${upper} TERMS`,
        `OTHER BRAND ${upper} POLICY`,
      );
    }

    // Re-read from the database; emails sent while working in the other brand.
    for (const kind of KINDS) {
      const others = KINDS.filter((k) => k !== kind).flatMap((k) => both(SERVICE_TEST[k]));
      expectOnly(await rerendered(orders[kind], org, other), SERVICE_TEST[kind], [
        ...others,
        ...foreign,
      ]);
    }
  });
});

describe("DIFFERENT organizations: each order gets its OWN organization's text for its OWN service", () => {
  it("Org A car / flight / hotel and Org B car / flight / hotel — all six", async () => {
    const texts = {
      A: { car: brandMarkers("A", "CAR"), flight: brandMarkers("A", "FLIGHT"), hotel: brandMarkers("A", "HOTEL") },
      B: { car: brandMarkers("B", "CAR"), flight: brandMarkers("B", "FLIGHT"), hotel: brandMarkers("B", "HOTEL") },
    };
    const orgs = {
      A: await orgWithAllThree("orga", texts.A),
      B: await orgWithAllThree("orgb", texts.B),
    };
    const everyText = (["A", "B"] as const).flatMap((o) => KINDS.map((k) => texts[o][k]));
    const othersThan = (keep: Markers) => everyText.filter((m) => m !== keep).flatMap(both);

    // Interleaved across brands and services, as an operator switching
    // workspaces would.
    const plan: Array<["A" | "B", Kind]> = [
      ["A", "car"], ["B", "flight"], ["A", "hotel"], ["B", "car"], ["A", "flight"], ["B", "hotel"],
    ];
    for (const [o, kind] of plan) {
      const s = await surfaces(orgs[o], kind);
      expectOnly(s, texts[o][kind], othersThan(texts[o][kind]));
    }
  });
});

describe("a service with no text of its own falls back to ITS OWN default — never another service's", () => {
  it("flight with no flight terms: the brand-neutral flight default, never the brand's car or hotel terms", async () => {
    const org = await makeOrg("noflightterms", ALL_SERVICES);
    await setBrandTerms(org, ServiceType.CAR_RENTAL, CAR_TEST);
    await setBrandTerms(org, ServiceType.HOTEL, HOTEL_TEST);

    const flight = await surfaces(org, "flight");
    expect(flight.order.terms).toEqual({
      text: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });
    expect(flight.order.policy.text).toBe(DEFAULT_FLIGHT_CANCELLATION_POLICY);
    expectOnly(flight, DEFAULT_MARKERS.flight, [
      ...both(CAR_TEST),
      ...both(HOTEL_TEST),
      ...both(DEFAULT_MARKERS.car),
      ...both(DEFAULT_MARKERS.hotel),
    ]);
  });

  it("hotel with no hotel terms: the brand-neutral hotel default, never the brand's car or flight terms", async () => {
    const org = await makeOrg("nohotelterms", ALL_SERVICES);
    await setBrandTerms(org, ServiceType.CAR_RENTAL, CAR_TEST);
    await setBrandTerms(org, ServiceType.FLIGHT, FLIGHT_TEST);

    const hotel = await surfaces(org, "hotel");
    expect(hotel.order.terms).toEqual({
      text: DEFAULT_HOTEL_TERMS_AND_CONDITIONS,
      version: DEFAULT_HOTEL_LEGAL_VERSION,
    });
    expect(hotel.order.policy.text).toBe(DEFAULT_HOTEL_CANCELLATION_POLICY);
    expectOnly(hotel, DEFAULT_MARKERS.hotel, [
      ...both(CAR_TEST),
      ...both(FLIGHT_TEST),
      ...both(DEFAULT_MARKERS.car),
      ...both(DEFAULT_MARKERS.flight),
    ]);
  });

  it("car rental with no car terms of its own: exactly the existing behaviour — the deployment default", async () => {
    const org = await makeOrg("nocarterms", ALL_SERVICES);
    await setBrandTerms(org, ServiceType.FLIGHT, FLIGHT_TEST);
    await setBrandTerms(org, ServiceType.HOTEL, HOTEL_TEST);
    const settings = await getSettings();

    const car = await surfaces(org, "car");
    expect(car.order.terms).toEqual({
      text: settings.termsAndConditions,
      version: settings.termsVersion,
    });
    expect(car.order.policy.text).toBe(settings.cancellationPolicy);
    expectOnly(car, DEFAULT_MARKERS.car, [
      ...both(FLIGHT_TEST),
      ...both(HOTEL_TEST),
      ...both(DEFAULT_MARKERS.flight),
      ...both(DEFAULT_MARKERS.hotel),
    ]);
  });
});

describe("an order is only accepted for a service its organization sells", () => {
  it("a car rental order for a flight-only brand is refused, before anything is written", async () => {
    const org = await makeOrg("flightonly", [ServiceType.FLIGHT]);
    actingAs(org);
    const err = await createOrder(validCreateOrderInput(), { actor: admin }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toBe(
      "flightonly brand does not sell car rental, so this order cannot be created for it.",
    );
    expect(await Order.countDocuments({})).toBe(0);
  });
});

describe("resolveServiceTerms — THE resolver, given only an organization and a service", () => {
  it("returns each organization's own text for each service, else that service's own default", async () => {
    const a = await orgWithAllThree("resolvera", {
      car: brandMarkers("A", "CAR"),
      flight: brandMarkers("A", "FLIGHT"),
      hotel: brandMarkers("A", "HOTEL"),
    });
    const bare = await makeOrg("resolverbare", ALL_SERVICES);
    const settings = await getSettings();
    for (const kind of KINDS) {
      const svc = SERVICE_OF[kind];
      const own = await resolveServiceTerms({ organizationId: a, serviceType: svc });
      const upper = kind === "car" ? "CAR" : kind.toUpperCase();
      expect(own.termsAndConditions.startsWith(`ORG A ${upper} TERMS`)).toBe(true);
      expect(own.cancellationPolicy.startsWith(`ORG A ${upper} POLICY`)).toBe(true);
    }
    // No text of its own: each service's OWN default.
    expect(
      (await resolveServiceTerms({ organizationId: bare, serviceType: ServiceType.CAR_RENTAL }))
        .termsAndConditions,
    ).toBe(settings.termsAndConditions);
    expect(
      (await resolveServiceTerms({ organizationId: bare, serviceType: ServiceType.FLIGHT }))
        .termsAndConditions,
    ).toBe(DEFAULT_FLIGHT_TERMS_AND_CONDITIONS);
    expect(
      (await resolveServiceTerms({ organizationId: bare, serviceType: ServiceType.HOTEL }))
        .termsAndConditions,
    ).toBe(DEFAULT_HOTEL_TERMS_AND_CONDITIONS);
    // No organization at all: the deployment car text, the built-in others.
    expect(
      (await resolveServiceTerms({ organizationId: null, serviceType: ServiceType.HOTEL }))
        .cancellationPolicy,
    ).toBe(DEFAULT_HOTEL_CANCELLATION_POLICY);
  });
});

describe("email previews: an EXPLICIT service, the SELECTED brand's text for it — rendered HTML", () => {
  const TEMPLATES = ["payment-confirmation", "payment-request", "payment-authorized"] as const;

  async function emailsPage(service: ServiceType | undefined, template: string): Promise<string> {
    return renderToStaticMarkup(
      await AdminEmailsPage({
        searchParams: Promise.resolve(service ? { service, template } : { template }),
      }),
    );
  }

  async function editorPage(template: string, service: ServiceType | undefined): Promise<string> {
    return renderToStaticMarkup(
      await AdminTemplateEditorPage({
        params: Promise.resolve({ key: template }),
        searchParams: Promise.resolve(service ? { service } : {}),
      }),
    );
  }

  async function livePreview(template: string, body: Record<string, unknown>) {
    const res = await templatePreviewRoute(
      buildRequest(`/api/admin/email-templates/${template}/preview`, {
        method: "POST",
        body,
      }),
      { params: Promise.resolve({ key: template }) },
    );
    return jsonBody<{ ok: boolean; data: { html: string } }>(res);
  }

  beforeEach(async () => {
    for (const [key, name, serviceType] of [
      ["PREVIEWCARS", "Preview Cars", ServiceType.CAR_RENTAL],
      ["PREVIEWHOTELS", "Preview Hotels", ServiceType.HOTEL],
    ] as const) {
      await createProvider(
        {
          key,
          name,
          logo: "/providers/preview.png",
          primaryColor: "#123456",
          onPrimaryColor: "#FFFFFF",
          tagline: "",
          sortOrder: 0,
          serviceTypes: [serviceType],
        } as Parameters<typeof createProvider>[0],
        { actor: admin },
      );
    }
  });

  it("car / flight / hotel previews of the same brand each show only that service's text — on every preview surface", async () => {
    const org = await orgWithAllThree("previewsame", SERVICE_TEST);
    actingAs(org);
    for (const kind of KINDS) {
      const svc = SERVICE_OF[kind];
      const mustNot = [
        ...KINDS.filter((k) => k !== kind).flatMap((k) => both(SERVICE_TEST[k])),
        ...everyDefault(),
      ];
      const check = (html: string, where: string) => {
        for (const marker of both(SERVICE_TEST[kind])) {
          expect(html, `${where}: "${marker}"`).toContain(marker);
        }
        for (const marker of mustNot) {
          expect(html, `${where} must not show "${marker}"`).not.toContain(marker);
        }
      };
      for (const template of TEMPLATES) {
        const page = await emailsPage(svc, template);
        check(page, `Emails page ${kind} ${template}`);
        // The selected brand's own name, as its real emails carry it.
        expect(page).toContain("previewsame brand");
        check(await editorPage(template, svc), `editor page ${kind} ${template}`);
        const live = await livePreview(template, { serviceType: svc });
        expect(live.status).toBe(200);
        check(live.body.data.html, `live preview ${kind} ${template}`);
      }
    }
  });

  it("each brand's previews show its own text per service — never the other brand's (all six)", async () => {
    const texts = {
      A: { car: brandMarkers("A", "CAR"), flight: brandMarkers("A", "FLIGHT"), hotel: brandMarkers("A", "HOTEL") },
      B: { car: brandMarkers("B", "CAR"), flight: brandMarkers("B", "FLIGHT"), hotel: brandMarkers("B", "HOTEL") },
    };
    const orgs = {
      A: await orgWithAllThree("previewa", texts.A),
      B: await orgWithAllThree("previewb", texts.B),
    };
    const everyText = (["A", "B"] as const).flatMap((o) => KINDS.map((k) => texts[o][k]));
    for (const o of ["A", "B"] as const) {
      for (const kind of KINDS) {
        actingAs(orgs[o]);
        const own = texts[o][kind];
        for (const html of [
          await emailsPage(SERVICE_OF[kind], "payment-request"),
          (await livePreview("payment-confirmation", { serviceType: SERVICE_OF[kind] })).body.data.html,
        ]) {
          for (const marker of both(own)) expect(html).toContain(marker);
          for (const marker of everyText.filter((m) => m !== own).flatMap(both)) {
            expect(html).not.toContain(marker);
          }
        }
      }
    }
  });

  it("never guesses the service: a page without one redirects to an explicit one; the live preview refuses a missing or unsold one", async () => {
    const org = await makeOrg("previewguard", [ServiceType.FLIGHT, ServiceType.HOTEL]);
    actingAs(org);
    await expect(emailsPage(undefined, "payment-request")).rejects.toThrow(
      /NEXT_REDIRECT \/app\/admin\/emails\?template=payment-request&service=FLIGHT/,
    );
    await expect(emailsPage(ServiceType.CAR_RENTAL, "payment-request")).rejects.toThrow(
      /NEXT_REDIRECT .*service=FLIGHT/,
    );
    await expect(editorPage("payment-request", undefined)).rejects.toThrow(
      /NEXT_REDIRECT \/app\/admin\/email-templates\/payment-request\?service=FLIGHT/,
    );
    await expect(editorPage("payment-authorized", ServiceType.CAR_RENTAL)).rejects.toThrow(
      /NEXT_REDIRECT \/app\/admin\/email-templates\/payment-authorized\?service=FLIGHT/,
    );

    const missing = await livePreview("payment-request", {});
    expect(missing.status).toBe(422);
    // Not even a brand that sells car rental gets a car preview by default.
    const carSeller = await makeOrg("previewguardcar", ALL_SERVICES);
    actingAs(carSeller);
    expect((await livePreview("payment-request", {})).status).toBe(422);
    expect((await livePreview("payment-confirmation", { serviceType: "TRAIN" })).status).toBe(422);
    actingAs(org);
    const unsold = await livePreview("payment-request", { serviceType: ServiceType.CAR_RENTAL });
    expect(unsold.status).toBe(422);
    expect(JSON.stringify(unsold.body)).toContain("does not sell car rental");
  });

  it("with no brand selected: each service's own default — the deployment car text, the built-in flight and hotel texts", async () => {
    actingAs(null);
    for (const kind of KINDS) {
      for (const template of TEMPLATES) {
        const html = await emailsPage(SERVICE_OF[kind], template);
        for (const marker of both(DEFAULT_MARKERS[kind])) expect(html).toContain(marker);
        for (const k of KINDS.filter((k) => k !== kind)) {
          for (const marker of both(DEFAULT_MARKERS[k])) expect(html).not.toContain(marker);
        }
      }
    }
  });
});

describe("email template COPY is per service too — and per brand", () => {
  /** Save one service's copy for the acting brand through the editor's API. */
  async function saveCopy(
    template: string,
    body: Record<string, unknown>,
  ) {
    const res = await createTemplateRoute(
      buildRequest(`/api/admin/email-templates/${template}`, { method: "POST", body }),
      { params: Promise.resolve({ key: template }) },
    );
    return jsonBody<{ ok: boolean }>(res);
  }

  /** Create an order of `kind` in `orgId`, send its payment request and
   *  return what the customer received. */
  async function sentRequest(orgId: Types.ObjectId, kind: Kind) {
    actingAs(orgId);
    const { order } = await createOrder(orderInput(kind), { actor: admin });
    const { order: linked } = await initiatePayment(order.id, { actor: admin });
    sentMail.length = 0;
    await sendPaymentRequestEmail(linked, {}, { actor: admin });
    await sendPaymentConfirmationEmail(linked);
    await sendPaymentAuthorizedEmail(linked);
    return {
      request: lastSent(EmailKind.PAYMENT_LINK),
      confirmation: lastSent(EmailKind.PAYMENT_CONFIRMATION),
      authorized: lastSent(EmailKind.PAYMENT_AUTHORIZED),
    };
  }

  it("copy saved for one service reaches only that service's emails, in the same brand", async () => {
    const org = await orgWithAllThree("copysame", SERVICE_TEST);
    actingAs(org);
    for (const [svc, label] of [
      [ServiceType.CAR_RENTAL, "CAR"],
      [ServiceType.FLIGHT, "FLIGHT"],
    ] as const) {
      expect(
        (await saveCopy("payment-request", {
          serviceType: svc,
          subject: `${label} ONLY SUBJECT`,
          intro: `${label} ONLY INTRO about this booking.`,
          note: `${label} ONLY NOTE for the customer.`,
        })).status,
      ).toBe(201);
      expect(
        (await saveCopy("payment-confirmation", {
          serviceType: svc,
          subject: `${label} ONLY RECEIPT`,
        })).status,
      ).toBe(201);
    }

    expect(
      (await saveCopy("payment-authorized", {
        serviceType: ServiceType.FLIGHT,
        subject: "FLIGHT ONLY HOLD",
      })).status,
    ).toBe(201);

    const car = await sentRequest(org, "car");
    const flight = await sentRequest(org, "flight");
    const hotel = await sentRequest(org, "hotel");
    expect(flight.authorized.subject).toBe("FLIGHT ONLY HOLD");
    expect(car.authorized.subject).not.toContain("FLIGHT ONLY");
    expect(hotel.authorized.subject).not.toContain("FLIGHT ONLY");

    expect(car.request.subject).toBe("CAR ONLY SUBJECT");
    expect(car.request.html).toContain("CAR ONLY INTRO");
    expect(car.request.html).toContain("CAR ONLY NOTE");
    expect(car.confirmation.subject).toBe("CAR ONLY RECEIPT");
    expect(flight.request.subject).toBe("FLIGHT ONLY SUBJECT");
    expect(flight.request.html).toContain("FLIGHT ONLY INTRO");
    expect(flight.confirmation.subject).toBe("FLIGHT ONLY RECEIPT");
    for (const [name, mail, foreign] of [
      ["car", car, "FLIGHT ONLY"],
      ["flight", flight, "CAR ONLY"],
      ["hotel", hotel, "CAR ONLY"],
      ["hotel", hotel, "FLIGHT ONLY"],
    ] as const) {
      for (const body of [mail.request.html, mail.request.text, mail.request.subject, mail.confirmation.subject]) {
        expect(body, `${name} email carries "${foreign}" copy`).not.toContain(foreign);
      }
    }
    // Each email still carries its own service's T&C — copy and terms agree.
    expect(car.request.html).toContain(CAR_TERMS);
    expect(flight.request.html).toContain(FLIGHT_TERMS);
    expect(hotel.request.html).toContain(HOTEL_TERMS);
  });

  it("copy saved before copy was per service serves car rental only — never a flight or hotel email, in any brand", async () => {
    const org = await orgWithAllThree("copylegacy", SERVICE_TEST);
    // The brand's own pre-existing row, and a shared deployment row — both
    // written before rows had a service (no `serviceType` at all).
    for (const organizationId of [org, null]) {
      await EmailTemplate.collection.insertOne({
        templateKey: "payment-request",
        organizationId,
        version: organizationId ? 1 : 2,
        active: true,
        subject: null,
        greeting: null,
        intro: organizationId
          ? "LEGACY OWN INTRO: bring your driving licence to the counter."
          : "LEGACY SHARED INTRO: bring your driving licence to the counter.",
        note: null,
        supportHeadline: null,
        supportDescription: null,
        footerNote: null,
        createdBy: { userId: new Types.ObjectId(admin.id), name: admin.name },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    const other = await orgWithAllThree("copylegacyother", SERVICE_TEST);

    // The brand's own car rental emails keep exactly the copy they had.
    expect((await sentRequest(org, "car")).request.html).toContain("LEGACY OWN INTRO");
    // A car brand without copy of its own still gets the shared default.
    expect((await sentRequest(other, "car")).request.html).toContain("LEGACY SHARED INTRO");
    // Never a flight or a hotel email — of either brand.
    for (const [o, kind] of [
      [org, "flight"],
      [org, "hotel"],
      [other, "flight"],
      [other, "hotel"],
    ] as const) {
      const html = (await sentRequest(o, kind)).request.html;
      expect(html).not.toContain("LEGACY OWN INTRO");
      expect(html).not.toContain("LEGACY SHARED INTRO");
      expect(html).not.toContain("driving licence");
    }
  });

  it("one brand's copy for a service never reaches another brand's email for that service", async () => {
    const a = await orgWithAllThree("copya", SERVICE_TEST);
    const b = await orgWithAllThree("copyb", SERVICE_TEST);
    actingAs(a);
    expect(
      (await saveCopy("payment-request", {
        serviceType: ServiceType.FLIGHT,
        intro: "BRAND A FLIGHT INTRO for its passengers.",
      })).status,
    ).toBe(201);
    expect((await sentRequest(a, "flight")).request.html).toContain("BRAND A FLIGHT INTRO");
    expect((await sentRequest(b, "flight")).request.html).not.toContain("BRAND A FLIGHT INTRO");
  });

  it("refuses copy with no service, or for a service the brand does not sell", async () => {
    // A brand that sells everything still has to name the service.
    actingAs(await makeOrg("copyguardall", ALL_SERVICES));
    expect((await saveCopy("payment-request", { intro: "No service named." })).status).toBe(422);
    const org = await makeOrg("copyguard", [ServiceType.FLIGHT]);
    actingAs(org);
    const missing = await saveCopy("payment-request", { intro: "No service named." });
    expect(missing.status).toBe(422);
    const unsold = await saveCopy("payment-request", {
      serviceType: ServiceType.CAR_RENTAL,
      intro: "Car copy for a flight-only brand.",
    });
    expect(unsold.status).toBe(422);
    expect(JSON.stringify(unsold.body)).toContain("does not sell car rental");
    expect(await EmailTemplate.countDocuments({})).toBe(0);
  });
});

describe("template copy: no unowned or shared copy ever reaches a flight or hotel email", () => {
  async function saveCopy(template: string, body: Record<string, unknown>) {
    const res = await createTemplateRoute(
      buildRequest(`/api/admin/email-templates/${template}`, { method: "POST", body }),
      { params: Promise.resolve({ key: template }) },
    );
    return jsonBody<{ ok: boolean; data: { id: string } }>(res);
  }

  it("a shared row saved FOR flight (no brand) is never used by any brand's flight email", async () => {
    const org = await orgWithAllThree("sharedflight", SERVICE_TEST);
    await EmailTemplate.collection.insertOne({
      templateKey: "payment-request",
      serviceType: ServiceType.FLIGHT,
      organizationId: null,
      version: 1,
      active: true,
      subject: "SHARED FLIGHT SUBJECT",
      greeting: null,
      intro: "SHARED FLIGHT INTRO from no brand.",
      note: null,
      supportHeadline: null,
      supportDescription: null,
      footerNote: null,
      createdBy: { userId: new Types.ObjectId(admin.id), name: admin.name },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    actingAs(org);
    const { order } = await createOrder(orderInput("flight"), { actor: admin });
    const { order: linked } = await initiatePayment(order.id, { actor: admin });
    sentMail.length = 0;
    await sendPaymentRequestEmail(linked, {}, { actor: admin });
    const mail = lastSent(EmailKind.PAYMENT_LINK);
    expect(mail.subject).not.toContain("SHARED FLIGHT");
    expect(mail.html).not.toContain("SHARED FLIGHT INTRO");
  });

  it("with brands, copy cannot be saved with none selected, and a shared row cannot be switched on — not even by the default brand", async () => {
    // A deployment WITH brands: the default one and another.
    const defaultOrg = await makeOrg("defaultbrand", ALL_SERVICES);
    await Organization.updateOne({ _id: defaultOrg }, { $set: { isDefault: true } });
    await makeOrg("otherbrand", ALL_SERVICES);

    actingAs(null);
    const unowned = await saveCopy("payment-request", {
      serviceType: ServiceType.CAR_RENTAL,
      intro: "Copy that would belong to no brand.",
    });
    expect(unowned.status).toBe(403);
    expect(await EmailTemplate.countDocuments({})).toBe(0);

    const shared = await EmailTemplate.create({
      templateKey: "payment-request",
      organizationId: null,
      version: 7,
      active: false,
      intro: "SHARED ROW",
      createdBy: { userId: new Types.ObjectId(admin.id), name: admin.name },
    });
    // The DEFAULT brand's admin — whose scope does cover unowned rows.
    actingAs(defaultOrg);
    const res = await activateTemplateRoute(
      buildRequest(`/api/admin/email-templates/payment-request/${shared._id}/activate`, {
        method: "POST",
      }),
      { params: Promise.resolve({ key: "payment-request", versionId: String(shared._id) }) },
    );
    expect(res.status).toBe(404);
    expect((await EmailTemplate.findById(shared._id).lean())?.active).toBe(false);
  });

  it("with no brands at all, the deployment still saves and rolls back its own copy", async () => {
    actingAs(null);
    const v1 = await saveCopy("payment-request", {
      serviceType: ServiceType.CAR_RENTAL,
      intro: "Deployment copy v1.",
    });
    expect(v1.status).toBe(201);
    expect(
      (await saveCopy("payment-request", {
        serviceType: ServiceType.CAR_RENTAL,
        intro: "Deployment copy v2.",
      })).status,
    ).toBe(201);
    const rolledBack = await activateTemplateRoute(
      buildRequest(`/api/admin/email-templates/payment-request/${v1.body.data.id}/activate`, {
        method: "POST",
      }),
      { params: Promise.resolve({ key: "payment-request", versionId: v1.body.data.id }) },
    );
    expect(rolledBack.status).toBe(200);
    const active = await EmailTemplate.find({ active: true }).lean();
    expect(active.map((r) => r.intro)).toEqual(["Deployment copy v1."]);
  });

  it("each service keeps its own versions: listing, saving and rolling back one never touches another's", async () => {
    const org = await orgWithAllThree("versionsper", SERVICE_TEST);
    actingAs(org);
    const carV1 = await saveCopy("payment-request", { serviceType: ServiceType.CAR_RENTAL, intro: "CAR V1 intro." });
    await saveCopy("payment-request", { serviceType: ServiceType.CAR_RENTAL, intro: "CAR V2 intro." });
    const flightV1 = await saveCopy("payment-request", { serviceType: ServiceType.FLIGHT, intro: "FLIGHT V1 intro." });
    await saveCopy("payment-request", { serviceType: ServiceType.FLIGHT, intro: "FLIGHT V2 intro." });

    // Saving flight copy left the car copy live, and the reverse.
    const live = async (svc: ServiceType) =>
      (await getActiveTemplateContent("payment-request", String(org), svc))?.intro ?? null;
    expect(await live(ServiceType.CAR_RENTAL)).toBe("CAR V2 intro.");
    expect(await live(ServiceType.FLIGHT)).toBe("FLIGHT V2 intro.");
    expect(await live(ServiceType.HOTEL)).toBeNull();

    // Each service's editor lists only that service's versions.
    expect((await listTemplateVersions("payment-request", ServiceType.FLIGHT)).map((v) => v.intro)).toEqual([
      "FLIGHT V2 intro.",
      "FLIGHT V1 intro.",
    ]);
    expect((await listTemplateVersions("payment-request", ServiceType.CAR_RENTAL)).map((v) => v.intro)).toEqual([
      "CAR V2 intro.",
      "CAR V1 intro.",
    ]);
    expect(await listTemplateVersions("payment-request", ServiceType.HOTEL)).toEqual([]);

    // Rolling flight back leaves car where it was — and the reverse.
    for (const [id, svc] of [
      [flightV1.body.data.id, ServiceType.FLIGHT],
      [carV1.body.data.id, ServiceType.CAR_RENTAL],
    ] as const) {
      const res = await activateTemplateRoute(
        buildRequest(`/api/admin/email-templates/payment-request/${id}/activate`, { method: "POST" }),
        { params: Promise.resolve({ key: "payment-request", versionId: id }) },
      );
      expect(res.status, svc).toBe(200);
    }
    expect(await live(ServiceType.FLIGHT)).toBe("FLIGHT V1 intro.");
    expect(await live(ServiceType.CAR_RENTAL)).toBe("CAR V1 intro.");
  });

  it("the Emails page preview applies the brand's saved copy for the previewed service only", async () => {
    await createProvider(
      {
        key: "COPYCARS",
        name: "Copy Cars",
        logo: "/providers/preview.png",
        primaryColor: "#123456",
        onPrimaryColor: "#FFFFFF",
        tagline: "",
        sortOrder: 0,
        serviceTypes: [ServiceType.CAR_RENTAL],
      } as Parameters<typeof createProvider>[0],
      { actor: admin },
    );
    const org = await orgWithAllThree("previewcopy", SERVICE_TEST);
    actingAs(org);
    expect(
      (await saveCopy("payment-request", {
        serviceType: ServiceType.FLIGHT,
        intro: "FLIGHT PREVIEW INTRO for passengers.",
      })).status,
    ).toBe(201);
    const page = async (service: ServiceType) =>
      renderToStaticMarkup(
        await AdminEmailsPage({
          searchParams: Promise.resolve({ service, template: "payment-request" }),
        }),
      );
    expect(await page(ServiceType.FLIGHT)).toContain("FLIGHT PREVIEW INTRO");
    expect(await page(ServiceType.CAR_RENTAL)).not.toContain("FLIGHT PREVIEW INTRO");
  });
});

describe("the acknowledgement statement the customer confirms is per service too", () => {
  const CAR_ACK = "CAR ACK TEST: I agree to the car rental terms and will bring my licence.";

  it("car rental customers confirm the deployment statement; flight and hotel customers the built-in neutral one", async () => {
    await Setting.updateOne({ key: SETTINGS_KEY }, { $set: { consentMessage: CAR_ACK } });
    const org = await orgWithAllThree("ackorg", SERVICE_TEST);
    for (const kind of KINDS) {
      actingAs(org);
      const { order } = await createOrder(orderInput(kind), { actor: admin });
      const { order: linked } = await initiatePayment(order.id, { actor: admin });
      sentMail.length = 0;
      const { consentToken } = await sendPaymentRequestEmail(linked, {}, { actor: admin });
      const mail = lastSent(EmailKind.PAYMENT_LINK);
      const consent = await getPublicConsentView(consentToken!, { brandName: "x" });
      const composer = (
        await jsonBody<{ ok: true; data: { html: string } }>(
          await previewRoute(
            buildRequest(`/api/orders/${order.id}/payment-request-preview`, {
              method: "POST",
              body: {},
            }),
            { params: Promise.resolve({ id: order.id }) },
          ),
        )
      ).body.data.html;
      if (kind === "car") {
        expect(mail.html).toContain("CAR ACK TEST");
        expect(consent.consentMessage).toBe(CAR_ACK);
      } else {
        // The "Confirm by email" mailto carries the statement URL-encoded.
        const mailtos = [...mail.html.matchAll(/href="(mailto:[^"]+)"/g)].map((m) =>
          decodeURIComponent(m[1]!.replace(/&amp;/g, "&")),
        );
        expect(mailtos.length, `${kind}: a mailto`).toBeGreaterThan(0);
        for (const body of [mail.html, mail.text, composer, JSON.stringify(consent), ...mailtos]) {
          expect(body, `${kind}: car acknowledgement`).not.toContain("CAR ACK TEST");
        }
        expect(mailtos.some((m) => m.includes(DEFAULT_CONSENT_MESSAGE))).toBe(true);
        expect(consent.consentMessage).toBe(DEFAULT_CONSENT_MESSAGE);
      }
    }
  });

  it("the payment-request preview shows each service's own statement under the button", async () => {
    await Setting.updateOne({ key: SETTINGS_KEY }, { $set: { consentMessage: CAR_ACK } });
    for (const [key, serviceType] of [
      ["ACKCARS", ServiceType.CAR_RENTAL],
      ["ACKHOTELS", ServiceType.HOTEL],
    ] as const) {
      await createProvider(
        {
          key,
          name: key,
          logo: "/providers/preview.png",
          primaryColor: "#123456",
          onPrimaryColor: "#FFFFFF",
          tagline: "",
          sortOrder: 0,
          serviceTypes: [serviceType],
        } as Parameters<typeof createProvider>[0],
        { actor: admin },
      );
    }
    const org = await orgWithAllThree("ackpreview", SERVICE_TEST);
    actingAs(org);
    for (const kind of KINDS) {
      const html = renderToStaticMarkup(
        await AdminEmailsPage({
          searchParams: Promise.resolve({ service: SERVICE_OF[kind], template: "payment-request" }),
        }),
      );
      if (kind === "car") {
        expect(html).toContain("CAR ACK TEST");
      } else {
        expect(html, kind).not.toContain("CAR ACK TEST");
        expect(html, kind).toContain(DEFAULT_CONSENT_MESSAGE);
      }
    }
  });

  it("a statement saved in Settings from inside a brand reaches car rental customers only — never flight or hotel", async () => {
    const org = await orgWithAllThree("ackedit", SERVICE_TEST);
    actingAs(org);
    const current = await getSettings();
    const res = await patchSettingsRoute(
      buildRequest("/api/admin/settings", {
        method: "PATCH",
        body: {
          paymentExpiryHours: current.paymentExpiryHours,
          orderPrefix: current.orderPrefix,
          allowedBookingTypes: current.allowedBookingTypes,
          defaultCurrency: current.defaultCurrency,
          successRedirectUrl: current.successRedirectUrl,
          cancelRedirectUrl: current.cancelRedirectUrl,
          consentMessage: "EDITED ACK: I agree to the rental terms for my car.",
        },
      }),
    );
    expect(res.status).toBe(200);
    for (const kind of KINDS) {
      actingAs(org);
      const { order } = await createOrder(orderInput(kind), { actor: admin });
      const { order: linked } = await initiatePayment(order.id, { actor: admin });
      sentMail.length = 0;
      const { consentToken } = await sendPaymentRequestEmail(linked, {}, { actor: admin });
      const mail = lastSent(EmailKind.PAYMENT_LINK);
      const consent = await getPublicConsentView(consentToken!, { brandName: "x" });
      if (kind === "car") {
        expect(consent.consentMessage).toBe("EDITED ACK: I agree to the rental terms for my car.");
      } else {
        expect(mail.html).not.toContain("EDITED ACK");
        expect(consent.consentMessage).toBe(DEFAULT_CONSENT_MESSAGE);
      }
    }
  });
});
