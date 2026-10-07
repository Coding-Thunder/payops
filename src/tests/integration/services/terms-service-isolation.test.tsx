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
import { Order, Organization, OrganizationMember } from "@/server/db/models";
import {
  DEFAULT_FLIGHT_CANCELLATION_POLICY,
  DEFAULT_FLIGHT_LEGAL_VERSION,
  DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
} from "@/server/db/models/setting.model";
import { orgCookieName } from "@/server/auth/org-cookie";
import { createOrder, initiatePayment } from "@/server/services/order.service";
import { createProvider } from "@/server/services/provider.service";
import { getEvidenceChain } from "@/server/services/evidence.service";
import { getPublicAcknowledgementView } from "@/server/services/acknowledgement.service";
import { generateAckToken } from "@/server/services/ack-token";
import { getPublicConsentView } from "@/server/services/consent.service";
import { updateOrganizationServiceLegal } from "@/server/services/organization-legal.service";
import { getSettings } from "@/server/services/settings.service";
import { GET as getOrderRoute } from "@/app/api/orders/[id]/route";
import { POST as previewRoute } from "@/app/api/orders/[id]/payment-request-preview/route";
import { POST as templatePreviewRoute } from "@/app/api/admin/email-templates/[key]/preview/route";
import AdminEmailsPage from "@/app/app/admin/emails/page";
import PaymentSuccessPage from "@/app/pay/success/page";
import { createSettings } from "@/tests/factories/settings.factory";
import {
  roundTripFlightInput,
  validCreateOrderInput,
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
 *
 * Same organization, different service, different terms — and never another
 * organization's. Checked where the T&C text is actually shown: the order
 * API behind the operator's order page, the composer preview, the payment
 * request / confirmation / authorized emails (HTML and plain text), the
 * acknowledge page and the evidence chain (the evidence PDF's only input).
 * The consent page and the payment-success page show no T&C text at all;
 * they are checked to carry none of another service's or brand's either.
 * The admin email previews are checked per service and per brand.
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
};

interface Markers {
  terms: string[];
  policy: string[];
}

const both = (m: Markers) => [...m.terms, ...m.policy];

/** One brand's own text for one service, as the brand's editor saved it. */
function brandMarkers(org: "A" | "B", service: "CAR" | "FLIGHT"): Markers {
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
  return { html: String(msg!.html), text: String(msg!.text) };
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

type Kind = "car" | "flight";

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
  const input =
    kind === "car" ? validCreateOrderInput() : roundTripFlightInput({ provider: "AIRINDIA" });
  const { order } = await createOrder(input, { actor: admin });
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

describe("SAME organization: car rental → car T&C, flight → flight T&C", () => {
  it("a car order shows CAR TERMS TEST and never FLIGHT TERMS TEST; a flight order the reverse — on every surface", async () => {
    const org = await makeOrg("sameorg", [ServiceType.CAR_RENTAL, ServiceType.FLIGHT]);
    await setBrandTerms(org, ServiceType.CAR_RENTAL, CAR_TEST);
    await setBrandTerms(org, ServiceType.FLIGHT, FLIGHT_TEST);

    // Back to back, in either order, in the same brand.
    const car = await surfaces(org, "car");
    const flight = await surfaces(org, "flight");
    const carAgain = await surfaces(org, "car");

    expect(car.order.serviceType).toBe(ServiceType.CAR_RENTAL);
    expect(flight.order.serviceType).toBe(ServiceType.FLIGHT);
    const defaults = [...both(DEFAULT_MARKERS.car), ...both(DEFAULT_MARKERS.flight)];
    for (const s of [car, carAgain]) {
      expectOnly(s, CAR_TEST, [...both(FLIGHT_TEST), ...defaults]);
    }
    expectOnly(flight, FLIGHT_TEST, [...both(CAR_TEST), ...defaults]);
  });

  it("an order keeps the text it froze: later edits to either service, in this brand or another, and the admin's current brand change nothing", async () => {
    const org = await makeOrg("frozen", [ServiceType.CAR_RENTAL, ServiceType.FLIGHT]);
    const other = await makeOrg("elsewhere", [ServiceType.CAR_RENTAL, ServiceType.FLIGHT]);
    await setBrandTerms(org, ServiceType.CAR_RENTAL, CAR_TEST);
    await setBrandTerms(org, ServiceType.FLIGHT, FLIGHT_TEST);
    const car = await surfaces(org, "car");
    const flight = await surfaces(org, "flight");

    // Afterwards: BOTH of this brand's texts edited, the other brand given
    // texts of its own, and the admin left working in the other brand.
    const editedLater: Markers = {
      terms: ["CAR TERMS EDITED LATER", "FLIGHT TERMS EDITED LATER"],
      policy: ["CAR POLICY EDITED LATER", "FLIGHT POLICY EDITED LATER"],
    };
    await setTerms(org, ServiceType.CAR_RENTAL, "CAR TERMS EDITED LATER", "CAR POLICY EDITED LATER");
    await setTerms(org, ServiceType.FLIGHT, "FLIGHT TERMS EDITED LATER", "FLIGHT POLICY EDITED LATER");
    await setTerms(other, ServiceType.CAR_RENTAL, "OTHER BRAND CAR TERMS", "OTHER BRAND CAR POLICY");
    await setTerms(other, ServiceType.FLIGHT, "OTHER BRAND FLIGHT TERMS", "OTHER BRAND FLIGHT POLICY");
    const foreign = [
      ...both(editedLater),
      "OTHER BRAND CAR TERMS",
      "OTHER BRAND CAR POLICY",
      "OTHER BRAND FLIGHT TERMS",
      "OTHER BRAND FLIGHT POLICY",
    ];

    // Re-read from the database, emails sent while working in the other brand.
    expectOnly(await rerendered(car.order.id, org, other), CAR_TEST, [
      ...both(FLIGHT_TEST),
      ...foreign,
    ]);
    expectOnly(await rerendered(flight.order.id, org, other), FLIGHT_TEST, [
      ...both(CAR_TEST),
      ...foreign,
    ]);
  });
});

describe("DIFFERENT organizations: each order gets its OWN organization's text for its OWN service", () => {
  it("Org A car / Org A flight / Org B car / Org B flight", async () => {
    const a = await makeOrg("orga", [ServiceType.CAR_RENTAL, ServiceType.FLIGHT]);
    const b = await makeOrg("orgb", [ServiceType.CAR_RENTAL, ServiceType.FLIGHT]);
    const aCarText = brandMarkers("A", "CAR");
    const aFlightText = brandMarkers("A", "FLIGHT");
    const bCarText = brandMarkers("B", "CAR");
    const bFlightText = brandMarkers("B", "FLIGHT");
    await setBrandTerms(a, ServiceType.CAR_RENTAL, aCarText);
    await setBrandTerms(a, ServiceType.FLIGHT, aFlightText);
    await setBrandTerms(b, ServiceType.CAR_RENTAL, bCarText);
    await setBrandTerms(b, ServiceType.FLIGHT, bFlightText);

    const everyText = [aCarText, aFlightText, bCarText, bFlightText];
    const othersThan = (keep: Markers) =>
      everyText.filter((m) => m !== keep).flatMap(both);

    // Interleaved across brands, as an operator switching workspaces would.
    const aCar = await surfaces(a, "car");
    const bFlight = await surfaces(b, "flight");
    const aFlight = await surfaces(a, "flight");
    const bCar = await surfaces(b, "car");

    expectOnly(aCar, aCarText, othersThan(aCarText));
    expectOnly(aFlight, aFlightText, othersThan(aFlightText));
    expectOnly(bCar, bCarText, othersThan(bCarText));
    expectOnly(bFlight, bFlightText, othersThan(bFlightText));
  });
});

describe("a service with no text of its own falls back to ITS OWN default — never another service's", () => {
  it("flight with no flight terms: the brand-neutral flight default, never the brand's car terms", async () => {
    const org = await makeOrg("noflightterms", [ServiceType.CAR_RENTAL, ServiceType.FLIGHT]);
    await setBrandTerms(org, ServiceType.CAR_RENTAL, CAR_TEST);

    const flight = await surfaces(org, "flight");
    expect(flight.order.terms).toEqual({
      text: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });
    expect(flight.order.policy.text).toBe(DEFAULT_FLIGHT_CANCELLATION_POLICY);
    expectOnly(flight, DEFAULT_MARKERS.flight, [
      ...both(CAR_TEST),
      ...both(DEFAULT_MARKERS.car),
    ]);
  });

  it("car rental with no car terms of its own: exactly the existing behaviour — the deployment default", async () => {
    const org = await makeOrg("nocarterms", [ServiceType.CAR_RENTAL, ServiceType.FLIGHT]);
    await setBrandTerms(org, ServiceType.FLIGHT, FLIGHT_TEST);
    const settings = await getSettings();

    const car = await surfaces(org, "car");
    expect(car.order.terms).toEqual({
      text: settings.termsAndConditions,
      version: settings.termsVersion,
    });
    expect(car.order.policy.text).toBe(settings.cancellationPolicy);
    expectOnly(car, DEFAULT_MARKERS.car, [
      ...both(FLIGHT_TEST),
      ...both(DEFAULT_MARKERS.flight),
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

describe("admin email previews show the SELECTED brand's text for the PREVIEWED service", () => {
  const TEMPLATES = ["payment-confirmation", "payment-request", "payment-authorized"] as const;

  async function emailsPage(service: ServiceType, template: string): Promise<string> {
    return renderToStaticMarkup(
      await AdminEmailsPage({ searchParams: Promise.resolve({ service, template }) }),
    );
  }

  async function templateEditorPreview(template: string): Promise<string> {
    const res = await templatePreviewRoute(
      buildRequest(`/api/admin/email-templates/${template}/preview`, {
        method: "POST",
        body: {},
      }),
      { params: Promise.resolve({ key: template }) },
    );
    const { status, body } = await jsonBody<{ ok: true; data: { html: string } }>(res);
    expect(status, JSON.stringify(body)).toBe(200);
    return body.data.html;
  }

  beforeEach(async () => {
    await createProvider(
      {
        key: "PREVIEWCARS",
        name: "Preview Cars",
        logo: "/providers/preview-cars.png",
        primaryColor: "#123456",
        onPrimaryColor: "#FFFFFF",
        tagline: "",
        sortOrder: 0,
        serviceTypes: [ServiceType.CAR_RENTAL],
      } as Parameters<typeof createProvider>[0],
      { actor: admin },
    );
  });

  it("car preview → that brand's car text, flight preview → its flight text, for brand A and brand B", async () => {
    const a = await makeOrg("previewa", [ServiceType.CAR_RENTAL, ServiceType.FLIGHT]);
    const b = await makeOrg("previewb", [ServiceType.CAR_RENTAL, ServiceType.FLIGHT]);
    const texts = {
      a: { car: brandMarkers("A", "CAR"), flight: brandMarkers("A", "FLIGHT") },
      b: { car: brandMarkers("B", "CAR"), flight: brandMarkers("B", "FLIGHT") },
    };
    for (const [org, t] of [[a, texts.a], [b, texts.b]] as const) {
      await setBrandTerms(org, ServiceType.CAR_RENTAL, t.car);
      await setBrandTerms(org, ServiceType.FLIGHT, t.flight);
    }
    const everyText = [texts.a.car, texts.a.flight, texts.b.car, texts.b.flight];

    for (const [org, t] of [[a, texts.a], [b, texts.b]] as const) {
      for (const [service, own] of [
        [ServiceType.CAR_RENTAL, t.car],
        [ServiceType.FLIGHT, t.flight],
      ] as const) {
        for (const template of TEMPLATES) {
          actingAs(org);
          const html = await emailsPage(service, template);
          for (const marker of both(own)) {
            expect(html, `${service} ${template}: "${marker}"`).toContain(marker);
          }
          for (const marker of everyText.filter((m) => m !== own).flatMap(both)) {
            expect(html, `${service} ${template} must not show "${marker}"`).not.toContain(marker);
          }
        }
      }
      // The template editor's live preview is a car rental sample: the
      // brand's car text, never its flight text.
      for (const template of ["payment-request", "payment-confirmation"]) {
        actingAs(org);
        const html = await templateEditorPreview(template);
        for (const marker of both(t.car)) expect(html).toContain(marker);
        for (const marker of everyText.filter((m) => m !== t.car).flatMap(both)) {
          expect(html).not.toContain(marker);
        }
      }
    }
  });

  it("with no brand selected: the car preview shows the deployment default, the flight preview the built-in flight default", async () => {
    actingAs(null);
    for (const template of TEMPLATES) {
      const car = await emailsPage(ServiceType.CAR_RENTAL, template);
      for (const marker of both(DEFAULT_MARKERS.car)) expect(car).toContain(marker);
      for (const marker of both(DEFAULT_MARKERS.flight)) expect(car).not.toContain(marker);

      const flight = await emailsPage(ServiceType.FLIGHT, template);
      for (const marker of both(DEFAULT_MARKERS.flight)) expect(flight).toContain(marker);
      for (const marker of both(DEFAULT_MARKERS.car)) expect(flight).not.toContain(marker);
    }
  });
});
