import { execFile } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import mongoose, { Types } from "mongoose";

import {
  GET as legalGetRoute,
  PATCH as legalPatchRoute,
} from "@/app/api/admin/settings/legal/route";
import {
  GET as consentViewRoute,
  POST as confirmConsentRoute,
} from "@/app/api/consent/[token]/route";
import { GET as createConfigRoute } from "@/app/api/orders/create-config/route";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { GET as getOrderRoute } from "@/app/api/orders/[id]/route";
import { POST as confirmationNumberRoute } from "@/app/api/orders/[id]/confirmation-number/route";
import { POST as generateLinkRoute } from "@/app/api/orders/[id]/generate-payment-link/route";
import { POST as previewRoute } from "@/app/api/orders/[id]/payment-request-preview/route";
import { POST as resendConfirmationRoute } from "@/app/api/orders/[id]/resend-confirmation/route";
import { POST as sendRequestRoute } from "@/app/api/orders/[id]/send-payment-request/route";
import { POST as paypalWebhookRoute } from "@/app/api/webhooks/paypal/[orgSlug]/route";
import AcknowledgePage from "@/app/acknowledge/[token]/page";
import AdminSettingsPage from "@/app/app/admin/settings/page";
import CreateOrderPage from "@/app/app/orders/create/page";
import ConsentPage from "@/app/consent/[token]/page";
import PaymentSuccessPage from "@/app/pay/success/page";
import {
  AuditAction,
  CaptureMode,
  EmailKind,
  OrderStatus,
  PaymentGatewayKey,
  PaymentTiming,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { logger } from "@/lib/logger";
import { mergeServiceTypes } from "@/lib/organization-service-types";
import { nextPolicyVersion } from "@/lib/policy-version";
import {
  AuditLog,
  Branding,
  Order,
  OrderEvidence,
  Organization,
  OrganizationMember,
  Provider,
  Setting,
  SETTINGS_KEY,
} from "@/server/db/models";
import {
  DEFAULT_CANCELLATION_POLICY,
  DEFAULT_FLIGHT_CANCELLATION_POLICY,
  DEFAULT_FLIGHT_LEGAL_VERSION,
  DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
  DEFAULT_HOTEL_CANCELLATION_POLICY,
  DEFAULT_HOTEL_LEGAL_VERSION,
  DEFAULT_HOTEL_TERMS_AND_CONDITIONS,
  DEFAULT_TERMS_AND_CONDITIONS,
} from "@/server/db/models/setting.model";
import { orgCookieName } from "@/server/auth/org-cookie";
import { formatEmailDate } from "@/server/email/format";
import { renderEmailPreview } from "@/server/email/preview";
import { _setPayPalFetchForTesting } from "@/server/payments/gateways/paypal";
import { resolveOrganizationServiceTypes } from "@/server/services/organization-service-types";
import { createProvider } from "@/server/services/provider.service";
import { createSettings } from "@/tests/factories/settings.factory";
import {
  roundTripFlightInput,
  validCreateOrderInput,
  validHotelOrderInput,
} from "@/tests/fixtures/order-input.fixture";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";
import type { OrderDTO, PublicConsentView } from "@/types";

/**
 * ENABLE FLIGHT FOR TRIPRESERVATIONS — through the organization service
 * capability that exists for exactly this — and verify the complete Flight
 * workflow on a deployment shaped like production, with ZERO ADMIN
 * DEPENDENCY for Terms & Conditions.
 *
 * THE WORLD (production, read-only facts):
 *
 *   rentalconfirmation   the DEFAULT organization, Stripe, `serviceTypes`
 *                        NOT STORED, no legal of its own
 *   tripreservations     "Trip Reservations", PayPal, automatic capture
 *                        (`payments.captureMode` not stored), `serviceTypes`
 *                        NOT STORED, NO legal of its own at all
 *   globevista           "FlightBizz", Stripe, MANUAL capture, sells
 *                        [FLIGHT, HOTEL, CAR_RENTAL], its own flight terms
 *                        (and no hotel or car text of its own)
 *
 * The absent keys are removed with the raw driver, so no Mongoose default
 * can stand in for them: an absent `serviceTypes` must READ as [CAR_RENTAL]
 * (`serviceTypesOrDefault`), and Mongo's `$addToSet` on it would silently
 * turn "add FLIGHT" into "sell flights instead of cars". The deployment's
 * car terms carry distinct markers so a leak into a flight is visible.
 *
 * THE MECHANISM: `scripts/set-organization-services.ts`, run as a child
 * process (npx tsx) against THIS file's in-memory database — a dry run
 * first, then APPLY=1 — exactly as an operator runs it. Every test that
 * needs Flight enabled enables it the same way, so everything downstream
 * runs on precisely the document the real script writes (`serviceTypes`
 * and nothing else — no legal text).
 *
 * THE T&C RULE (nobody configures anything): an order's terms are decided by
 * its organization and its service type alone —
 *
 *   CAR_RENTAL   the organization's own car text if it customised it, else
 *                the deployment's pre-written car text (Settings), else —
 *                were that ever blank — the built-in car defaults
 *   FLIGHT       the organization's own flight text if it customised it,
 *                else the built-in DEFAULT_FLIGHT_* (DEFAULT_FLIGHT_LEGAL_VERSION)
 *   HOTEL        likewise, the built-in DEFAULT_HOTEL_*
 *
 * — never another service's text, never another organization's. So
 * TripReservations' very first flight order freezes the built-in flight
 * terms with no settings action, the create page shows no terms notice,
 * `GET /api/orders/create-config` carries no `legalStatus`, and Admin →
 * Settings is optional customisation only: a saved override reaches the
 * NEXT order, and orders already frozen keep their text.
 *
 * Then, through the real route handlers with an authenticated operator and
 * the selected-organization cookie: the T&C above, the whole PayPal flight
 * journey (create → link → PNR → preview → sent request → consent →
 * webhooks → confirmation → resend) on the built-in flight terms, the
 * charge rename, a Stripe flight brand beside it, TripReservations'
 * unchanged car rental, and the other organizations' unchanged capability.
 *
 *   0. world           the stored shape above, verified
 *   1. capability      before / enable (dry run, apply, re-run) / after
 *   2. T&C             zero configuration → built-in flight / deployment car;
 *                      an optional override reaches only the next order
 *   3. flight journey  PayPal, every customer surface, PNR, resend, rename —
 *                      all on the built-in flight terms, nothing configured
 *   4. Stripe          FlightBizz's flight: 10000 minor units, own terms;
 *                      its uncustomised hotel / car: built-in / deployment
 *   5. car regression  TripReservations' car rental after enabling Flight
 *   6. other orgs      rentalconfirmation still cannot sell a flight
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
      sentMail.push({ ...m, __transport: "deployment" });
      return { messageId: "<deployment>", response: "250 OK" };
    },
  }),
  getMailerFor: (cfg: { user: string }) => ({
    sendMail: async (m: Record<string, unknown>) => {
      sentMail.push({ ...m, __transport: `org:${cfg.user}` });
      return { messageId: "<organization>", response: "250 OK" };
    },
  }),
  verifyMailer: async () => {},
  _resetOrgMailersForTests: () => {},
}));

const { drainPendingEmails } = await import("@/server/services/email-outbox.service");

/* ------------------------------------------------------------------ *
 * The deployment, as production has it
 * ------------------------------------------------------------------ */

type OrgKey = "rc" | "trip" | "gv";

/** The deployment Branding singleton — RentalConfirmation's, in production. */
const RC = {
  slug: "rentalconfirmation",
  brandName: "Rental Confirmation",
  supportEmail: "support@rentalconfirmation.com",
  supportPhone: "+15513071441",
} as const;

/** Trip Reservations as configured in production (brand-leak.test.ts):
 *  its own mailbox and transport, its own support address, NO phone. */
const TRIP = {
  slug: "tripreservations",
  brandName: "Trip Reservations",
  supportEmail: "contact@tripreservations.test",
  fromEmail: "contact@tripreservations.test",
} as const;

/** GlobeVista: operations name; FlightBizz is the only name its customers see. */
const GV = {
  slug: "globevista",
  name: "GlobeVista",
  brandName: "FlightBizz",
  supportEmail: "support@flightbizz.test",
  fromEmail: "bookings@flightbizz.test",
} as const;

const SLUG: Record<OrgKey, string> = { rc: RC.slug, trip: TRIP.slug, gv: GV.slug };

const ORG_ENV: Record<string, string> = {
  ORG_TRIPRESERVATIONS_PAYPAL_CLIENT_ID: "tripreservations-client-id",
  ORG_TRIPRESERVATIONS_PAYPAL_CLIENT_SECRET: "tripreservations-client-secret",
  ORG_TRIPRESERVATIONS_PAYPAL_WEBHOOK_ID: "WEBHOOK-TRIPRESERVATIONS",
  ORG_TRIPRESERVATIONS_PAYPAL_SANDBOX: "true",
  ORG_TRIPRESERVATIONS_SMTP_PASSWORD: "app-password",
  ORG_GLOBEVISTA_STRIPE_SECRET_KEY: "sk_test_globevista_only",
  ORG_GLOBEVISTA_STRIPE_WEBHOOK_SECRET: "whsec_globevista_only",
};

/* Every terms / policy text in the deployment carries an apostrophe-free
 * marker (HTML escaping), and no marker is a substring of another. */

/** The deployment Settings car text — what every car order of a brand
 *  that never customised its car terms (all three, here) freezes. */
const DEPLOYMENT_CAR_TERMS = "DEPLOYMENT CAR TERMS";
const DEPLOYMENT_CAR_POLICY = "DEPLOYMENT CAR POLICY";
const DEPLOYMENT_CAR_TERMS_TEXT = `${DEPLOYMENT_CAR_TERMS} — the renter presents a licence at the counter.`;
const DEPLOYMENT_CAR_POLICY_TEXT = `${DEPLOYMENT_CAR_POLICY} — refunds follow the rental desk rules.`;

/** TripReservations' own flight text — an OPTIONAL override, saved through
 *  Admin → Settings only where a test says so. */
const TRIP_FLIGHT_TERMS = "TRIPRES FLIGHT TERMS";
const TRIP_FLIGHT_POLICY = "TRIPRES FLIGHT POLICY";
const TRIP_FLIGHT_TERMS_TEXT = `${TRIP_FLIGHT_TERMS} — tickets follow the operating airline fare rules.`;
const TRIP_FLIGHT_POLICY_TEXT = `${TRIP_FLIGHT_POLICY} — changes follow the airline release of the fare.`;

/** FlightBizz's own flight text. */
const FLIGHTBIZZ_FLIGHT_TERMS = "FLIGHTBIZZ FLIGHT TERMS";
const FLIGHTBIZZ_FLIGHT_POLICY = "FLIGHTBIZZ FLIGHT POLICY";
const FLIGHTBIZZ_FLIGHT_TERMS_TEXT = `${FLIGHTBIZZ_FLIGHT_TERMS} — FlightBizz issues every ticket itself.`;
const FLIGHTBIZZ_FLIGHT_POLICY_TEXT = `${FLIGHTBIZZ_FLIGHT_POLICY} — FlightBizz refunds within ten days.`;

/* Apostrophe-free lines, each found in exactly one built-in default text —
 * test 0b checks every one against the exported constants, so none can go
 * stale and make an absence check vacuous. */

/** The built-in FLIGHT terms — the v3 travel-supplier and PNR wording
 *  among them… */
const BUILT_IN_FLIGHT_TERMS = [
  "with the airline(s) and any travel supplier shown in your itinerary.",
  "The amount shown as payable now is the only amount collected through this payment.",
  "Once your booking is ticketed, your airline booking reference (PNR) appears on your confirmation.",
];
/** …and the built-in FLIGHT cancellation policy. */
const BUILT_IN_FLIGHT_POLICY = [
  "Changes and cancellations to airline tickets are governed by the fare rules of the ticket issued.",
];
const BUILT_IN_FLIGHT = [...BUILT_IN_FLIGHT_TERMS, ...BUILT_IN_FLIGHT_POLICY];
const BUILT_IN_HOTEL = [
  "Changes to the dates, rooms or guests may change the price and are subject to availability.",
  "Where a refund is due, it is made to your original payment method and is limited to the amount you paid online.",
];
/** The settings model's own car defaults — replaced here by the
 *  deployment's text, so they surface only where that text is blank (2c). */
const BUILT_IN_CAR = [
  "The prepaid amount is charged today to secure your reservation.",
  "Cancellations made more than 24 hours before pick-up are eligible for a full refund.",
];

/** Everything of FlightBizz's that would identify it to another brand's customer. */
const FLIGHTBIZZ_MARKERS = [
  GV.brandName,
  GV.name,
  GV.slug,
  GV.supportEmail,
  GV.fromEmail,
  FLIGHTBIZZ_FLIGHT_TERMS,
  FLIGHTBIZZ_FLIGHT_POLICY,
];
/** …and of the deployment brand (RentalConfirmation's Branding singleton). */
const RENTALCONFIRMATION_MARKERS = [
  RC.brandName,
  RC.slug,
  RC.supportEmail,
  RC.supportPhone,
  "15513071441",
];
/** …and of Trip Reservations, for the other brands' customers. */
const TRIP_MARKERS = [TRIP.brandName, TRIP.slug, TRIP.supportEmail, TRIP_FLIGHT_TERMS, TRIP_FLIGHT_POLICY];

/* The suppliers are global: no organization restriction. */
const CAR_SUPPLIER = "Budget";
const AIRLINE = "Air India";
const AIRLINE_KEY = "AIRINDIA";
const HOTEL_SUPPLIER_KEY = "HARBOURSTAYS";

/* The flight every TripReservations journey books: a ROUND TRIP with a
 * connection (and a recorded layover) each way — Delhi → Varanasi → Mumbai,
 * back Mumbai → Varanasi → Delhi — two adults and a child in Business, four
 * flights with their airlines and flight numbers. */
const FLIGHT_CHARGE = "Rental Cost";
const RENAMED_CHARGE = "Processing Fee";
const PNR = "AXXXYY";
const OUTBOUND = "Delhi → Varanasi → Mumbai";
const INBOUND = "Mumbai → Varanasi → Delhi";
/** The trip-level rows every flight surface lists, in order. */
const FLIGHT_ROWS =
  `Trip type Round trip Outbound ${OUTBOUND} Return ${INBOUND} ` +
  "Cabin Business Passengers 2 adults, 1 child";
/** Each flight — airline and flight number, day and times — and each
 *  layover, as every itinerary block prints them. */
const ITINERARY_LINES = [
  "Delhi → Varanasi Air India • AI123 Sat, Oct 10, 2026 10:30 AM → 12:00 PM",
  "Layover: 2h 30m — Varanasi Change terminals",
  "Varanasi → Mumbai IndiGo • 6E456 Sat, Oct 10, 2026 2:30 PM → 4:30 PM",
  "Mumbai → Varanasi IndiGo • 6E789 Thu, Oct 15, 2026 9:00 AM → 11:00 AM",
  "Layover: 2h — Varanasi Lounge access included",
  "Varanasi → Delhi Air India • AI124 Thu, Oct 15, 2026 1:15 PM → 2:45 PM",
];
/** What the gateway shows beside the amount, after the charge's name. */
const DEPARTS_RETURNS = "Departs: Sat, Oct 10, 2026 10:30 AM • Returns: Thu, Oct 15, 2026 9:00 AM";

const EXPLAINER =
  "Airline Charge is shown for the total booking value and is not collected through this payment link.";

/** Car-rental words a flight customer never reads (its charge is NAMED
 *  "Rental Cost", so "rental" itself is fair). */
const CAR_WORDS_IN_A_FLIGHT = ["vehicle", "pick-up", "drop-off", "counter"];
/** The car email's own phrases — never on a flight's surfaces. */
const CAR_PHRASES = [
  "What you're paying",
  "Amount paid online",
  "Amount due at counter",
  "Total rental cost",
  "Review & Confirm Booking",
];
/** A flight's rows and words — never on a car rental's surfaces. */
const FLIGHT_PHRASES = [
  "Airline Charge",
  "Total Booking Value",
  "Amount Payable Now",
  "Not collected through this payment link",
  "Price breakdown",
  "Flight itinerary",
  "Airline / Supplier",
];

const operator = actorFor(UserRole.ADMIN, { name: "Olivia Operator" });

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
const orgIds = {} as Record<OrgKey, Types.ObjectId>;
/** Every PayPal API call the stub answered (OAuth excepted), in order. */
let paypalCalls: { url: string; body: unknown }[] = [];
let paypalOrderSeq = 0;
let ipSeq = 0;

function uniqueIp(): string {
  ipSeq += 1;
  return `10.77.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
}

async function memberOf(orgId: Types.ObjectId) {
  await OrganizationMember.create({
    organizationId: orgId,
    userId: new Types.ObjectId(operator.id),
    role: operator.role,
    status: RecordState.ACTIVE,
  });
}

/** Remove keys with the raw driver: the document then looks exactly like a
 *  production row written before those fields existed. */
async function unsetRaw(orgId: Types.ObjectId, paths: string[]) {
  await Organization.collection.updateOne(
    { _id: orgId },
    { $unset: Object.fromEntries(paths.map((p) => [p, ""])) },
  );
}

async function makeRentalConfirmation(): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: RC.slug,
    name: RC.brandName,
    brandName: RC.brandName,
    isDefault: true,
    payments: {
      provider: PaymentGatewayKey.STRIPE,
      enabledProviders: [PaymentGatewayKey.STRIPE],
    },
    support: { email: RC.supportEmail, phone: RC.supportPhone },
  });
  const id = doc._id as Types.ObjectId;
  await unsetRaw(id, ["serviceTypes", "legal"]);
  await memberOf(id);
  return id;
}

async function makeTripReservations(): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: TRIP.slug,
    name: TRIP.brandName,
    brandName: TRIP.brandName,
    isDefault: false,
    payments: {
      provider: PaymentGatewayKey.PAYPAL,
      enabledProviders: [PaymentGatewayKey.PAYPAL],
    },
    email: {
      fromName: TRIP.brandName,
      fromEmail: TRIP.fromEmail,
      replyTo: "",
      transport: { host: "smtp.gmail.com", port: 587, secure: false, user: TRIP.fromEmail },
    },
    support: { email: TRIP.supportEmail, phone: "" },
  });
  const id = doc._id as Types.ObjectId;
  // No service list, no legal of any kind, no capture mode: automatic.
  await unsetRaw(id, ["serviceTypes", "legal", "payments.captureMode"]);
  await memberOf(id);
  return id;
}

async function makeGlobeVista(): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: GV.slug,
    name: GV.name,
    brandName: GV.brandName,
    isDefault: false,
    payments: {
      provider: PaymentGatewayKey.STRIPE,
      enabledProviders: [PaymentGatewayKey.STRIPE],
      captureMode: CaptureMode.MANUAL,
    },
    serviceTypes: [ServiceType.FLIGHT, ServiceType.HOTEL, ServiceType.CAR_RENTAL],
    email: { fromName: GV.brandName, fromEmail: GV.fromEmail, replyTo: "" },
    support: { email: GV.supportEmail, phone: "" },
  });
  const id = doc._id as Types.ObjectId;
  await memberOf(id);
  return id;
}

/** The operator, signed in, working in `key`'s organization. */
async function actingAs(key: OrgKey) {
  sessionMock?.restore();
  sessionMock = await mockSession(operator);
  setNextHeaders({ cookies: { [orgCookieName()]: String(orgIds[key]) } });
}

/** A customer's browser or a gateway: no session, no organization. */
function anonymous() {
  sessionMock?.restore();
  sessionMock = null;
  setNextHeaders({});
}

/** Minimal PayPal API: OAuth, order creation, webhook verification (always
 *  SUCCESS) and capture — recording every call. Never the network. */
function stubPayPal() {
  paypalCalls = [];
  _setPayPalFetchForTesting((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/v1/oauth2/token")) {
      return json({ access_token: "tok", expires_in: 3600 });
    }
    const raw = init?.body ? String(init.body) : "";
    paypalCalls.push({ url, body: raw.startsWith("{") ? JSON.parse(raw) : raw });
    if (url.includes("/v1/notifications/verify-webhook-signature")) {
      return json({ verification_status: "SUCCESS" });
    }
    if (url.endsWith("/capture")) {
      return json({ id: url.split("/").at(-2), status: "COMPLETED" });
    }
    paypalOrderSeq += 1;
    const id = `PP-TRIPRES-${paypalOrderSeq}`;
    return json({
      id,
      status: "PAYER_ACTION_REQUIRED",
      links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }],
    });
  }) as unknown as typeof fetch);
}

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

async function ok<T>(res: Response, status = 200): Promise<T> {
  const { status: got, body } = await jsonBody<{ ok: boolean; data: T }>(res);
  expect(got, JSON.stringify(body)).toBe(status);
  return body.data;
}

interface ApiError {
  ok: false;
  error: { code: string; message: string };
}

/** Admin → Settings in `key`'s organization: save its own terms and policy
 *  for one service (PATCH /api/admin/settings/legal). */
async function saveLegal(key: OrgKey, serviceType: ServiceType, terms: string, policy: string) {
  await actingAs(key);
  return jsonBody<{ ok: boolean; data: Record<string, unknown> } & Partial<ApiError>>(
    await legalPatchRoute(
      buildRequest("/api/admin/settings/legal", {
        method: "PATCH",
        body: { serviceType, termsAndConditions: terms, cancellationPolicy: policy },
      }),
    ),
  );
}

/** GET /api/admin/settings/legal?serviceType=… — the editor's read. */
async function readLegal(key: OrgKey, serviceType: ServiceType) {
  await actingAs(key);
  return jsonBody<{ ok: boolean; data: Record<string, unknown> } & Partial<ApiError>>(
    await legalGetRoute(
      buildRequest("/api/admin/settings/legal", { searchParams: { serviceType } }),
    ),
  );
}

async function saveTripReservationsFlightTerms() {
  const saved = await saveLegal("trip", ServiceType.FLIGHT, TRIP_FLIGHT_TERMS_TEXT, TRIP_FLIGHT_POLICY_TEXT);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  return saved.body.data;
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings({
    termsAndConditions: DEPLOYMENT_CAR_TERMS_TEXT,
    cancellationPolicy: DEPLOYMENT_CAR_POLICY_TEXT,
  });
  await Branding.findOneAndUpdate(
    { key: "default" },
    {
      $set: {
        key: "default",
        brandName: RC.brandName,
        supportEmail: RC.supportEmail,
        supportPhone: RC.supportPhone,
        primaryColor: "#0B1220",
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  Object.assign(process.env, ORG_ENV);
  sentMail.length = 0;
  stubPayPal();
  orgIds.rc = await makeRentalConfirmation();
  orgIds.trip = await makeTripReservations();
  orgIds.gv = await makeGlobeVista();
  await actingAs("trip");
  // Global suppliers: a car supplier, an airline, a hotel supplier.
  const suppliers = [
    { key: "BUDGET", name: CAR_SUPPLIER, serviceType: ServiceType.CAR_RENTAL, logo: "/providers/budget.png", primaryColor: "#E8590C", tagline: "Value-focused rentals" },
    { key: AIRLINE_KEY, name: AIRLINE, serviceType: ServiceType.FLIGHT, logo: "/providers/air-india.png", primaryColor: "#C8102E", tagline: "" },
    { key: HOTEL_SUPPLIER_KEY, name: "Harbour Stays", serviceType: ServiceType.HOTEL, logo: "/providers/preview.png", primaryColor: "#0B3D91", tagline: "" },
  ];
  for (const s of suppliers) {
    await createProvider(
      {
        key: s.key,
        name: s.name,
        logo: s.logo,
        primaryColor: s.primaryColor,
        onPrimaryColor: "#FFFFFF",
        tagline: s.tagline,
        sortOrder: 0,
        serviceTypes: [s.serviceType],
      } as Parameters<typeof createProvider>[0],
      { actor: operator },
    );
  }
  // FlightBizz's own flight terms, saved the way its admin saves them.
  const fb = await saveLegal("gv", ServiceType.FLIGHT, FLIGHTBIZZ_FLIGHT_TERMS_TEXT, FLIGHTBIZZ_FLIGHT_POLICY_TEXT);
  expect(fb.status, JSON.stringify(fb.body)).toBe(200);
  anonymous();
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  _setPayPalFetchForTesting(null);
  for (const k of Object.keys(ORG_ENV)) delete process.env[k];
  setNextHeaders({});
});

/* ------------------------------------------------------------------ *
 * The real enabling mechanism: scripts/set-organization-services.ts
 * ------------------------------------------------------------------ */

const SCRIPT = "scripts/set-organization-services.ts";

interface ScriptRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  ms: number;
}

/**
 * Run the script exactly as an operator does (`npx tsx`), with this test
 * process's environment — except that MONGODB_URI / MONGODB_DB name THIS
 * file's database on the in-memory server (asserted before anything runs),
 * the runner's own plumbing (VITEST_*, NODE_OPTIONS) is left out, and the
 * knobs are ORG_SLUG=tripreservations, SERVICES=FLIGHT and APPLY as given.
 * No --env-file: nothing outside this environment is read. `--no-install`
 * makes npx use the local tsx and never the network.
 */
async function runSetOrganizationServices(knobs: { APPLY?: "1" } = {}): Promise<ScriptRun> {
  const uri = process.env.PAYOPS_IT_MONGO_URI ?? "";
  const dbName = mongoose.connection.db?.databaseName ?? "";
  // The guard: only ever this file's database on the in-memory mongod.
  expect(uri, "MONGODB_URI must be the in-memory server").toMatch(
    /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/?$/,
  );
  expect(dbName, "MONGODB_DB must be this file's own database").toMatch(/^it-[0-9a-f]{8}$/);
  expect(dbName).toBe(process.env.MONGODB_DB);

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    // The runner's own plumbing stays with the runner; the script's knobs
    // are set below and nowhere else.
    if (k.startsWith("VITEST") || k === "NODE_OPTIONS") delete env[k];
  }
  for (const k of ["APPLY", "REMOVE", "ALLOW_REMOVE", "SERVICES", "ORG_SLUG"]) delete env[k];
  Object.assign(env, {
    MONGODB_URI: uri,
    MONGODB_DB: dbName,
    ORG_SLUG: TRIP.slug,
    SERVICES: "FLIGHT",
    ...knobs,
  });

  const started = Date.now();
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["--no-install", "tsx", SCRIPT],
      { cwd: process.cwd(), env, timeout: 40_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          ms: Date.now() - started,
        });
      },
    );
  });
}

/** The script's report rows ("  • before         [CAR_RENTAL]"), by label. */
function reportOf(stdout: string): Record<string, string> {
  const rows: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*•\s+(organization|stored|before|after|enabling|disabling)\s+(.*)$/.exec(line);
    if (m) rows[m[1]!] = m[2]!.trim();
  }
  return rows;
}

/** An organization exactly as stored — raw driver, no Mongoose defaults —
 *  as plain JSON (ids and dates as strings) so it compares by value. */
async function rawOrg(key: OrgKey): Promise<Record<string, unknown>> {
  const doc = await Organization.collection.findOne({ slug: SLUG[key] });
  expect(doc, `organization ${SLUG[key]} is missing`).toBeTruthy();
  return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
}

const ENABLED: ServiceType[] = [ServiceType.CAR_RENTAL, ServiceType.FLIGHT];

/** Enable Flight for TripReservations with the real script (APPLY=1). */
async function enableFlightForTripReservations(): Promise<ScriptRun> {
  const run = await runSetOrganizationServices({ APPLY: "1" });
  expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect((await rawOrg("trip")).serviceTypes).toEqual(ENABLED);
  return run;
}

/* ------------------------------------------------------------------ *
 * Reading what the operator and the customer read
 * ------------------------------------------------------------------ */

/** The text a reader sees in rendered HTML: no head, no tags, entities and
 *  React's text-node separators resolved, whitespace collapsed. */
function visibleText(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[\u00AD\u034F\u200B-\u200F\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** An email's plain-text part, whitespace collapsed. */
function plainText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Raw content with every percent-encoded run decoded (mailto / tel links). */
function decoded(content: string): string {
  return content.replace(/&amp;/g, "&").replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** Everything a surface can say: raw, visible and decoded. */
function everything(content: string): string {
  return [content, visibleText(content), decoded(content)].join("\n");
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The money block of a rendered page or email: from its title to the end
 *  of the Airline Charge explainer that closes it. */
function moneyBlock(html: string, title = "Price breakdown"): string {
  const text = visibleText(html);
  const from = text.indexOf(title);
  expect(from, `no "${title}" block`).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(EXPLAINER, from);
  expect(to, `"${title}" does not end with the Airline Charge explainer`).toBeGreaterThan(from);
  return text.slice(from, to + EXPLAINER.length);
}

/** An EMAIL's flight rows: label then amount, the airline row's note under it. */
function emailMoney(chargeName: string, settledLabel: string): string {
  return [
    "Airline Charge", "$400.00", "Not collected through this payment link",
    chargeName, "$100.00",
    "Total Booking Value", "$500.00",
    settledLabel, "$100.00",
    EXPLAINER,
  ].join(" ");
}

/** A PAGE's flight rows: the airline row's note sits inside its label. */
function pageMoney(chargeName: string, settledLabel: string): string {
  return [
    "Airline Charge", "Not collected through this payment link", "$400.00",
    chargeName, "$100.00",
    "Total Booking Value", "$500.00",
    settledLabel, "$100.00",
    EXPLAINER,
  ].join(" ");
}

/** Every value under a key that names money, anywhere in a gateway request. */
function amountsIn(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) =>
    /amount/i.test(key) ? [v] : amountsIn(v),
  );
}

/** Own text ONLY: each surface shows every `own` marker, and — read raw,
 *  visible and decoded — none of `foreign`. */
function expectOnlyText(surfaces: Record<string, string>, own: string[], foreign: string[]) {
  for (const [where, content] of Object.entries(surfaces)) {
    for (const marker of own) {
      expect(content, `${where} must show "${marker}"`).toContain(marker);
    }
    const all = everything(content);
    for (const marker of foreign) {
      expect(all, `${where} must NOT show "${marker}"`).not.toContain(marker);
    }
  }
}

/** None of `markers` on any surface (case-insensitive, raw/visible/decoded). */
function expectAbsent(surfaces: Record<string, string>, markers: string[], what: string) {
  for (const [where, content] of Object.entries(surfaces)) {
    const all = everything(content).toLowerCase();
    for (const marker of markers) {
      expect(all, `${where} carries ${what} "${marker}"`).not.toContain(marker.toLowerCase());
    }
  }
}

/** Words of another service never reach this one's customer. */
function expectNoWords(words: string[], surfaces: Record<string, string>) {
  for (const [where, content] of Object.entries(surfaces)) {
    const read = [visibleText(content), plainText(decoded(content))].join("\n").toLowerCase();
    for (const word of words) {
      expect(read, `${where} says "${word}"`).not.toContain(word.toLowerCase());
    }
  }
}

/** Every flight text in the deployment other than TripReservations' own
 *  override — plus every car and hotel text. */
const NOT_TRIP_FLIGHT = [
  FLIGHTBIZZ_FLIGHT_TERMS,
  FLIGHTBIZZ_FLIGHT_POLICY,
  DEPLOYMENT_CAR_TERMS,
  DEPLOYMENT_CAR_POLICY,
  ...BUILT_IN_FLIGHT,
  ...BUILT_IN_HOTEL,
  ...BUILT_IN_CAR,
];

/** Every text in the deployment other than the built-in flight text — what
 *  a TripReservations flight nobody configured may never show: no override
 *  (TripReservations' own is saved only where a test says so), nothing of
 *  FlightBizz's, no car or hotel text. */
const NOT_BUILT_IN_FLIGHT = [
  TRIP_FLIGHT_TERMS,
  TRIP_FLIGHT_POLICY,
  FLIGHTBIZZ_FLIGHT_TERMS,
  FLIGHTBIZZ_FLIGHT_POLICY,
  DEPLOYMENT_CAR_TERMS,
  DEPLOYMENT_CAR_POLICY,
  ...BUILT_IN_HOTEL,
  ...BUILT_IN_CAR,
];

/** The built-in flight terms and policy, whole. */
const BUILT_IN_FLIGHT_TEXTS = [DEFAULT_FLIGHT_TERMS_AND_CONDITIONS, DEFAULT_FLIGHT_CANCELLATION_POLICY];

/** A legal text's paragraphs, one per line — as every email and page
 *  prints them. */
function paragraphsOf(text: string): string[] {
  return text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Each surface prints EVERY paragraph of each text, whole — read as the
 *  customer reads it (an HTML part with its entities resolved, a plain-text
 *  part as it is). Stronger than a marker: nothing of the text is missing. */
function expectWholeText(surfaces: Record<string, string>, texts: string[]) {
  for (const [where, content] of Object.entries(surfaces)) {
    const read = `${visibleText(content)}\n${plainText(content)}`;
    for (const paragraph of texts.flatMap(paragraphsOf)) {
      expect(read, `${where} must print "${paragraph}"`).toContain(paragraph);
    }
  }
}

/** What a reading says OUTSIDE the given legal texts: every one of their
 *  paragraphs cut out (the built-in flight terms themselves say "PNR"). */
function outsideLegal(read: string, texts: string[]): string {
  return texts
    .flatMap(paragraphsOf)
    .reduce((out, paragraph) => out.split(paragraph).join(" "), read);
}

/** Every text other than the deployment car text. */
const NOT_DEPLOYMENT_CAR = [
  TRIP_FLIGHT_TERMS,
  TRIP_FLIGHT_POLICY,
  FLIGHTBIZZ_FLIGHT_TERMS,
  FLIGHTBIZZ_FLIGHT_POLICY,
  ...BUILT_IN_FLIGHT,
  ...BUILT_IN_HOTEL,
  ...BUILT_IN_CAR,
];

/* ------------------------------------------------------------------ *
 * What the operator, the customer and the gateways do — real routes
 * ------------------------------------------------------------------ */

interface SentEmail {
  subject: string;
  html: string;
  text: string;
  from: string;
  replyTo: string;
  transport: string;
}

function sentSince(mark: number, kind: EmailKind): SentEmail[] {
  return sentMail
    .slice(mark)
    .filter((m) => (m.headers as Record<string, string>)["X-Entity-Kind"] === kind)
    .map((m) => ({
      subject: String(m.subject),
      html: String(m.html),
      text: String(m.text),
      from: String(m.from ?? ""),
      replyTo: String(m.replyTo ?? ""),
      transport: String(m.__transport ?? ""),
    }));
}

function onlySentSince(mark: number, kind: EmailKind): SentEmail {
  const found = sentSince(mark, kind);
  expect(found, `expected exactly one ${kind} email`).toHaveLength(1);
  return found[0]!;
}

interface CreateConfig {
  serviceTypes: ServiceType[];
  providers: { key: string }[];
}

/** GET /api/orders/create-config — what the create form binds against. */
async function createConfig(key: OrgKey): Promise<CreateConfig> {
  await actingAs(key);
  return ok<CreateConfig>(await createConfigRoute());
}

/** create-config says nothing about terms: no `legalStatus` key (the
 *  additive field is gone), and no default/own flag under any other name.
 *  Terms need no admin, so there is nothing for the form to warn about. */
function expectNoLegalStatus(config: CreateConfig) {
  expect(config).not.toHaveProperty("legalStatus");
  const json = JSON.stringify(config);
  for (const flag of ["termsIsDefault", "policyIsDefault", "legalStatus"]) {
    expect(json, `create-config carries "${flag}"`).not.toContain(flag);
  }
}

/** The create-order page itself, as `key`'s operator opens it. */
async function createPage(key: OrgKey): Promise<string> {
  await actingAs(key);
  const page = (await CreateOrderPage()) as ReactElement;
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: new QueryClient() }, page),
  );
}

/** The create page's tab strip: each tab's label, and which one is open. */
function tabsOf(html: string): { label: string; selected: boolean }[] {
  return [...html.matchAll(/<button\b([^>]*\brole="tab"[^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
    label: visibleText(m[2]!),
    selected: /aria-selected="true"/.test(m[1]!),
  }));
}

/** One service's tab panel on the create page: whether it is the open one,
 *  and its markup (up to the next panel). */
function panelOf(html: string, serviceType: ServiceType): { active: boolean; html: string } {
  const starts = [...html.matchAll(/<div\b[^>]*\brole="tabpanel"[^>]*>/g)].map((m) => ({
    at: m.index!,
    tag: m[0],
  }));
  const i = starts.findIndex((s) => s.tag.includes(`-content-${serviceType}"`));
  expect(i, `no ${serviceType} panel on the create page`).toBeGreaterThanOrEqual(0);
  return {
    active: /data-state="active"/.test(starts[i]!.tag),
    html: html.slice(starts[i]!.at, starts[i + 1]?.at ?? html.length),
  };
}

/** The removed create-page terms notice, piece by piece: its title ("Built-in
 *  flight terms … in use"), its body ("This brand has no flight terms … of
 *  its own yet. New flight orders will freeze …") and its pointer ("Add the
 *  brand's own in Admin → Settings" / "Ask an admin …"). */
const REMOVED_NOTICE_WORDING = [
  "built-in",
  "of its own yet",
  "will freeze",
  "admin → settings",
  "ask an admin",
];

/** No terms notice of any kind: none of its wording, no alert, no link to
 *  the settings page it pointed at. */
function expectNoTermsNotice(surfaces: Record<string, string>) {
  for (const [where, html] of Object.entries(surfaces)) {
    const read = visibleText(html).toLowerCase();
    for (const phrase of REMOVED_NOTICE_WORDING) {
      expect(read, `${where} says "${phrase}"`).not.toContain(phrase);
    }
    expect(html, `${where} renders an alert`).not.toContain('role="alert"');
    expect(html, `${where} links to Admin → Settings`).not.toContain('href="/app/admin/settings"');
  }
}

/** Admin → Settings as `key`'s admin opens it: a terms editor per service
 *  the brand sells — optional customisation, nothing required. */
async function settingsPage(key: OrgKey): Promise<string> {
  await actingAs(key);
  return renderToStaticMarkup(await AdminSettingsPage());
}

const EDITOR_LABEL = {
  [ServiceType.CAR_RENTAL]: "Car rental",
  [ServiceType.FLIGHT]: "Flight",
  [ServiceType.HOTEL]: "Hotel",
} as const;

/** One service's terms editor on the settings page, as read — from its
 *  title to the next editor (or the end of the page); null when absent. */
function editorOf(html: string, serviceType: ServiceType, brand: string): string | null {
  const text = visibleText(html);
  const from = text.indexOf(`${EDITOR_LABEL[serviceType]} terms & cancellation policy — ${brand}`);
  if (from < 0) return null;
  const nextStarts = Object.values(EDITOR_LABEL)
    .map((label) => text.indexOf(`${label} terms & cancellation policy — `, from + 1))
    .filter((at) => at > from);
  return text.slice(from, nextStarts.length > 0 ? Math.min(...nextStarts) : text.length);
}

/** What an editor says under a text the brand never customised. */
function readyToUse(serviceType: ServiceType, brand: string): string {
  const [noun, defaultName] =
    serviceType === ServiceType.CAR_RENTAL
      ? ["car rental", "the deployment default shown here"]
      : [serviceType === ServiceType.FLIGHT ? "flight" : "hotel", "this built-in default"];
  return `New ${noun} orders for ${brand} use ${defaultName} — ready to use, nothing to set up. Optional: edit it and save to give ${brand} its own wording; no other brand changes.`;
}

/** Warnings logged about terms — there must be none: an order on its
 *  service's pre-written terms is the normal path, not a gap. */
function legalWarnings(warn: { mock: { calls: unknown[][] } }): unknown[][] {
  return warn.mock.calls.filter(([message]) => /^legal\./.test(String(message)));
}

/** POST /api/orders — the raw reply, for a refusal. */
async function postOrder(key: OrgKey, body: unknown) {
  await actingAs(key);
  return jsonBody<{ ok: boolean; data: { order: OrderDTO } } & Partial<ApiError>>(
    await createOrderRoute(buildRequest("/api/orders", { method: "POST", body })),
  );
}

/** POST /api/orders — the create form's submit, expected to succeed. */
async function submitOrder(key: OrgKey, body: unknown): Promise<OrderDTO> {
  await actingAs(key);
  const { order } = await ok<{ order: OrderDTO }>(
    await createOrderRoute(buildRequest("/api/orders", { method: "POST", body })),
    201,
  );
  return order;
}

/** What a refused order must not have written. */
async function writtenCounts() {
  return {
    orders: await Order.countDocuments({}),
    orderCreatedAudits: await AuditLog.countDocuments({ action: AuditAction.ORDER_CREATED }),
    evidence: await OrderEvidence.countDocuments({}),
  };
}

interface PayPalOrderBody {
  purchase_units: {
    custom_id: string;
    description: string;
    amount: { currency_code: string; value: string };
  }[];
  payment_source: { paypal: { experience_context: { brand_name: string } } };
}

/** POST /api/orders/[id]/generate-payment-link — exactly as the composer
 *  posts it for a brand with one gateway (no gateway named). Returns every
 *  gateway request it made. */
async function generateLink(key: OrgKey, orderId: string) {
  await actingAs(key);
  const stripeBefore = getCurrentTestStripe().sessionsCreated.length;
  const paypalBefore = paypalCalls.length;
  const { order } = await ok<{ order: OrderDTO }>(
    await generateLinkRoute(
      buildRequest(`/api/orders/${orderId}/generate-payment-link`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
  return {
    order,
    stripe: getCurrentTestStripe()
      .sessionsCreated.slice(stripeBefore)
      .map((s) => s.params),
    paypal: paypalCalls
      .slice(paypalBefore)
      .filter((c) => c.url.endsWith("/v2/checkout/orders"))
      .map((c) => c.body as PayPalOrderBody),
  };
}

/** POST /api/orders/[id]/payment-request-preview — the composer's preview. */
async function composerPreview(key: OrgKey, orderId: string): Promise<string> {
  await actingAs(key);
  const { html } = await ok<{ html: string }>(
    await previewRoute(
      buildRequest(`/api/orders/${orderId}/payment-request-preview`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
  return html;
}

/** POST /api/orders/[id]/send-payment-request — the email actually sent. */
async function sendRequest(key: OrgKey, orderId: string) {
  await actingAs(key);
  const mark = sentMail.length;
  const data = await ok<{ order: OrderDTO; sent: { consentToken: string | null } }>(
    await sendRequestRoute(
      buildRequest(`/api/orders/${orderId}/send-payment-request`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
  expect(data.sent.consentToken, "the send recorded no consent request").toBeTruthy();
  return {
    order: data.order,
    consentToken: data.sent.consentToken!,
    email: onlySentSince(mark, EmailKind.PAYMENT_LINK),
  };
}

/** GET /api/orders/[id] — what the operator's order page loads. */
async function orderApi(key: OrgKey, orderId: string): Promise<OrderDTO> {
  await actingAs(key);
  return ok<OrderDTO>(await getOrderRoute(buildRequest(`/api/orders/${orderId}`), idParams(orderId)));
}

/** POST /api/orders/[id]/confirmation-number — the order card's Save (the
 *  "edit" path for a flight's PNR). */
async function saveReference(key: OrgKey, orderId: string, reference: string): Promise<OrderDTO> {
  await actingAs(key);
  return ok<OrderDTO>(
    await confirmationNumberRoute(
      buildRequest(`/api/orders/${orderId}/confirmation-number`, {
        method: "POST",
        body: { confirmationNumber: reference },
      }),
      idParams(orderId),
    ),
  );
}

/** POST /api/orders/[id]/resend-confirmation — the card's resend button. */
async function resendConfirmation(key: OrgKey, orderId: string) {
  await actingAs(key);
  const mark = sentMail.length;
  const data = await ok<{ order: OrderDTO; emailId: string | null }>(
    await resendConfirmationRoute(
      buildRequest(`/api/orders/${orderId}/resend-confirmation`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
  return { ...data, email: onlySentSince(mark, EmailKind.PAYMENT_CONFIRMATION) };
}

/** /consent/[token] — the hosted page the email's button opens. */
async function consentPage(token: string): Promise<string> {
  anonymous();
  return renderToStaticMarkup(await ConsentPage({ params: Promise.resolve({ token }) }));
}

/** The customer signs and confirms (GET, then POST /api/consent/[token]). */
async function confirmConsent(token: string, signedName: string) {
  anonymous();
  const view = await ok<PublicConsentView>(
    await consentViewRoute(buildRequest(`/api/consent/${token}`), {
      params: Promise.resolve({ token }),
    }),
  );
  await ok<PublicConsentView>(
    await confirmConsentRoute(
      buildRequest(`/api/consent/${token}`, {
        method: "POST",
        body: { acknowledgement: view.consentMessage, signedName },
        headers: { "x-forwarded-for": uniqueIp() },
      }),
      { params: Promise.resolve({ token }) },
    ),
  );
  return view;
}

/** /acknowledge/[token] — the page the confirmation's "I Agree" opens: the
 *  one customer PAGE that prints the order's terms. */
async function acknowledgePage(confirmationHtml: string): Promise<string> {
  const token = /href="[^"]*\/acknowledge\/([^"?#/]+)"/.exec(confirmationHtml)?.[1];
  expect(token, "the confirmation has no I Agree link").toBeTruthy();
  anonymous();
  return renderToStaticMarkup(await AcknowledgePage({ params: Promise.resolve({ token: token! }) }));
}

/** /pay/success — where PayPal returns the customer (it appends `token`). */
async function receiptPage(order: OrderDTO): Promise<string> {
  anonymous();
  return renderToStaticMarkup(
    await PaymentSuccessPage({
      searchParams: Promise.resolve({
        order: order.orderNumber,
        token: order.payment.paymentSessionId!,
      }),
    }),
  );
}

/** A PayPal delivery as PayPal sends it: the five transmission headers. */
function paypalDelivery(event: Record<string, unknown>) {
  return new Request(`http://localhost/api/webhooks/paypal/${TRIP.slug}`, {
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      "paypal-transmission-id": `tx-${String(event.id)}`,
      "paypal-transmission-time": new Date().toISOString(),
      "paypal-cert-url": "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT",
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-transmission-sig": "sig",
    }),
    body: JSON.stringify(event),
  }) as never;
}

type WebhookReply = { status: number; body: { ok: boolean; data: Record<string, unknown> } };

/** TripReservations' PayPal endpoint: CHECKOUT.ORDER.APPROVED (the route
 *  captures — approval is not payment), then PAYMENT.CAPTURE.COMPLETED, then
 *  the outbox run that sends the confirmation. */
async function payWithPayPal(order: OrderDTO) {
  const sessionId = order.payment.paymentSessionId!;
  const slugParams = { params: Promise.resolve({ orgSlug: TRIP.slug }) };
  anonymous();
  const callsBefore = paypalCalls.length;
  const approved: WebhookReply = await jsonBody(
    await paypalWebhookRoute(
      paypalDelivery({
        id: `WH-APPROVED-${order.id}`,
        event_type: "CHECKOUT.ORDER.APPROVED",
        create_time: new Date().toISOString(),
        resource: { id: sessionId, status: "APPROVED", purchase_units: [{ custom_id: order.id }] },
      }),
      slugParams,
    ),
  );
  const capturesAsked = paypalCalls
    .slice(callsBefore)
    .filter((c) => c.url.endsWith(`/v2/checkout/orders/${sessionId}/capture`)).length;
  const afterApproval = await Order.findById(order.id).lean<{ status: string } | null>();
  const drainedAfterApproval = await drainPendingEmails(10);
  const completed: WebhookReply = await jsonBody(
    await paypalWebhookRoute(
      paypalDelivery({
        id: `WH-COMPLETED-${order.id}`,
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        create_time: new Date().toISOString(),
        resource: {
          id: `CAP-${order.orderNumber}`,
          status: "COMPLETED",
          custom_id: order.id,
          amount: { currency_code: "USD", value: order.pricing.amount.toFixed(2) },
          supplementary_data: { related_ids: { order_id: sessionId } },
        },
      }),
      slugParams,
    ),
  );
  const mark = sentMail.length;
  const drained = await drainPendingEmails(10);
  return {
    approved,
    capturesAsked,
    statusAfterApproval: afterApproval?.status ?? null,
    drainedAfterApproval,
    completed,
    drained,
    confirmation: onlySentSince(mark, EmailKind.PAYMENT_CONFIRMATION),
  };
}

async function storedOrder(orderId: string) {
  const doc = await Order.findById(orderId).lean<{
    organizationId: Types.ObjectId;
    serviceType: string;
    charges: { name: string; amount: number; timing: string }[];
    pricing: { amount: number; currency: string };
    confirmationNumber?: string | null;
    flight?: { airlineFare: number | null; pnr?: string | null } | null;
    terms: { text: string; version: string };
    policy: { text: string; version: string };
  } | null>();
  expect(doc, `order ${orderId} was not stored`).toBeTruthy();
  return doc!;
}

/* ------------------------------------------------------------------ *
 * The orders the forms submit
 * ------------------------------------------------------------------ */

/** The flight form: the airline charge ($400) in its own field, and ONE
 *  charge — named by the operator — that the link collects ($100). No PNR
 *  yet: it is set later, through the order card. */
function flightBody(chargeName = FLIGHT_CHARGE) {
  return roundTripFlightInput(
    {
      provider: AIRLINE_KEY,
      charges: [{ name: chargeName, amount: 100, timing: PaymentTiming.PREPAID }],
    },
    { airlineFare: 400, pnr: null },
  );
}

/** The car form, unchanged: a prepaid rental line and a deposit due at the
 *  counter. Posts no `serviceType`, exactly as the car form does. */
function carBody() {
  return validCreateOrderInput({
    charges: [
      { name: "Rental cost", amount: 249.99, timing: PaymentTiming.PREPAID },
      { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
    ],
  });
}

function hotelBody() {
  return validHotelOrderInput({ provider: HOTEL_SUPPLIER_KEY });
}

const NOT_SOLD = {
  tripFlights: "Trip Reservations does not sell flights, so this order cannot be created for it.",
  tripHotels: "Trip Reservations does not sell hotel stays, so this order cannot be created for it.",
  rcFlights: "Rental Confirmation does not sell flights, so this order cannot be created for it.",
  tripFlightTerms: "Trip Reservations does not sell flights, so it has no flight terms to set.",
  tripHotelTerms: "Trip Reservations does not sell hotel stays, so it has no hotel terms to set.",
};

/* ================================================================== *
 * 0. THE WORLD
 * ================================================================== */

describe("0. WORLD — the deployment this file runs on is production's shape", () => {
  it("0a. rentalconfirmation (default, Stripe) and tripreservations (PayPal, no capture mode) store no service list and no legal; globevista (FlightBizz, Stripe, MANUAL) sells [FLIGHT, HOTEL, CAR_RENTAL] with its own flight terms; the deployment car terms are distinct; the three suppliers are global", async () => {
    const rc = await rawOrg("rc");
    expect(rc).toMatchObject({
      slug: RC.slug,
      brandName: RC.brandName,
      isDefault: true,
      payments: { provider: PaymentGatewayKey.STRIPE, enabledProviders: [PaymentGatewayKey.STRIPE] },
    });
    expect(rc).not.toHaveProperty("serviceTypes");
    expect(rc).not.toHaveProperty("legal");

    const trip = await rawOrg("trip");
    expect(trip).toMatchObject({
      slug: TRIP.slug,
      brandName: TRIP.brandName,
      isDefault: false,
      payments: { provider: PaymentGatewayKey.PAYPAL, enabledProviders: [PaymentGatewayKey.PAYPAL] },
      support: { email: TRIP.supportEmail, phone: "" },
    });
    expect(trip).not.toHaveProperty("serviceTypes");
    expect(trip).not.toHaveProperty("legal");
    expect(trip.payments).not.toHaveProperty("captureMode");

    const gv = await rawOrg("gv");
    expect(gv).toMatchObject({
      slug: GV.slug,
      name: GV.name,
      brandName: GV.brandName,
      isDefault: false,
      payments: { provider: PaymentGatewayKey.STRIPE, captureMode: CaptureMode.MANUAL },
      serviceTypes: [ServiceType.FLIGHT, ServiceType.HOTEL, ServiceType.CAR_RENTAL],
      legal: {
        services: {
          FLIGHT: {
            termsAndConditions: FLIGHTBIZZ_FLIGHT_TERMS_TEXT,
            cancellationPolicy: FLIGHTBIZZ_FLIGHT_POLICY_TEXT,
          },
        },
      },
    });

    const settings = await Setting.findOne({ key: SETTINGS_KEY }).lean<{
      termsAndConditions: string;
      cancellationPolicy: string;
    } | null>();
    expect(settings?.termsAndConditions).toBe(DEPLOYMENT_CAR_TERMS_TEXT);
    expect(settings?.cancellationPolicy).toBe(DEPLOYMENT_CAR_POLICY_TEXT);

    const suppliers = await Provider.find({ key: { $in: ["BUDGET", AIRLINE_KEY, HOTEL_SUPPLIER_KEY] } })
      .sort({ key: 1 })
      .lean<{ key: string; serviceTypes: string[]; organizationIds?: unknown[] }[]>();
    expect(suppliers.map((s) => [s.key, s.serviceTypes, s.organizationIds ?? []])).toEqual([
      [AIRLINE_KEY, [ServiceType.FLIGHT], []],
      ["BUDGET", [ServiceType.CAR_RENTAL], []],
      [HOTEL_SUPPLIER_KEY, [ServiceType.HOTEL], []],
    ]);
  });

  it("0b. the text markers are real: each built-in marker is in its own exported default (flight terms / flight policy / hotel / car) and in no other, survives HTML escaping, and no brand or deployment marker is in any built-in text", () => {
    const builtIn = {
      "flight terms": DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
      "flight policy": DEFAULT_FLIGHT_CANCELLATION_POLICY,
      hotel: `${DEFAULT_HOTEL_TERMS_AND_CONDITIONS}\n${DEFAULT_HOTEL_CANCELLATION_POLICY}`,
      car: `${DEFAULT_TERMS_AND_CONDITIONS}\n${DEFAULT_CANCELLATION_POLICY}`,
    };
    const homes: [string[], keyof typeof builtIn][] = [
      [BUILT_IN_FLIGHT_TERMS, "flight terms"],
      [BUILT_IN_FLIGHT_POLICY, "flight policy"],
      [BUILT_IN_HOTEL, "hotel"],
      [BUILT_IN_CAR, "car"],
    ];
    for (const [markers, home] of homes) {
      for (const marker of markers) {
        expect(builtIn[home], `"${marker}" is not in the built-in ${home} text`).toContain(marker);
        expect(marker, "a marker must read the same raw and HTML-escaped").not.toMatch(/['"&<>]/);
        for (const [other, text] of Object.entries(builtIn)) {
          if (other !== home) expect(text, `"${marker}" is also in the built-in ${other} text`).not.toContain(marker);
        }
      }
    }
    for (const marker of [
      DEPLOYMENT_CAR_TERMS,
      DEPLOYMENT_CAR_POLICY,
      TRIP_FLIGHT_TERMS,
      TRIP_FLIGHT_POLICY,
      FLIGHTBIZZ_FLIGHT_TERMS,
      FLIGHTBIZZ_FLIGHT_POLICY,
    ]) {
      for (const [name, text] of Object.entries(builtIn)) {
        expect(text, `the built-in ${name} text contains "${marker}"`).not.toContain(marker);
      }
    }
  });
});

/* ================================================================== *
 * 1. CAPABILITY
 * ================================================================== */

describe("1. CAPABILITY — Flight is enabled for TripReservations through the organization service capability (scripts/set-organization-services.ts)", () => {
  it("1a. BEFORE: TripReservations stores no service list and resolves to exactly [CAR_RENTAL]; a FLIGHT order is refused (422) and stores nothing; create-config (no legalStatus) and the create page (no terms notice) offer only car; the Flight terms editor is refused", async () => {
    const stored = await rawOrg("trip");
    expect(stored).not.toHaveProperty("serviceTypes");
    expect(stored).not.toHaveProperty("legal");
    expect(stored.payments).not.toHaveProperty("captureMode");
    expect(await resolveOrganizationServiceTypes(String(orgIds.trip))).toEqual([ServiceType.CAR_RENTAL]);

    // The create form: car only — no tabs, no flight, no terms notice.
    const config = await createConfig("trip");
    expect(config.serviceTypes).toEqual([ServiceType.CAR_RENTAL]);
    expectNoLegalStatus(config);
    const page = await createPage("trip");
    expect(page).not.toContain('role="tablist"');
    expectNoTermsNotice({ "car-only create page": page });
    expect(visibleText(page)).not.toMatch(/\bflight\b/i);
    // The car form's supplier picker: the car supplier, never the airline.
    expect(visibleText(page)).toContain(CAR_SUPPLIER);
    expect(visibleText(page)).not.toContain(AIRLINE);

    // A crafted FLIGHT order: refused before anything is written.
    const before = await writtenCounts();
    const refused = await postOrder("trip", flightBody());
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error).toMatchObject({ code: "VALIDATION_ERROR", message: NOT_SOLD.tripFlights });
    expect(await writtenCounts()).toEqual(before);
    expect(before.orders).toBe(0);

    // There is no Flight terms editor for a brand that does not sell flights.
    const read = await readLegal("trip", ServiceType.FLIGHT);
    expect(read.status, JSON.stringify(read.body)).toBe(422);
    expect(read.body.error?.message).toBe(NOT_SOLD.tripFlightTerms);
    const save = await saveLegal("trip", ServiceType.FLIGHT, TRIP_FLIGHT_TERMS_TEXT, TRIP_FLIGHT_POLICY_TEXT);
    expect(save.status, JSON.stringify(save.body)).toBe(422);
    expect(save.body.error?.message).toBe(NOT_SOLD.tripFlightTerms);

    // Nothing above touched the organization.
    expect(await rawOrg("trip")).toEqual(stored);
  });

  it("1b. ENABLE with the real script: the dry run prints 'before [CAR_RENTAL] → after [CAR_RENTAL, FLIGHT]' and writes nothing (field still absent); APPLY=1 stores exactly ['CAR_RENTAL','FLIGHT'] and nothing else; a second run is 'nothing to change' with no write", async () => {
    const untouched = { rc: await rawOrg("rc"), trip: await rawOrg("trip"), gv: await rawOrg("gv") };

    // Dry run (no APPLY): the plan, and no write.
    const dry = await runSetOrganizationServices();
    expect(dry.exitCode, `${dry.stdout}\n${dry.stderr}`).toBe(0);
    expect(dry.stdout).toContain(
      `→ Setting the services of organization "${TRIP.slug}" (dry run — set APPLY=1 to write)`,
    );
    const plan = reportOf(dry.stdout);
    expect(plan.organization).toBe(`${TRIP.brandName} (${TRIP.slug}, ${String(orgIds.trip)}, ACTIVE)`);
    expect(plan.stored).toBe("(none stored — reads as [CAR_RENTAL])");
    expect(`before ${plan.before} → after ${plan.after}`).toBe(
      "before [CAR_RENTAL] → after [CAR_RENTAL, FLIGHT]",
    );
    expect(plan.enabling).toBe("[FLIGHT]");
    expect(plan.disabling).toBe("[]");
    expect(dry.stdout).toContain("• dry run: no writes made");
    expect(dry.stdout).not.toContain("✓ stored");
    const afterDryRun = await rawOrg("trip");
    expect(afterDryRun).toEqual(untouched.trip);
    expect(afterDryRun).not.toHaveProperty("serviceTypes");

    // APPLY=1: exactly the merged list, in tab order — car first.
    const applied = await runSetOrganizationServices({ APPLY: "1" });
    expect(applied.exitCode, `${applied.stdout}\n${applied.stderr}`).toBe(0);
    expect(applied.stdout).toContain(`→ Setting the services of organization "${TRIP.slug}"\n`);
    expect(reportOf(applied.stdout)).toMatchObject({
      stored: "(none stored — reads as [CAR_RENTAL])",
      before: "[CAR_RENTAL]",
      after: "[CAR_RENTAL, FLIGHT]",
      enabling: "[FLIGHT]",
      disabling: "[]",
    });
    expect(applied.stdout).toContain("✓ stored [CAR_RENTAL, FLIGHT]");
    expect(applied.stdout).toContain("✔ Organization services updated.");
    const enabled = await rawOrg("trip");
    expect(enabled.serviceTypes).toEqual(["CAR_RENTAL", "FLIGHT"]);
    // The script's rule, as exported: TODAY's services first, FLIGHT appended.
    expect(enabled.serviceTypes).toEqual(mergeServiceTypes(undefined, [ServiceType.FLIGHT]));
    // Narrow: `serviceTypes` (and the timestamp) is all it wrote.
    const withoutWrittenKeys = (doc: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(doc).filter(([k]) => k !== "serviceTypes" && k !== "updatedAt"),
      );
    const rest = withoutWrittenKeys(enabled) as typeof enabled;
    expect(rest).toEqual(withoutWrittenKeys(untouched.trip));
    expect(rest).not.toHaveProperty("legal");
    expect(rest.payments).not.toHaveProperty("captureMode");
    // No other organization was touched.
    expect(await rawOrg("rc")).toEqual(untouched.rc);
    expect(await rawOrg("gv")).toEqual(untouched.gv);

    // Run again: idempotent — nothing to change, nothing written.
    const again = await runSetOrganizationServices({ APPLY: "1" });
    expect(again.exitCode, `${again.stdout}\n${again.stderr}`).toBe(0);
    expect(reportOf(again.stdout)).toMatchObject({
      stored: "[CAR_RENTAL, FLIGHT]",
      before: "[CAR_RENTAL, FLIGHT]",
      after: "[CAR_RENTAL, FLIGHT]",
      enabling: "[]",
      disabling: "[]",
    });
    expect(again.stdout).toContain("• nothing to change: no writes made");
    expect(again.stdout).not.toContain("✓ stored");
    expect(again.stdout).not.toContain("✔ Organization services updated.");
    expect(await rawOrg("trip")).toEqual(enabled);
  }, 150_000);

  it("1c. AFTER: TripReservations resolves to [CAR_RENTAL, FLIGHT]; create-config (still no legalStatus) and the create page (no terms notice on either tab) list car then flight (car = the open tab); HOTEL stays disabled; rentalconfirmation still has no stored list, resolves to [CAR_RENTAL] and refuses flights; globevista is unchanged", async () => {
    await enableFlightForTripReservations();

    expect(await resolveOrganizationServiceTypes(String(orgIds.trip))).toEqual(ENABLED);
    const config = await createConfig("trip");
    expect(config.serviceTypes).toEqual(ENABLED);
    expectNoLegalStatus(config);
    expect(config.providers.map((p) => p.key)).toContain(AIRLINE_KEY);
    // The create page: one tab per service in stored order, car open.
    const page = await createPage("trip");
    expect(page).toContain('role="tablist"');
    expect(tabsOf(page)).toEqual([
      { label: "Car rental", selected: true },
      { label: "Flight", selected: false },
    ]);
    // The car panel is the one open; each panel picks from its own suppliers.
    const carPanel = panelOf(page, ServiceType.CAR_RENTAL);
    const flightPanel = panelOf(page, ServiceType.FLIGHT);
    expect(carPanel.active).toBe(true);
    expect(flightPanel.active).toBe(false);
    expect(visibleText(carPanel.html)).toContain(CAR_SUPPLIER);
    expect(visibleText(carPanel.html)).not.toContain(AIRLINE);
    expect(visibleText(flightPanel.html)).toContain(AIRLINE);
    expect(visibleText(flightPanel.html)).not.toContain(CAR_SUPPLIER);
    expect(page).not.toContain(`-content-${ServiceType.HOTEL}"`);
    // Nothing on either tab about terms: the flight form is ready to use.
    expectNoTermsNotice({
      "create page": page,
      "flight tab": flightPanel.html,
      "car tab": carPanel.html,
    });

    // HOTEL is still not sold: refused, nothing written, no editor.
    const before = await writtenCounts();
    const hotel = await postOrder("trip", hotelBody());
    expect(hotel.status, JSON.stringify(hotel.body)).toBe(422);
    expect(hotel.body.error).toMatchObject({ code: "VALIDATION_ERROR", message: NOT_SOLD.tripHotels });
    expect(await writtenCounts()).toEqual(before);
    const hotelTerms = await readLegal("trip", ServiceType.HOTEL);
    expect(hotelTerms.status).toBe(422);
    expect(hotelTerms.body.error?.message).toBe(NOT_SOLD.tripHotelTerms);
    expect(config.serviceTypes).not.toContain(ServiceType.HOTEL);

    // rentalconfirmation: still no stored list — still car rental only.
    expect(await rawOrg("rc")).not.toHaveProperty("serviceTypes");
    expect(await resolveOrganizationServiceTypes(String(orgIds.rc))).toEqual([ServiceType.CAR_RENTAL]);
    const rcFlight = await postOrder("rc", flightBody());
    expect(rcFlight.status, JSON.stringify(rcFlight.body)).toBe(422);
    expect(rcFlight.body.error?.message).toBe(NOT_SOLD.rcFlights);
    expect(await writtenCounts()).toEqual(before);

    // globevista: exactly what it sold before.
    expect((await rawOrg("gv")).serviceTypes).toEqual([
      ServiceType.FLIGHT,
      ServiceType.HOTEL,
      ServiceType.CAR_RENTAL,
    ]);
    expect(await resolveOrganizationServiceTypes(String(orgIds.gv))).toEqual([
      ServiceType.FLIGHT,
      ServiceType.HOTEL,
      ServiceType.CAR_RENTAL,
    ]);
  }, 60_000);
});

/* ================================================================== *
 * 2. T&C — ZERO ADMIN DEPENDENCY
 * ================================================================== */

/** What TripReservations' car orders freeze from the deployment: the Settings
 *  car text with the versions stored beside it (read, not assumed). */
async function deploymentCarText() {
  const settings = await Setting.findOne({ key: SETTINGS_KEY }).lean<{
    termsAndConditions: string;
    termsVersion: string;
    cancellationPolicy: string;
    cancellationPolicyVersion: string;
  } | null>();
  expect(settings, "the deployment has no Settings document").toBeTruthy();
  return settings!;
}

/** Audit rows of a legal save for `key`'s organization. */
async function legalSavesFor(key: OrgKey): Promise<number> {
  return AuditLog.countDocuments({
    action: AuditAction.ORGANIZATION_LEGAL_UPDATED,
    entityId: String(orgIds[key]),
  });
}

describe("2. T&C — zero admin dependency: an order's terms come from its organization + service type with nothing configured; an override is optional", () => {
  it("2a. NOTHING CONFIGURED: TripReservations (no `legal` at all) — its very first flight order freezes the built-in flight terms and policy at DEFAULT_FLIGHT_LEGAL_VERSION, with no warning logged; the payment request (composer preview and the email sent, HTML and text) carries them whole; its car order freezes the deployment car text; create-config has no legalStatus, the create page no notice; Admin → Settings offers the built-in text as ready to use; nothing was written", async () => {
    await enableFlightForTripReservations();
    // Nobody configured anything: the script wrote the service list only.
    expect(await rawOrg("trip")).not.toHaveProperty("legal");
    expect(await legalSavesFor("trip")).toBe(0);

    // The create form: no terms status to bind, no notice to show.
    const config = await createConfig("trip");
    expect(config.serviceTypes).toEqual(ENABLED);
    expectNoLegalStatus(config);
    const page = await createPage("trip");
    expectNoTermsNotice({
      "create page": page,
      "flight tab": panelOf(page, ServiceType.FLIGHT).html,
      "car tab": panelOf(page, ServiceType.CAR_RENTAL).html,
    });

    // The FIRST flight order — immediately on the built-in flight text.
    const warn = vi.spyOn(logger, "warn");
    const created = await submitOrder("trip", flightBody());
    const flight = await storedOrder(created.id);
    expect(flight.serviceType).toBe(ServiceType.FLIGHT);
    expect(String(flight.organizationId)).toBe(String(orgIds.trip));
    expect(flight.terms).toEqual({
      text: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });
    expect(flight.policy).toMatchObject({
      text: DEFAULT_FLIGHT_CANCELLATION_POLICY,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });
    // The operator's order page reads the same snapshot.
    const fetched = await orderApi("trip", created.id);
    expect(fetched.terms).toEqual({
      text: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });
    expect(fetched.policy).toMatchObject({
      text: DEFAULT_FLIGHT_CANCELLATION_POLICY,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });

    // …and so does what the customer is sent: the composer preview and the
    // payment request itself — every paragraph, both version labels, and
    // nothing of any other text.
    await generateLink("trip", created.id);
    const preview = await composerPreview("trip", created.id);
    const { email } = await sendRequest("trip", created.id);
    const sent = {
      "composer preview": preview,
      "payment request (html)": email.html,
      "payment request (text)": email.text,
    };
    expectWholeText(sent, BUILT_IN_FLIGHT_TEXTS);
    expectOnlyText(sent, BUILT_IN_FLIGHT, NOT_BUILT_IN_FLIGHT);
    for (const [where, content] of Object.entries(sent)) {
      const read = `${visibleText(content)}\n${plainText(content)}`;
      expect(read, where).toContain(`Terms version ${DEFAULT_FLIGHT_LEGAL_VERSION}`);
      expect(read, where).toContain(`Policy version ${DEFAULT_FLIGHT_LEGAL_VERSION}`);
    }

    // Its car order — nothing configured either — freezes the deployment's
    // pre-written car text with the deployment's versions.
    const car = await storedOrder((await submitOrder("trip", carBody())).id);
    const deployment = await deploymentCarText();
    expect(car.serviceType).toBe(ServiceType.CAR_RENTAL);
    expect(car.terms).toEqual({ text: DEPLOYMENT_CAR_TERMS_TEXT, version: deployment.termsVersion });
    expect(car.policy).toMatchObject({
      text: DEPLOYMENT_CAR_POLICY_TEXT,
      version: deployment.cancellationPolicyVersion,
    });
    expectOnlyText({ "car terms": car.terms.text, "car policy": car.policy.text }, [], NOT_DEPLOYMENT_CAR);

    // Neither order logged a terms warning: pre-written terms are the
    // normal path, not a gap.
    expect(legalWarnings(warn), "an order on pre-written terms logged a warning").toEqual([]);

    // Admin → Email previews for TripReservations' flights: the same text.
    const { html: adminPreview } = await renderEmailPreview({
      organizationId: String(orgIds.trip),
      serviceType: ServiceType.FLIGHT,
      templateKey: "payment-request",
    });
    expectWholeText({ "admin flight preview": adminPreview }, BUILT_IN_FLIGHT_TEXTS);
    expectOnlyText({ "admin flight preview": adminPreview }, BUILT_IN_FLIGHT, NOT_BUILT_IN_FLIGHT);

    // Admin → Settings — optional customisation only. Its Flight editor
    // reads exactly what the order froze, and calls it ready to use.
    const editor = await readLegal("trip", ServiceType.FLIGHT);
    expect(editor.status, JSON.stringify(editor.body)).toBe(200);
    expect(editor.body.data).toMatchObject({
      brandName: TRIP.brandName,
      sellsFlight: true,
      termsIsDefault: true,
      policyIsDefault: true,
      termsAndConditions: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
      termsVersion: DEFAULT_FLIGHT_LEGAL_VERSION,
      cancellationPolicy: DEFAULT_FLIGHT_CANCELLATION_POLICY,
      cancellationPolicyVersion: DEFAULT_FLIGHT_LEGAL_VERSION,
    });
    const settings = await settingsPage("trip");
    const flightEditor = editorOf(settings, ServiceType.FLIGHT, TRIP.brandName);
    const carEditor = editorOf(settings, ServiceType.CAR_RENTAL, TRIP.brandName);
    expect(flightEditor, "Admin → Settings has no Flight editor for Trip Reservations").not.toBeNull();
    expect(carEditor, "Admin → Settings has no Car rental editor for Trip Reservations").not.toBeNull();
    expect(editorOf(settings, ServiceType.HOTEL, TRIP.brandName)).toBeNull();
    // Under the terms and under the policy: "ready to use, nothing to set up".
    expect(occurrences(flightEditor!, readyToUse(ServiceType.FLIGHT, TRIP.brandName))).toBe(2);
    expect(occurrences(carEditor!, readyToUse(ServiceType.CAR_RENTAL, TRIP.brandName))).toBe(2);
    expect(flightEditor).toContain(`Version ${DEFAULT_FLIGHT_LEGAL_VERSION}`);
    expectWholeText({ "Flight editor": flightEditor! }, BUILT_IN_FLIGHT_TEXTS);
    expectWholeText({ "Car rental editor": carEditor! }, [DEPLOYMENT_CAR_TERMS_TEXT, DEPLOYMENT_CAR_POLICY_TEXT]);
    expect(visibleText(settings)).not.toContain("of its own yet");

    // Not one of these reads wrote anything for TripReservations.
    expect(await rawOrg("trip")).not.toHaveProperty("legal");
    expect(await legalSavesFor("trip")).toBe(0);
  }, 60_000);

  it("2b. OPTIONAL override: TripReservations saves its own flight terms (PATCH /api/admin/settings/legal; first own version = nextPolicyVersion(DEFAULT_FLIGHT_LEGAL_VERSION)) — only the NEXT flight order freezes exactly that text; the earlier order and its preview keep the built-in text and version; the car order still freezes the deployment car text; create-config and the create page are unchanged; FlightBizz's text untouched and nowhere to be seen", async () => {
    await enableFlightForTripReservations();
    const earlier = await submitOrder("trip", flightBody());
    const flightBizzBefore = await rawOrg("gv");

    const saved = await saveTripReservationsFlightTerms();
    const firstOwnVersion = nextPolicyVersion(DEFAULT_FLIGHT_LEGAL_VERSION);
    expect(saved).toMatchObject({
      organizationId: String(orgIds.trip),
      brandName: TRIP.brandName,
      sellsFlight: true,
      termsIsDefault: false,
      policyIsDefault: false,
      termsAndConditions: TRIP_FLIGHT_TERMS_TEXT,
      termsVersion: firstOwnVersion,
      cancellationPolicy: TRIP_FLIGHT_POLICY_TEXT,
      cancellationPolicyVersion: firstOwnVersion,
    });
    expect(await legalSavesFor("trip")).toBe(1);
    // Only the FLIGHT slot was written: no car or hotel text of its own.
    const org = await rawOrg("trip");
    expect(org.legal).toMatchObject({
      services: {
        FLIGHT: {
          termsAndConditions: TRIP_FLIGHT_TERMS_TEXT,
          termsVersion: firstOwnVersion,
          cancellationPolicy: TRIP_FLIGHT_POLICY_TEXT,
          cancellationPolicyVersion: firstOwnVersion,
        },
      },
    });
    const legal = org.legal as {
      termsAndConditions?: string;
      cancellationPolicy?: string;
      services?: Record<string, unknown>;
    };
    expect(legal.termsAndConditions ?? "").toBe("");
    expect(legal.cancellationPolicy ?? "").toBe("");
    expect(legal.services?.HOTEL ?? null).toBeNull();
    expect(org.serviceTypes).toEqual(ENABLED);
    // Another brand's save never touches FlightBizz.
    expect(await rawOrg("gv")).toEqual(flightBizzBefore);

    // The create form is exactly as before: there is no status to flip.
    const config = await createConfig("trip");
    expectNoLegalStatus(config);
    expectNoTermsNotice({ "create page": await createPage("trip") });

    // The NEXT flight order freezes exactly the override…
    const next = await submitOrder("trip", flightBody());
    const flight = await storedOrder(next.id);
    expect(flight.terms).toEqual({ text: TRIP_FLIGHT_TERMS_TEXT, version: firstOwnVersion });
    expect(flight.policy).toMatchObject({ text: TRIP_FLIGHT_POLICY_TEXT, version: firstOwnVersion });
    // …while the earlier one keeps the built-in text and version it froze —
    // in the order and in what its customer is sent.
    const kept = await storedOrder(earlier.id);
    expect(kept.terms).toEqual({
      text: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });
    expect(kept.policy).toMatchObject({
      text: DEFAULT_FLIGHT_CANCELLATION_POLICY,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });
    const earlierPreview = await composerPreview("trip", earlier.id);
    expectWholeText({ "earlier order's preview": earlierPreview }, BUILT_IN_FLIGHT_TEXTS);
    expectOnlyText({ "earlier order's preview": earlierPreview }, BUILT_IN_FLIGHT, NOT_BUILT_IN_FLIGHT);
    const nextPreview = await composerPreview("trip", next.id);
    expectWholeText({ "next order's preview": nextPreview }, [TRIP_FLIGHT_TERMS_TEXT, TRIP_FLIGHT_POLICY_TEXT]);
    expectOnlyText({ "next order's preview": nextPreview }, [TRIP_FLIGHT_TERMS, TRIP_FLIGHT_POLICY], NOT_TRIP_FLIGHT);
    expect(visibleText(nextPreview)).toContain(`Terms version ${firstOwnVersion}`);

    // A car order: still the deployment car text — a flight save is not a car save.
    const car = await storedOrder((await submitOrder("trip", carBody())).id);
    const deployment = await deploymentCarText();
    expect(car.serviceType).toBe(ServiceType.CAR_RENTAL);
    expect(car.terms).toEqual({ text: DEPLOYMENT_CAR_TERMS_TEXT, version: deployment.termsVersion });
    expect(car.policy).toMatchObject({
      text: DEPLOYMENT_CAR_POLICY_TEXT,
      version: deployment.cancellationPolicyVersion,
    });

    expectOnlyText({ "flight terms": flight.terms.text, "flight policy": flight.policy.text }, [], NOT_TRIP_FLIGHT);
    expectOnlyText({ "car terms": car.terms.text, "car policy": car.policy.text }, [], NOT_DEPLOYMENT_CAR);
    const { html: adminPreview } = await renderEmailPreview({
      organizationId: String(orgIds.trip),
      serviceType: ServiceType.FLIGHT,
      templateKey: "payment-request",
    });
    expectOnlyText({ "admin flight preview": adminPreview }, [TRIP_FLIGHT_TERMS, TRIP_FLIGHT_POLICY], NOT_TRIP_FLIGHT);

    // Admin → Settings now shows the brand's own flight text at its version,
    // no longer "ready to use" wording for it — and the car editor unchanged.
    const settings = await settingsPage("trip");
    const flightEditor = editorOf(settings, ServiceType.FLIGHT, TRIP.brandName)!;
    const carEditor = editorOf(settings, ServiceType.CAR_RENTAL, TRIP.brandName)!;
    expect(flightEditor).toContain(`Version ${firstOwnVersion}`);
    expect(flightEditor).not.toContain(readyToUse(ServiceType.FLIGHT, TRIP.brandName));
    expectWholeText({ "Flight editor": flightEditor }, [TRIP_FLIGHT_TERMS_TEXT, TRIP_FLIGHT_POLICY_TEXT]);
    expect(occurrences(carEditor, readyToUse(ServiceType.CAR_RENTAL, TRIP.brandName))).toBe(2);

    expectAbsent(
      {
        "create-config": JSON.stringify(config),
        "saved editor view": JSON.stringify(saved),
        "flight order": JSON.stringify(flight),
        "car order": JSON.stringify(car),
        "next order's preview": nextPreview,
        "earlier order's preview": earlierPreview,
        "admin flight preview": adminPreview,
        "settings page": settings,
      },
      FLIGHTBIZZ_MARKERS,
      "FlightBizz's",
    );
  }, 60_000);

  it("2c. even a BLANK deployment car text needs no admin: TripReservations' next car order freezes the built-in car defaults with their own version label (never an empty text, never the blank text's version, never a flight text); its flight order still freezes the built-in flight text", async () => {
    await enableFlightForTripReservations();
    // Raw driver: the schema refuses a blank text, but a stored document
    // can still hold one. Versions that must NOT travel with the fallback.
    await Setting.collection.updateOne(
      { key: SETTINGS_KEY },
      {
        $set: {
          termsAndConditions: "",
          termsVersion: "v7",
          cancellationPolicy: " \n ",
          cancellationPolicyVersion: "v5",
        },
      },
    );

    const car = await storedOrder((await submitOrder("trip", carBody())).id);
    // "v1" is the label the built-in car text has always carried (the
    // Settings schema's default); no exported constant names it.
    expect(car.terms).toEqual({ text: DEFAULT_TERMS_AND_CONDITIONS, version: "v1" });
    expect(car.policy).toMatchObject({ text: DEFAULT_CANCELLATION_POLICY, version: "v1" });
    expectOnlyText({ "car terms": car.terms.text, "car policy": car.policy.text }, [], [
      ...BUILT_IN_FLIGHT,
      ...BUILT_IN_HOTEL,
      DEPLOYMENT_CAR_TERMS,
      DEPLOYMENT_CAR_POLICY,
      TRIP_FLIGHT_TERMS,
      TRIP_FLIGHT_POLICY,
      FLIGHTBIZZ_FLIGHT_TERMS,
      FLIGHTBIZZ_FLIGHT_POLICY,
    ]);

    const flight = await storedOrder((await submitOrder("trip", flightBody())).id);
    expect(flight.terms).toEqual({
      text: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });
    expect(flight.policy).toMatchObject({
      text: DEFAULT_FLIGHT_CANCELLATION_POLICY,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });

    // The car editor reads exactly what the car order froze.
    const carEditor = await readLegal("trip", ServiceType.CAR_RENTAL);
    expect(carEditor.status, JSON.stringify(carEditor.body)).toBe(200);
    expect(carEditor.body.data).toMatchObject({
      sellsCarRental: true,
      termsIsDefault: true,
      policyIsDefault: true,
      termsAndConditions: DEFAULT_TERMS_AND_CONDITIONS,
      termsVersion: "v1",
      cancellationPolicy: DEFAULT_CANCELLATION_POLICY,
      cancellationPolicyVersion: "v1",
    });
    expect(await rawOrg("trip")).not.toHaveProperty("legal");
  }, 60_000);
});

/* ================================================================== *
 * 3. FLIGHT WORKFLOW
 * ================================================================== */

/** Flight enabled — and nothing else: no legal configuration at all. The
 *  operator creates the round trip, generates the link, opens the order,
 *  saves the PNR, previews and sends the request. */
async function startTripFlight(chargeName = FLIGHT_CHARGE) {
  const created = await submitOrder("trip", flightBody(chargeName));
  const stored = await storedOrder(created.id);
  const link = await generateLink("trip", created.id);
  const fetched = await orderApi("trip", created.id);
  const withPnr = await saveReference("trip", created.id, PNR);
  const preview = await composerPreview("trip", created.id);
  const request = await sendRequest("trip", created.id);
  return {
    created,
    stored,
    link,
    fetched,
    withPnr,
    preview,
    request,
    due: formatEmailDate(link.order.payment.expiresAt!),
  };
}

describe("3. FLIGHT WORKFLOW — TripReservations (PayPal, automatic capture), after enabling Flight — and configuring nothing else: every surface on the built-in flight terms", () => {
  it("3a. create → link → order page → PNR: stored [Rental Cost 100], airlineFare 400, pricing 100, the built-in flight terms frozen; PayPal is asked for '100.00' only (never 400.00 / 500.00), described 'Rental Cost • …'; GET /api/orders/[id] returns the itinerary; the PNR is saved through the confirmation-number route", async () => {
    await enableFlightForTripReservations();
    const j = await startTripFlight();

    // Stored: the airline charge apart, ONE named charge, pricing = that charge.
    expect(j.created.serviceType).toBe(ServiceType.FLIGHT);
    expect(String(j.stored.organizationId)).toBe(String(orgIds.trip));
    expect(j.stored.charges).toEqual([{ name: FLIGHT_CHARGE, amount: 100, timing: PaymentTiming.PREPAID }]);
    expect(j.stored.flight!.airlineFare).toBe(400);
    expect(j.stored.pricing).toEqual({ amount: 100, currency: "USD" });
    // No settings action: the built-in flight terms, frozen at creation.
    expect(j.stored.terms).toEqual({
      text: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });
    expect(j.stored.policy).toMatchObject({
      text: DEFAULT_FLIGHT_CANCELLATION_POLICY,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });
    expect(j.created.provider.name).toBe(AIRLINE);

    // The gateway: PayPal (never Stripe), exactly the charge.
    expect(j.link.order.payment.gateway).toBe(PaymentGatewayKey.PAYPAL);
    expect(j.link.stripe).toHaveLength(0);
    expect(j.link.paypal).toHaveLength(1);
    const body = j.link.paypal[0]!;
    expect(body.purchase_units).toHaveLength(1);
    const unit = body.purchase_units[0]!;
    expect(unit.amount).toEqual({ currency_code: "USD", value: "100.00" });
    expect(amountsIn(body)).toEqual([{ currency_code: "USD", value: "100.00" }]);
    // Nowhere in the request: not the airline charge, not the booking value.
    const sent = JSON.stringify(body);
    for (const figure of ["400.00", "500.00"]) {
      expect(sent, `PayPal was sent ${figure}`).not.toContain(figure);
    }
    expect(sent).not.toContain("Airline Charge");
    // Led by the charge's name, so it never reads as the fare.
    expect(unit.description.startsWith(`${FLIGHT_CHARGE} • `), unit.description).toBe(true);
    expect(unit.description).toBe(`${FLIGHT_CHARGE} • ${DEPARTS_RETURNS}`);
    expect(unit.custom_id).toBe(j.created.id);
    expect(body.payment_source.paypal.experience_context.brand_name).toBe(TRIP.brandName);

    // The order page's API: the flight, whole.
    const f = j.fetched;
    expect(f.serviceType).toBe(ServiceType.FLIGHT);
    expect(f.flight).toMatchObject({
      tripType: "ROUND_TRIP",
      cabinClass: "BUSINESS",
      passengers: { adults: 2, children: 1, infants: 0 },
      airlineFare: 400,
      pnr: null,
    });
    expect(f.flight!.outbound!.segments.map((s) => [s.origin, s.destination, s.airline, s.flightNumber])).toEqual([
      ["Delhi", "Varanasi", "Air India", "AI123"],
      ["Varanasi", "Mumbai", "IndiGo", "6E456"],
    ]);
    expect(f.flight!.return!.segments.map((s) => [s.origin, s.destination, s.airline, s.flightNumber])).toEqual([
      ["Mumbai", "Varanasi", "IndiGo", "6E789"],
      ["Varanasi", "Delhi", "Air India", "AI124"],
    ]);
    expect(f.flight!.outbound!.connections[0]!.layover).toMatchObject({ notes: "Change terminals" });
    expect(f.flight!.return!.connections[0]!.layover).toMatchObject({
      notes: "Lounge access included",
      durationMinutesOverride: 120,
    });
    expect(f.charges).toEqual([{ name: FLIGHT_CHARGE, amount: 100, timing: PaymentTiming.PREPAID }]);
    expect(f.pricing).toEqual({ amount: 100, currency: "USD" });
    expect(f.confirmationNumber).toBeNull();
    expect(f.terms).toEqual({
      text: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });

    // The PNR, saved on the order card: the order's one booking reference.
    expect(j.withPnr.confirmationNumber).toBe(PNR);
    expect(j.withPnr.flight!.pnr).toBeNull();
    const reread = await orderApi("trip", j.created.id);
    expect(reread.confirmationNumber).toBe(PNR);
    expect((await storedOrder(j.created.id)).confirmationNumber).toBe(PNR);
  }, 60_000);

  it("3b. composer preview + the payment request actually sent: Trip Reservations' brand and mailbox, PayPal named, the built-in flight terms only (whole, at DEFAULT_FLIGHT_LEGAL_VERSION), the itinerary, Airline Charge $400.00 / Rental Cost $100.00 / Total Booking Value $500.00 / Amount Payable Now $100.00, a CTA naming the charge, no car vocabulary", async () => {
    await enableFlightForTripReservations();
    const j = await startTripFlight();
    const on = j.created.orderNumber;
    const { email } = j.request;

    const surfaces = {
      "composer preview": j.preview,
      "payment request (html)": email.html,
      "payment request (text)": email.text,
    };
    expectWholeText(surfaces, BUILT_IN_FLIGHT_TEXTS);
    expectOnlyText(surfaces, BUILT_IN_FLIGHT, NOT_BUILT_IN_FLIGHT);
    for (const [where, content] of Object.entries(surfaces)) {
      const read = `${visibleText(content)}\n${plainText(content)}`;
      expect(read, where).toContain(`Terms version ${DEFAULT_FLIGHT_LEGAL_VERSION}`);
      expect(read, where).toContain(`Policy version ${DEFAULT_FLIGHT_LEGAL_VERSION}`);
    }

    // The money: four rows, the airline's never collected.
    const rows = `Price breakdown ${emailMoney(FLIGHT_CHARGE, "Amount Payable Now")}`;
    expect(moneyBlock(j.preview), "composer preview").toBe(rows);
    expect(moneyBlock(email.html), "payment request as sent").toBe(rows);
    expect(plainText(email.text)).toContain(emailMoney(FLIGHT_CHARGE, "Amount Payable Now"));
    expect(email.subject).toBe(`Complete your ${FLIGHT_CHARGE} payment • ${on}`);

    for (const [where, html] of Object.entries({ "composer preview": j.preview, "payment request": email.html })) {
      const read = visibleText(html);
      // The CTA names the charge — never the airline, never a total.
      expect(read, where).toContain(
        `Amount Payable Now $100.00 ${FLIGHT_CHARGE} Order ${on} Due ${j.due} Review & pay $100.00 ${FLIGHT_CHARGE}`,
      );
      expect(read, where).not.toContain("Amount Payable Now $400.00");
      expect(read, where).not.toContain("Amount Payable Now $500.00");
      // Trip Reservations' brand and mailbox — it publishes no phone, so no
      // "Call us" at all (never the deployment's number) — and PayPal.
      expect(read, where).toContain(`${TRIP.brandName} Payment requested`);
      expect(read, where).toContain(`${TRIP.brandName}. Automated payment receipt`);
      expect(html, where).toContain(`mailto:${TRIP.supportEmail}`);
      expect(html, where).not.toContain("tel:");
      expect(read, where).toContain(
        "Payment processed securely via PayPal. Your card details are encrypted end-to-end",
      );
      expect(read, where).toContain("Powered by PayPal.");
      expect(html, where).not.toMatch(/stripe/i);
      // The booking: the airline, the trip rows, the PNR saved on the card…
      expect(read, where).toContain(
        `Booking details Type New booking Airline / Supplier ${AIRLINE} ${FLIGHT_ROWS} PNR ${PNR} Flight itinerary`,
      );
      // …and the itinerary: both journeys, every flight, both layovers.
      expect(read, where).toContain(`Outbound ${OUTBOUND} · 1 stop`);
      expect(read, where).toContain(`Return ${INBOUND} · 1 stop`);
      for (const line of ITINERARY_LINES) expect(read, `${where}: ${line}`).toContain(line);
      // One booking reference, shown once.
      expect(occurrences(read, PNR), `${where}: the PNR`).toBe(1);
    }
    expect(visibleText(email.html)).toContain(
      `Thanks for booking with ${AIRLINE}. Your new booking is reserved — please pay the ${FLIGHT_CHARGE} using the secure link below to confirm it.`,
    );
    // Trip Reservations' own sender, over its own transport; it publishes no
    // Reply-To, and none is substituted.
    expect(email.from).toBe(`${TRIP.brandName} <${TRIP.fromEmail}>`);
    expect(email.transport).toBe(`org:${TRIP.fromEmail}`);
    expect(email.replyTo).toBe("");

    expectNoWords(CAR_WORDS_IN_A_FLIGHT, surfaces);
    for (const [where, content] of Object.entries(surfaces)) {
      for (const phrase of CAR_PHRASES) {
        expect(visibleText(content), `${where} says "${phrase}"`).not.toContain(phrase);
      }
    }
    expectAbsent({ ...surfaces, "subject": email.subject, "From": email.from }, FLIGHTBIZZ_MARKERS, "FlightBizz's");
    expectAbsent({ ...surfaces, "subject": email.subject, "From": email.from }, RENTALCONFIRMATION_MARKERS, "the deployment brand's");
  }, 60_000);

  it("3c. consent page: the same four rows, 'Confirm & pay $100.00 Rental Cost', Trip Reservations' PayPal checkout — and no other brand's or service's terms", async () => {
    await enableFlightForTripReservations();
    const j = await startTripFlight();
    const consent = await consentPage(j.request.consentToken);
    const page = visibleText(consent);

    expect(moneyBlock(consent, "Booking summary")).toBe(
      `Booking summary Amount Payable Now $100.00 ${FLIGHT_CHARGE} New booking ${pageMoney(FLIGHT_CHARGE, "Amount Payable Now")}`,
    );
    expect(page).toContain(`Confirm & pay $100.00 ${FLIGHT_CHARGE}`);
    expect(page).not.toContain("Confirm & Continue to Payment");
    // The same booking the email showed — rows, PNR and the whole itinerary.
    expect(page).toContain(
      `Customer ${j.created.customer.name} Email ${j.created.customer.email} Airline / Supplier ${AIRLINE} ${FLIGHT_ROWS} PNR ${PNR} Itinerary`,
    );
    for (const line of ITINERARY_LINES) expect(page, line).toContain(line);
    expect(page).toContain(`you'll continue to ${TRIP.brandName}'s secure PayPal checkout.`);
    expect(page).toContain("You'll be taken directly to PayPal Checkout to complete payment.");
    expect(page).toContain(`Email ${TRIP.supportEmail} if you need help.`);
    expect(consent).not.toMatch(/stripe/i);
    // The hosted page prints no T&C text by design (the terms travel in the
    // emails and on the acknowledge page) — and certainly no other text.
    expectOnlyText({ "consent page": consent }, [], NOT_BUILT_IN_FLIGHT);
    expectNoWords(CAR_WORDS_IN_A_FLIGHT, { "consent page": consent });
    expectAbsent({ "consent page": consent }, FLIGHTBIZZ_MARKERS, "FlightBizz's");
    expectAbsent({ "consent page": consent }, RENTALCONFIRMATION_MARKERS, "the deployment brand's");

    // The customer confirms: the statement is the flight's neutral one.
    const view = await confirmConsent(j.request.consentToken, j.created.customer.name);
    expect(view.brandName).toBe(TRIP.brandName);
    expect(view.gatewayLabel).toBe("PayPal");
  }, 60_000);

  it("3d. paid through TripReservations' PayPal webhook (APPROVED → capture → COMPLETED): confirmation email with 'Rental Cost Paid $100.00', the built-in flight terms only, 'PNR AXXXYY' once in the top block; the resend works the same; the acknowledge page prints the built-in flight terms", async () => {
    await enableFlightForTripReservations();
    const j = await startTripFlight();
    await confirmConsent(j.request.consentToken, j.created.customer.name);
    const on = j.created.orderNumber;
    const p = await payWithPayPal(j.link.order);

    // Approval is not payment: captured on PayPal first, settled by COMPLETED.
    expect(p.approved.status, JSON.stringify(p.approved.body)).toBe(200);
    expect(p.approved.body.data.captured).toBe(true);
    expect(p.capturesAsked).toBe(1);
    expect(p.statusAfterApproval).toBe(OrderStatus.PAYMENT_PENDING);
    expect(p.drainedAfterApproval.sent).toBe(0);
    expect(p.completed.status, JSON.stringify(p.completed.body)).toBe(200);
    expect(p.completed.body.data).toMatchObject({ handled: true, duplicate: false });
    expect(p.drained.sent).toBe(1);
    const paid = await orderApi("trip", j.created.id);
    expect(paid.status).toBe(OrderStatus.PAID);
    expect(paid.payment.amountReceived).toBe(100);
    expect(paid.confirmationNumber).toBe(PNR);
    expect(getCurrentTestStripe().sessionsCreated).toHaveLength(0);

    const resend = await resendConfirmation("trip", j.created.id);
    expect(resend.emailId).toBeTruthy();
    expect(resend.order.confirmationNumber).toBe(PNR);

    for (const [where, email] of Object.entries({ confirmation: p.confirmation, "resent confirmation": resend.email })) {
      const read = visibleText(email.html);
      const parts = { [`${where} (html)`]: email.html, [`${where} (text)`]: email.text };
      expectWholeText(parts, BUILT_IN_FLIGHT_TEXTS);
      expectOnlyText(parts, BUILT_IN_FLIGHT, NOT_BUILT_IN_FLIGHT);
      expect(read, where).toContain(`Terms version ${DEFAULT_FLIGHT_LEGAL_VERSION}`);
      expect(read, where).toContain(`Policy version ${DEFAULT_FLIGHT_LEGAL_VERSION}`);
      expect(email.subject, where).toBe(`${AIRLINE} booking confirmed • ${on}`);
      expect(moneyBlock(email.html), where).toBe(
        `Price breakdown ${emailMoney(FLIGHT_CHARGE, `${FLIGHT_CHARGE} Paid`)}`,
      );
      expect(read, where).toContain(`${FLIGHT_CHARGE} Paid $100.00`);
      expect(read, where).toContain(`${FLIGHT_CHARGE} Paid $100.00 Order ${on}`);
      expect(read, where).toContain(`We've received your ${FLIGHT_CHARGE} payment for new booking`);
      expect(plainText(email.text), where).toContain(emailMoney(FLIGHT_CHARGE, `${FLIGHT_CHARGE} Paid`));
      // The top block — under the flight's own name for it — and ONCE: the
      // booking details list the trip rows with no second PNR row.
      expect(read, where).toContain(
        `please keep this email for your records. PNR ${PNR} ${AIRLINE} New booking Booking details`,
      );
      expect(read, where).toContain(
        `Booking details Type New booking Airline / Supplier ${AIRLINE} ${FLIGHT_ROWS} Flight itinerary`,
      );
      expect(occurrences(read, PNR), `${where}: the PNR in the HTML`).toBe(1);
      expect(occurrences(email.text, PNR), `${where}: the PNR in the text`).toBe(1);
      // One "PNR" label outside the terms — whose own v3 wording promises
      // the PNR "appears on your confirmation", which it does, once.
      expect(outsideLegal(read, BUILT_IN_FLIGHT_TEXTS).match(/\bPNR\b/g), `${where}: PNR labels`).toHaveLength(1);
      for (const line of ITINERARY_LINES) expect(read, `${where}: ${line}`).toContain(line);
      // Brand, mailbox, processor.
      expect(read, where).toContain(`${TRIP.brandName} Payment receipt Payment confirmed`);
      expect(read, where).toContain(`${TRIP.brandName}. Automated payment receipt`);
      expect(read, where).toContain("Payment processed securely by PayPal — PCI-DSS Level 1 certified.");
      expect(email.html, where).not.toMatch(/stripe/i);
      expect(email.html, where).not.toContain("tel:");
      expect(email.from, where).toBe(`${TRIP.brandName} <${TRIP.fromEmail}>`);
      expect(email.transport, where).toBe(`org:${TRIP.fromEmail}`);
      expectNoWords(CAR_WORDS_IN_A_FLIGHT, { [where]: email.html });
      expectAbsent({ [where]: email.html, [`${where} (text)`]: email.text }, FLIGHTBIZZ_MARKERS, "FlightBizz's");
      expectAbsent({ [where]: email.html, [`${where} (text)`]: email.text }, RENTALCONFIRMATION_MARKERS, "the deployment brand's");
    }

    // The page the confirmation's "I Agree" opens prints these terms — the
    // built-in flight terms, whole, at their version — and no other.
    const acknowledge = await acknowledgePage(resend.email.html);
    expectWholeText({ "acknowledge page": acknowledge }, [DEFAULT_FLIGHT_TERMS_AND_CONDITIONS]);
    expectOnlyText({ "acknowledge page": acknowledge }, BUILT_IN_FLIGHT_TERMS, NOT_BUILT_IN_FLIGHT);
    expect(visibleText(acknowledge)).toContain(`Terms version ${DEFAULT_FLIGHT_LEGAL_VERSION}`);
    expect(visibleText(acknowledge)).toContain(
      `Please review and acknowledge the terms for your ${TRIP.brandName} booking ${on} .`,
    );
    // Where PayPal returns the customer: the same name, money and reference.
    const receipt = await receiptPage(paid);
    expect(moneyBlock(receipt)).toBe(`Price breakdown ${pageMoney(FLIGHT_CHARGE, `${FLIGHT_CHARGE} Paid`)}`);
    expect(visibleText(receipt)).toContain(`PNR ${PNR}`);
    expect(occurrences(visibleText(receipt), PNR)).toBe(1);
    expect(visibleText(receipt)).toContain("Payment processed securely by PayPal — PCI-DSS Level 1 certified.");
    expectOnlyText({ receipt }, [], NOT_BUILT_IN_FLIGHT);
    expectAbsent({ "acknowledge page": acknowledge, receipt }, FLIGHTBIZZ_MARKERS, "FlightBizz's");
    expectAbsent({ "acknowledge page": acknowledge, receipt }, RENTALCONFIRMATION_MARKERS, "the deployment brand's");
  }, 60_000);

  it("3e. rename: a second flight whose charge is named 'Processing Fee' (same $400 / $100) — its preview and sent email say 'Processing Fee' (never 'Rental Cost'); PayPal is asked for the same '100.00'; the terms are the same built-in flight terms", async () => {
    await enableFlightForTripReservations();
    const rental = await startTripFlight(FLIGHT_CHARGE);
    const renamed = await startTripFlight(RENAMED_CHARGE);

    expect(renamed.stored.charges).toEqual([{ name: RENAMED_CHARGE, amount: 100, timing: PaymentTiming.PREPAID }]);
    expect(renamed.stored.flight!.airlineFare).toBe(400);
    expect(renamed.stored.pricing).toEqual({ amount: 100, currency: "USD" });

    for (const [name, j] of [[FLIGHT_CHARGE, rental], [RENAMED_CHARGE, renamed]] as const) {
      expect(j.link.paypal).toHaveLength(1);
      const unit = j.link.paypal[0]!.purchase_units[0]!;
      expect(unit.amount).toEqual({ currency_code: "USD", value: "100.00" });
      expect(amountsIn(j.link.paypal[0])).toEqual([{ currency_code: "USD", value: "100.00" }]);
      // Only the name in the description changes — the money never does.
      expect(unit.description).toBe(`${name} • ${DEPARTS_RETURNS}`);
      for (const figure of ["400.00", "500.00"]) {
        expect(JSON.stringify(j.link.paypal[0]), `${name}: PayPal was sent ${figure}`).not.toContain(figure);
      }
    }
    expect(getCurrentTestStripe().sessionsCreated).toHaveLength(0);

    const rows = `Price breakdown ${emailMoney(RENAMED_CHARGE, "Amount Payable Now")}`;
    expect(moneyBlock(renamed.preview), "preview").toBe(rows);
    expect(moneyBlock(renamed.request.email.html), "sent email").toBe(rows);
    expect(plainText(renamed.request.email.text)).toContain(emailMoney(RENAMED_CHARGE, "Amount Payable Now"));
    expect(renamed.request.email.subject).toBe(`Complete your ${RENAMED_CHARGE} payment • ${renamed.created.orderNumber}`);
    for (const html of [renamed.preview, renamed.request.email.html]) {
      expect(visibleText(html)).toContain(`Review & pay $100.00 ${RENAMED_CHARGE}`);
      expect(visibleText(html)).toContain(
        `please pay the ${RENAMED_CHARGE} using the secure link below to confirm it.`,
      );
    }
    for (const [where, content] of Object.entries({
      preview: renamed.preview,
      "sent email (html)": renamed.request.email.html,
      "sent email (text)": renamed.request.email.text,
      "sent email (subject)": renamed.request.email.subject,
    })) {
      expect(everything(content).toLowerCase(), `${where} still says "Rental Cost"`).not.toContain("rental cost");
    }
    // The charge's name is the operator's; the terms are still the built-in
    // flight terms (which name no charge), frozen at the same version.
    expect(renamed.stored.terms).toEqual({
      text: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });
    const renamedSurfaces = {
      preview: renamed.preview,
      "sent email (html)": renamed.request.email.html,
      "sent email (text)": renamed.request.email.text,
    };
    expectWholeText(renamedSurfaces, BUILT_IN_FLIGHT_TEXTS);
    expectOnlyText(renamedSurfaces, BUILT_IN_FLIGHT, NOT_BUILT_IN_FLIGHT);
    // Each order keeps its own name.
    expect(moneyBlock(await composerPreview("trip", rental.created.id))).toBe(
      `Price breakdown ${emailMoney(FLIGHT_CHARGE, "Amount Payable Now")}`,
    );
  }, 60_000);
});

/* ================================================================== *
 * 4. STRIPE — another Flight organization
 * ================================================================== */

/** Flight enabled for TripReservations AND its (optional) own flight terms
 *  saved — so a leak of its override into another brand would be visible. */
async function tripReservationsCustomised() {
  await enableFlightForTripReservations();
  await saveTripReservationsFlightTerms();
}

describe("4. STRIPE — FlightBizz (globevista), the other Flight organization, unchanged", () => {
  it("4a. a FlightBizz flight $400 + $100: Stripe is asked for unit_amount 10000 only (manual capture), its line item leads with the charge name; FlightBizz's own flight terms only (its first own version, nextPolicyVersion(DEFAULT_FLIGHT_LEGAL_VERSION)) — nothing of Trip Reservations', even with TripReservations' override saved", async () => {
    await tripReservationsCustomised();
    const created = await submitOrder("gv", flightBody());
    const stored = await storedOrder(created.id);
    expect(String(stored.organizationId)).toBe(String(orgIds.gv));
    expect(stored.charges).toEqual([{ name: FLIGHT_CHARGE, amount: 100, timing: PaymentTiming.PREPAID }]);
    expect(stored.flight!.airlineFare).toBe(400);
    expect(stored.pricing).toEqual({ amount: 100, currency: "USD" });
    // FlightBizz customised its flight text (beforeEach), so it freezes that.
    expect(stored.terms).toEqual({
      text: FLIGHTBIZZ_FLIGHT_TERMS_TEXT,
      version: nextPolicyVersion(DEFAULT_FLIGHT_LEGAL_VERSION),
    });
    expect(stored.policy).toMatchObject({
      text: FLIGHTBIZZ_FLIGHT_POLICY_TEXT,
      version: nextPolicyVersion(DEFAULT_FLIGHT_LEGAL_VERSION),
    });

    const link = await generateLink("gv", created.id);
    expect(link.order.payment.gateway).toBe(PaymentGatewayKey.STRIPE);
    expect(link.paypal).toHaveLength(0);
    expect(link.stripe).toHaveLength(1);
    const params = link.stripe[0]!;
    const items = params.line_items ?? [];
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.quantity).toBe(1);
    expect(item.price_data!.unit_amount).toBe(10000);
    expect(item.price_data!.currency).toBe("usd");
    expect(amountsIn(params)).toEqual([10000]);
    for (const figure of ["40000", "50000"]) {
      expect(JSON.stringify(items), `Stripe's line item carries ${figure}`).not.toContain(figure);
    }
    for (const figure of ["400.00", "500.00"]) {
      expect(JSON.stringify(params), `Stripe was sent ${figure}`).not.toContain(figure);
    }
    const product = item.price_data!.product_data!;
    expect(product.name.split(" • ")[0]).toBe(FLIGHT_CHARGE);
    expect(product.name).toBe(`${FLIGHT_CHARGE} • ${AIRLINE} • ${OUTBOUND} (round trip)`);
    expect(product.description).toBe(`${FLIGHT_CHARGE} • ${DEPARTS_RETURNS}`);
    expect(JSON.stringify(items)).not.toContain("Airline Charge");
    // FlightBizz runs on MANUAL capture: an authorization, captured later.
    expect(params.payment_intent_data?.capture_method).toBe("manual");
    expect(params.metadata?.appName).toBe(GV.brandName);
    expect(params.payment_intent_data?.description).toBe(`${GV.brandName} • ${created.orderNumber}`);

    const preview = await composerPreview("gv", created.id);
    expectOnlyText(
      { "FlightBizz composer preview": preview },
      [FLIGHTBIZZ_FLIGHT_TERMS, FLIGHTBIZZ_FLIGHT_POLICY],
      [TRIP_FLIGHT_TERMS, TRIP_FLIGHT_POLICY, DEPLOYMENT_CAR_TERMS, DEPLOYMENT_CAR_POLICY, ...BUILT_IN_FLIGHT, ...BUILT_IN_CAR, ...BUILT_IN_HOTEL],
    );
    // …so its request names the HOLD: the charge "On Hold", never "Amount
    // Payable Now" for money the checkout only authorizes.
    expect(moneyBlock(preview)).toBe(`Price breakdown ${emailMoney(FLIGHT_CHARGE, `${FLIGHT_CHARGE} On Hold`)}`);
    expect(visibleText(preview)).not.toContain("Amount Payable Now");
    expect(visibleText(preview)).toContain(GV.brandName);
    expect(preview).not.toMatch(/paypal/i);
    expectAbsent(
      { "FlightBizz composer preview": preview, "Stripe request": JSON.stringify(params), "order": JSON.stringify(stored) },
      TRIP_MARKERS,
      "Trip Reservations'",
    );
  }, 60_000);

  it("4b. FlightBizz's services it never customised need no admin either: its HOTEL order freezes the built-in hotel terms and policy at DEFAULT_HOTEL_LEGAL_VERSION and its CAR order the deployment car text — never its own flight text, never Trip Reservations'", async () => {
    await tripReservationsCustomised();

    const hotel = await storedOrder((await submitOrder("gv", hotelBody())).id);
    expect(hotel.serviceType).toBe(ServiceType.HOTEL);
    expect(String(hotel.organizationId)).toBe(String(orgIds.gv));
    expect(hotel.terms).toEqual({
      text: DEFAULT_HOTEL_TERMS_AND_CONDITIONS,
      version: DEFAULT_HOTEL_LEGAL_VERSION,
    });
    expect(hotel.policy).toMatchObject({
      text: DEFAULT_HOTEL_CANCELLATION_POLICY,
      version: DEFAULT_HOTEL_LEGAL_VERSION,
    });

    const car = await storedOrder((await submitOrder("gv", carBody())).id);
    const deployment = await deploymentCarText();
    expect(car.serviceType).toBe(ServiceType.CAR_RENTAL);
    expect(String(car.organizationId)).toBe(String(orgIds.gv));
    expect(car.terms).toEqual({ text: DEPLOYMENT_CAR_TERMS_TEXT, version: deployment.termsVersion });
    expect(car.policy).toMatchObject({
      text: DEPLOYMENT_CAR_POLICY_TEXT,
      version: deployment.cancellationPolicyVersion,
    });

    expectOnlyText({ "hotel terms": hotel.terms.text, "hotel policy": hotel.policy.text }, [], [
      FLIGHTBIZZ_FLIGHT_TERMS,
      FLIGHTBIZZ_FLIGHT_POLICY,
      TRIP_FLIGHT_TERMS,
      TRIP_FLIGHT_POLICY,
      DEPLOYMENT_CAR_TERMS,
      DEPLOYMENT_CAR_POLICY,
      ...BUILT_IN_FLIGHT,
      ...BUILT_IN_CAR,
    ]);
    expectOnlyText({ "car terms": car.terms.text, "car policy": car.policy.text }, [], NOT_DEPLOYMENT_CAR);
    // FlightBizz's stored legal is still its flight text alone: the hotel
    // and car orders above needed nothing written.
    const legal = (await rawOrg("gv")).legal as {
      termsAndConditions?: string;
      cancellationPolicy?: string;
      services?: Record<string, unknown>;
    };
    expect(legal.services?.FLIGHT).toMatchObject({ termsAndConditions: FLIGHTBIZZ_FLIGHT_TERMS_TEXT });
    expect(legal.services?.HOTEL ?? null).toBeNull();
    expect(legal.termsAndConditions ?? "").toBe("");
    expect(legal.cancellationPolicy ?? "").toBe("");
  }, 60_000);
});

/* ================================================================== *
 * 5. CAR REGRESSION
 * ================================================================== */

describe("5. CAR REGRESSION — TripReservations' car rental after Flight is enabled (nothing else configured)", () => {
  it("5a. a car order (prepaid + due at counter): PayPal is asked for the prepaid $249.99 only; its request email is the car email ('What you're paying', 'Amount paid online', 'Total rental cost', 'Review & Confirm Booking') with the deployment car terms only — no flight field, row or terms (built-in or otherwise) anywhere", async () => {
    await enableFlightForTripReservations();
    // A flight order first: its built-in flight terms are now in use for
    // TripReservations — and must still never reach its car rental.
    await submitOrder("trip", flightBody());
    const created = await submitOrder("trip", carBody());
    const stored = await storedOrder(created.id);
    expect(created.serviceType).toBe(ServiceType.CAR_RENTAL);
    expect(stored.flight ?? null).toBeNull();
    expect(stored.charges).toEqual([
      { name: "Rental cost", amount: 249.99, timing: PaymentTiming.PREPAID },
      { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
    ]);
    expect(stored.pricing).toEqual({ amount: 249.99, currency: "USD" });
    expect(stored.terms.text).toBe(DEPLOYMENT_CAR_TERMS_TEXT);
    expect(stored.policy.text).toBe(DEPLOYMENT_CAR_POLICY_TEXT);

    const link = await generateLink("trip", created.id);
    expect(link.stripe).toHaveLength(0);
    expect(link.paypal).toHaveLength(1);
    const body = link.paypal[0]!;
    expect(body.purchase_units[0]!.amount).toEqual({ currency_code: "USD", value: "249.99" });
    expect(amountsIn(body)).toEqual([{ currency_code: "USD", value: "249.99" }]);
    for (const figure of ["100.00", "349.99"]) {
      expect(JSON.stringify(body), `PayPal was sent ${figure}`).not.toContain(figure);
    }
    expect(body.purchase_units[0]!.description).toMatch(
      /^Pick-up: \d{4}-\d{2}-\d{2} \(LAX Airport — Terminal 1\) • Drop-off: \d{4}-\d{2}-\d{2} \(San Diego Downtown\)$/,
    );

    const preview = await composerPreview("trip", created.id);
    const { email } = await sendRequest("trip", created.id);
    const on = created.orderNumber;
    expect(email.subject).toBe(`Complete your ${CAR_SUPPLIER} payment • ${on}`);
    const rows =
      "What you're paying Rental cost $249.99 Deposit (due at counter) $100.00 " +
      "Amount paid online $249.99 Amount due at counter $100.00 Total rental cost $349.99";
    for (const [where, html] of Object.entries({ "composer preview": preview, "payment request": email.html })) {
      const read = visibleText(html);
      expect(read, where).toContain(rows);
      expect(read, where).toContain(`You pay today $249.99 Order ${on}`);
      expect(read, where).toContain("Review & Confirm Booking");
      expect(read, where).toContain(
        `Booking details Type New booking Provider ${CAR_SUPPLIER} Vehicle Toyota • Camry Pick-up`,
      );
      expect(read, where).toContain(
        `Thanks for booking with ${CAR_SUPPLIER}. Your new booking is reserved — please complete payment using the secure link below to confirm it.`,
      );
      expect(read, where).toContain(`${TRIP.brandName} Payment requested`);
      expect(read, where).toContain(
        "Payment processed securely via PayPal. Your card details are encrypted end-to-end",
      );
      expect(html, where).not.toMatch(/stripe/i);
    }
    expect(email.transport).toBe(`org:${TRIP.fromEmail}`);

    const surfaces = {
      "composer preview": preview,
      "payment request (html)": email.html,
      "payment request (text)": email.text,
    };
    expectOnlyText(surfaces, [DEPLOYMENT_CAR_TERMS, DEPLOYMENT_CAR_POLICY], NOT_DEPLOYMENT_CAR);
    // The car terms editor still inherits the deployment text — enabling
    // Flight (and taking flight orders) wrote no car text for TripReservations.
    const carEditor = await readLegal("trip", ServiceType.CAR_RENTAL);
    expect(carEditor.status, JSON.stringify(carEditor.body)).toBe(200);
    expect(carEditor.body.data).toMatchObject({
      sellsCarRental: true,
      termsIsDefault: true,
      policyIsDefault: true,
      termsAndConditions: DEPLOYMENT_CAR_TERMS_TEXT,
      cancellationPolicy: DEPLOYMENT_CAR_POLICY_TEXT,
    });
    for (const [where, content] of Object.entries({ ...surfaces, subject: email.subject })) {
      const read = [visibleText(content), plainText(decoded(content))].join("\n");
      for (const phrase of FLIGHT_PHRASES) {
        expect(read, `${where} shows "${phrase}"`).not.toContain(phrase);
      }
      expect(read, `${where} shows a PNR`).not.toMatch(/\bPNR\b/);
      expect(read, `${where} shows the airline`).not.toContain(AIRLINE);
    }
    expectAbsent({ ...surfaces, subject: email.subject }, FLIGHTBIZZ_MARKERS, "FlightBizz's");
    expectAbsent({ ...surfaces, subject: email.subject }, RENTALCONFIRMATION_MARKERS, "the deployment brand's");
  }, 60_000);
});

/* ================================================================== *
 * 6. OTHER ORGS
 * ================================================================== */

describe("6. OTHER ORGS — enabling TripReservations changes no other organization", () => {
  it("6a. rentalconfirmation (default, Stripe, no stored list): its create-config (no legalStatus) and create page (no notice) have no flight; a flight order is refused (422) and stores nothing; its car flow is unchanged — deployment Stripe, deployment car terms, the car email", async () => {
    await enableFlightForTripReservations();

    const config = await createConfig("rc");
    expect(config.serviceTypes).toEqual([ServiceType.CAR_RENTAL]);
    expectNoLegalStatus(config);
    const page = await createPage("rc");
    expect(page).not.toContain('role="tablist"');
    expectNoTermsNotice({ "rentalconfirmation create page": page });

    const before = await writtenCounts();
    const refused = await postOrder("rc", flightBody());
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error).toMatchObject({ code: "VALIDATION_ERROR", message: NOT_SOLD.rcFlights });
    expect(await writtenCounts()).toEqual(before);

    // The car rental, as it has always been.
    const created = await submitOrder("rc", carBody());
    const stored = await storedOrder(created.id);
    expect(String(stored.organizationId)).toBe(String(orgIds.rc));
    expect(stored.terms.text).toBe(DEPLOYMENT_CAR_TERMS_TEXT);
    expect(stored.policy.text).toBe(DEPLOYMENT_CAR_POLICY_TEXT);
    const link = await generateLink("rc", created.id);
    expect(link.paypal).toHaveLength(0);
    expect(link.stripe).toHaveLength(1);
    const item = link.stripe[0]!.line_items![0]!;
    expect(item.price_data!.unit_amount).toBe(24999);
    expect(item.price_data!.product_data!.name).toBe(`${CAR_SUPPLIER} • Toyota Camry rental`);
    expect(amountsIn(link.stripe[0])).toEqual([24999]);
    // Automatic capture, the deployment brand's name — as it always was.
    expect(link.stripe[0]!.payment_intent_data?.capture_method).toBeUndefined();
    expect(link.stripe[0]!.metadata?.appName).toBe(RC.brandName);

    const { email } = await sendRequest("rc", created.id);
    const on = created.orderNumber;
    const read = visibleText(email.html);
    expect(email.subject).toBe(`Complete your ${CAR_SUPPLIER} payment • ${on}`);
    expect(read).toContain(`You pay today $249.99 Order ${on}`);
    expect(read).toContain("Review & Confirm Booking");
    expect(read).toContain(
      "What you're paying Rental cost $249.99 Deposit (due at counter) $100.00 " +
        "Amount paid online $249.99 Amount due at counter $100.00 Total rental cost $349.99",
    );
    expect(read).toContain(`${RC.brandName} Payment requested`);
    expect(read).toContain("Payment processed securely via Stripe.");
    expect(email.transport).toBe("deployment");
    expectOnlyText(
      { "payment request (html)": email.html, "payment request (text)": email.text },
      [DEPLOYMENT_CAR_TERMS, DEPLOYMENT_CAR_POLICY],
      NOT_DEPLOYMENT_CAR,
    );
    for (const phrase of FLIGHT_PHRASES) expect(read).not.toContain(phrase);
    expect(read).not.toMatch(/\bPNR\b/);
    expectAbsent({ "payment request (html)": email.html, subject: email.subject }, TRIP_MARKERS, "Trip Reservations'");
    expectAbsent({ "payment request (html)": email.html, subject: email.subject }, FLIGHTBIZZ_MARKERS, "FlightBizz's");

    // Still exactly the stored shape production has.
    const rc = await rawOrg("rc");
    expect(rc).not.toHaveProperty("serviceTypes");
    expect(rc).not.toHaveProperty("legal");
  }, 60_000);
});
