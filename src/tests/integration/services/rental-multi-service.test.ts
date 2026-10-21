import { execFile } from "node:child_process";
import { createElement, type ReactElement } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mongoose, { Types } from "mongoose";
import type Stripe from "stripe";

import { GET as legalGetRoute, PATCH as legalPatchRoute } from "@/app/api/admin/settings/legal/route";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { POST as cancelAuthorizationRoute } from "@/app/api/orders/[id]/cancel-authorization/route";
import { POST as captureRoute } from "@/app/api/orders/[id]/capture/route";
import { POST as generateLinkRoute } from "@/app/api/orders/[id]/generate-payment-link/route";
import { POST as sendRequestRoute } from "@/app/api/orders/[id]/send-payment-request/route";
import { POST as deploymentStripeWebhookRoute } from "@/app/api/webhooks/stripe/route";
import CreateOrderPage from "@/app/app/orders/create/page";
import {
  BookingStatus,
  CaptureMode,
  EmailKind,
  OrderStatus,
  PaymentCaptureStatus,
  PaymentGatewayKey,
  PaymentTiming,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { env } from "@/lib/env";
import { stripeWebhookPath } from "@/lib/organization-capture-mode";
import {
  Branding,
  Order,
  Organization,
  OrganizationMember,
  PendingEmail,
  Setting,
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
import { createProvider } from "@/server/services/provider.service";
import { createSettings } from "@/tests/factories/settings.factory";
import {
  buildAmountCapturableUpdated,
  buildCheckoutCompleted,
  signWebhook,
} from "@/tests/factories/stripe-event.factory";
import {
  flightServiceCharge,
  validCreateOrderInput,
  validFlightOrderInput,
  validHotelOrderInput,
} from "@/tests/fixtures/order-input.fixture";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";
import type { OrderDTO } from "@/types";

/**
 * RENTAL CONFIRMATION SELLS CAR + FLIGHT + HOTEL — the configuration
 * production is moving to, pinned on the DEFAULT organization.
 *
 * Flights and hotels are not new: they are data-driven services every
 * organization can be given (`serviceTypes`), and FlightBizz (GlobeVista)
 * already sells all three on manual capture. What no other file covers is
 * the DEFAULT organization selling them — the brand whose car orders
 * inherit the deployment Settings text, whose customers see the deployment
 * Branding singleton, and whose Stripe events arrive at the deployment
 * endpoint on the deployment account. This file proves each of those
 * default-organization rules holds for a flight and a hotel exactly as it
 * does for a car rental, and that nothing of FlightBizz's reaches Rental's
 * customers.
 *
 * THE WORLD (production-shaped):
 *
 *   rentalconfirmation   DEFAULT, Stripe on the deployment account, MANUAL
 *                        capture (switched 2026-10-20), NO `serviceTypes`
 *                        stored (reads as [CAR_RENTAL]) and no `legal`
 *   globevista           FlightBizz: MANUAL, its OWN Stripe account
 *                        (ORG_GLOBEVISTA_*), sells [FLIGHT, HOTEL, CAR_RENTAL]
 *                        with its OWN flight terms — the canary: its text and
 *                        identity must never surface on a Rental order
 *
 * THE SWITCH is `scripts/set-organization-services.ts` — ORG_SLUG=
 * rentalconfirmation SERVICES=FLIGHT,HOTEL — run as a child process (npx
 * tsx) against THIS file's in-memory database, exactly as an operator runs
 * it. Everything downstream runs on the document the real script writes.
 *
 *   0. world        the stored shape above, verified
 *   1. switch       before (car only) / dry run / apply / re-run; the
 *                   create page: the car form alone → Car rental | Flight |
 *                   Hotel, car first and open
 *   2. T&C          flight → built-in flight, hotel → built-in hotel, car →
 *                   deployment car; Rental's own CAR text reaches only car
 *   3. payments     a held flight captured, a held hotel released — on the
 *                   deployment account, through the deployment endpoint
 *   4. emails       the payment requests: deployment identity, an
 *                   authorization subject, the service's own terms
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

/* ------------------------------------------------------------------ *
 * The deployment
 * ------------------------------------------------------------------ */

type OrgKey = "rc" | "gv";

/** The deployment Branding singleton — Rental Confirmation's, in production. */
const RC = {
  slug: "rentalconfirmation",
  brandName: "Rental Confirmation",
  supportEmail: "support@rentalconfirmation.com",
  supportPhone: "+15513071441",
} as const;

/** GlobeVista: operations name; FlightBizz is the only name its customers see. */
const GV = {
  slug: "globevista",
  name: "GlobeVista",
  brandName: "FlightBizz",
  supportEmail: "support@flightbizz.test",
  fromEmail: "bookings@flightbizz.test",
} as const;

const SLUG: Record<OrgKey, string> = { rc: RC.slug, gv: GV.slug };

const GV_STRIPE_SECRET_KEY = "sk_test_globevista_only";
const WORLD_ENV: Record<string, string> = {
  ORG_GLOBEVISTA_STRIPE_SECRET_KEY: GV_STRIPE_SECRET_KEY,
  ORG_GLOBEVISTA_STRIPE_WEBHOOK_SECRET: "whsec_globevista_only",
};

/** Rental Confirmation has nothing under this prefix in production. */
const RENTAL_ENV_PREFIX = "ORG_RENTALCONFIRMATION_";

const DEPLOYMENT_ENDPOINT = stripeWebhookPath({ slug: RC.slug, isDefault: true });

/* Every terms / policy text carries an apostrophe-free marker (HTML
 * escaping), and no marker is a substring of another. */

/** The deployment Settings car text — what Rental's car orders inherit. */
const DEPLOYMENT_CAR_TERMS = "DEPLOYMENT CAR TERMS";
const DEPLOYMENT_CAR_POLICY = "DEPLOYMENT CAR POLICY";
const DEPLOYMENT_CAR_TERMS_TEXT = `${DEPLOYMENT_CAR_TERMS} — The prepaid amount is charged today to secure your reservation. The renter presents a licence at the counter.`;
const DEPLOYMENT_CAR_POLICY_TEXT = `${DEPLOYMENT_CAR_POLICY} — refunds follow the rental desk rules.`;

/** The car-only wording fix, as Admin → Settings → Car rental terms saves it. */
const CHARGED_TODAY = "The prepaid amount is charged today to secure your reservation.";
const HELD_UNTIL_CONFIRMED =
  "The prepaid amount secures your reservation. If your card is authorized (held) rather than charged, the prepaid amount is collected only once your booking is confirmed.";

/** FlightBizz's own flight text — never on a Rental order. */
const FLIGHTBIZZ_FLIGHT_TERMS = "FLIGHTBIZZ FLIGHT TERMS";
const FLIGHTBIZZ_FLIGHT_POLICY = "FLIGHTBIZZ FLIGHT POLICY";
const FLIGHTBIZZ_FLIGHT_TERMS_TEXT = `${FLIGHTBIZZ_FLIGHT_TERMS} — FlightBizz issues every ticket itself.`;
const FLIGHTBIZZ_FLIGHT_POLICY_TEXT = `${FLIGHTBIZZ_FLIGHT_POLICY} — FlightBizz refunds within ten days.`;

/* Apostrophe-free lines, each from exactly one built-in default — test 0
 * checks them against the exported constants, so an absence check here can
 * never pass vacuously. */
const BUILT_IN_FLIGHT = [
  "with the airline(s) and any travel supplier shown in your itinerary.",
  "Changes and cancellations to airline tickets are governed by the fare rules of the ticket issued.",
];
const BUILT_IN_HOTEL = [
  "Changes to the dates, rooms or guests may change the price and are subject to availability.",
  "Where a refund is due, it is made to your original payment method and is limited to the amount you paid online.",
];

/** Everything of FlightBizz's that would identify it to Rental's customer. */
const FLIGHTBIZZ_MARKERS = [
  GV.brandName,
  GV.name,
  GV.supportEmail,
  GV.fromEmail,
  FLIGHTBIZZ_FLIGHT_TERMS,
  FLIGHTBIZZ_FLIGHT_POLICY,
];

/* Global suppliers, one per service. */
const AIRLINE_KEY = "DL";
const AIRLINE = "Delta Air Lines";
const HOTEL_SUPPLIER_KEY = "MARRIOTT";
const HOTEL_SUPPLIER = "Marriott";
/** The name the operator gives the flight's one charge. */
const FLIGHT_CHARGE = "Processing Fee";

const operator = actorFor(UserRole.ADMIN, { name: "Olivia Operator" });

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
const orgIds = {} as Record<OrgKey, Types.ObjectId>;
let envBefore: Record<string, string | undefined> = {};
let ipSeq = 0;

function uniqueIp(): string {
  ipSeq += 1;
  return `10.78.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
}

async function memberOf(orgId: Types.ObjectId) {
  await OrganizationMember.create({
    organizationId: orgId,
    userId: new Types.ObjectId(operator.id),
    role: operator.role,
    status: RecordState.ACTIVE,
  });
}

/** Rental as production stores it today: default, Stripe on the deployment
 *  account, MANUAL — and, removed with the raw driver so no Mongoose default
 *  stands in, no service list and no legal of its own. */
async function makeRentalConfirmation(): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: RC.slug,
    name: RC.brandName,
    brandName: RC.brandName,
    isDefault: true,
    payments: {
      provider: PaymentGatewayKey.STRIPE,
      enabledProviders: [PaymentGatewayKey.STRIPE],
      captureMode: CaptureMode.MANUAL,
    },
    support: { email: RC.supportEmail, phone: RC.supportPhone },
  });
  const id = doc._id as Types.ObjectId;
  await Organization.collection.updateOne(
    { _id: id },
    { $unset: { serviceTypes: "", legal: "" } },
  );
  await memberOf(id);
  return id;
}

async function makeFlightBizz(): Promise<Types.ObjectId> {
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

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

interface ApiError {
  ok: false;
  error: { code: string; message: string };
}

async function ok<T>(res: Response, status = 200): Promise<T> {
  const { status: got, body } = await jsonBody<{ ok: boolean; data: T }>(res);
  expect(got, JSON.stringify(body)).toBe(status);
  return body.data;
}

/** Admin → Settings in `key`'s organization (PATCH /api/admin/settings/legal). */
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
  return ok<Record<string, unknown>>(
    await legalGetRoute(
      buildRequest("/api/admin/settings/legal", { searchParams: { serviceType } }),
    ),
  );
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
  const touched = [
    ...Object.keys(WORLD_ENV),
    ...Object.keys(process.env).filter((k) => k.startsWith(RENTAL_ENV_PREFIX)),
  ];
  envBefore = Object.fromEntries(touched.map((k) => [k, process.env[k]]));
  for (const k of Object.keys(process.env)) {
    if (k.startsWith(RENTAL_ENV_PREFIX)) delete process.env[k];
  }
  Object.assign(process.env, WORLD_ENV);
  sentMail.length = 0;
  orgIds.rc = await makeRentalConfirmation();
  orgIds.gv = await makeFlightBizz();
  // Global suppliers (no organization restriction), one per service.
  await actingAs("gv");
  const suppliers = [
    { key: "BUDGET", name: "Budget", serviceType: ServiceType.CAR_RENTAL, logo: "/providers/budget.png", primaryColor: "#E8590C" },
    { key: AIRLINE_KEY, name: AIRLINE, serviceType: ServiceType.FLIGHT, logo: "/providers/_placeholder.svg", primaryColor: "#003366" },
    { key: HOTEL_SUPPLIER_KEY, name: HOTEL_SUPPLIER, serviceType: ServiceType.HOTEL, logo: "/providers/_placeholder.svg", primaryColor: "#8B1E3F" },
  ];
  for (const s of suppliers) {
    await createProvider(
      {
        key: s.key,
        name: s.name,
        logo: s.logo,
        primaryColor: s.primaryColor,
        onPrimaryColor: "#FFFFFF",
        tagline: "",
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
  for (const [k, before] of Object.entries(envBefore)) {
    if (before === undefined) delete process.env[k];
    else process.env[k] = before;
  }
  setNextHeaders({});
});

/* ------------------------------------------------------------------ *
 * The switch: scripts/set-organization-services.ts, as an operator runs it
 * ------------------------------------------------------------------ */

const SCRIPT = "scripts/set-organization-services.ts";
const ALL_THREE = [ServiceType.CAR_RENTAL, ServiceType.FLIGHT, ServiceType.HOTEL];

interface ScriptRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * `npx tsx scripts/set-organization-services.ts` with ORG_SLUG=
 * rentalconfirmation SERVICES=FLIGHT,HOTEL, against THIS file's database on
 * the in-memory server (asserted first) and nothing else: the runner's own
 * plumbing is left out, no --env-file, and `--no-install` keeps npx local.
 */
async function runSetOrganizationServices(knobs: { APPLY?: "1" } = {}): Promise<ScriptRun> {
  const uri = process.env.PAYOPS_IT_MONGO_URI ?? "";
  const dbName = mongoose.connection.db?.databaseName ?? "";
  expect(uri, "MONGODB_URI must be the in-memory server").toMatch(
    /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/?$/,
  );
  expect(dbName, "MONGODB_DB must be this file's own database").toMatch(/^it-[0-9a-f]{8}$/);
  expect(dbName).toBe(process.env.MONGODB_DB);

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) {
    if (k.startsWith("VITEST") || k === "NODE_OPTIONS") delete childEnv[k];
  }
  for (const k of ["APPLY", "REMOVE", "ALLOW_REMOVE", "SERVICES", "ORG_SLUG"]) delete childEnv[k];
  Object.assign(childEnv, {
    MONGODB_URI: uri,
    MONGODB_DB: dbName,
    ORG_SLUG: RC.slug,
    SERVICES: "FLIGHT,HOTEL",
    ...knobs,
  });

  return new Promise((resolve) => {
    execFile(
      "npx",
      ["--no-install", "tsx", SCRIPT],
      { cwd: process.cwd(), env: childEnv, timeout: 40_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

/** The script's report rows ("  • after          [CAR_RENTAL, …]"), by label. */
function reportOf(stdout: string): Record<string, string> {
  const rows: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*•\s+(organization|stored|before|after|enabling|disabling)\s+(.*)$/.exec(line);
    if (m) rows[m[1]!] = m[2]!.trim();
  }
  return rows;
}

/** An organization exactly as stored — raw driver — as plain JSON. */
async function rawOrg(key: OrgKey): Promise<Record<string, unknown>> {
  const doc = await Organization.collection.findOne({ slug: SLUG[key] });
  expect(doc, `organization ${SLUG[key]} is missing`).toBeTruthy();
  return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
}

function withoutKeys(doc: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc).filter(([k]) => !keys.includes(k)));
}

/** Enable Flight and Hotel for Rental with the real script (APPLY=1). */
async function enableFlightAndHotel(): Promise<void> {
  const run = await runSetOrganizationServices({ APPLY: "1" });
  expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect((await rawOrg("rc")).serviceTypes).toEqual(ALL_THREE);
}

/* ------------------------------------------------------------------ *
 * What the operator, the customer and Stripe do — real routes
 * ------------------------------------------------------------------ */

/** POST /api/orders as `key`'s operator — the raw reply. */
async function postOrder(key: OrgKey, body: unknown) {
  await actingAs(key);
  return jsonBody<{ ok: boolean; data?: { order: OrderDTO } } & Partial<ApiError>>(
    await createOrderRoute(buildRequest("/api/orders", { method: "POST", body })),
  );
}

async function submitOrder(key: OrgKey, body: unknown): Promise<OrderDTO> {
  const reply = await postOrder(key, body);
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  return reply.body.data!.order;
}

const flightBody = () =>
  validFlightOrderInput({ provider: AIRLINE_KEY, charges: flightServiceCharge(89, FLIGHT_CHARGE) });
const hotelBody = () =>
  validHotelOrderInput({
    provider: HOTEL_SUPPLIER_KEY,
    charges: [
      { name: "Room total", amount: 420, timing: PaymentTiming.PREPAID },
      { name: "City tax", amount: 30, timing: PaymentTiming.DUE_AT_COUNTER },
    ],
  });
const carBody = () => validCreateOrderInput();

interface StoredOrder {
  organizationId?: Types.ObjectId | null;
  serviceType: string;
  status: string;
  bookingStatus?: string | null;
  terms: { text: string; version: string };
  policy: { text: string; version: string };
  payment: {
    status: string;
    paidAt?: Date | null;
    amountReceived?: number | null;
    capture?: {
      method: string;
      status: string;
      amountAuthorized?: number | null;
      amountCaptured?: number | null;
      cancelReason?: string | null;
    } | null;
  };
}

async function storedOrder(orderId: string): Promise<StoredOrder> {
  const doc = await Order.findById(orderId).lean<StoredOrder | null>();
  expect(doc, `order ${orderId} was not stored`).toBeTruthy();
  return doc!;
}

/** The secret key of every Stripe client requested while `fn` runs — the
 *  stub answers any key, so this spy is what tells the accounts apart. */
async function stripeKeysDuring<T>(fn: () => Promise<T>): Promise<{ result: T; keys: string[] }> {
  const client = await import("@/server/payments/stripe");
  const spy = vi.spyOn(client, "getStripeFor");
  try {
    const result = await fn();
    return { result, keys: spy.mock.calls.map(([key]) => key) };
  } finally {
    spy.mockRestore();
  }
}

/** POST /api/orders/[id]/generate-payment-link — the composer's button. */
async function generateLink(orderId: string) {
  await actingAs("rc");
  const before = getCurrentTestStripe().sessionsCreated.length;
  const { result: res, keys } = await stripeKeysDuring(() =>
    generateLinkRoute(
      buildRequest(`/api/orders/${orderId}/generate-payment-link`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
  const data = await ok<{ order: OrderDTO }>(res);
  return {
    order: data.order,
    sessions: getCurrentTestStripe().sessionsCreated.slice(before),
    stripeKeys: keys,
  };
}

/** POST /api/orders/[id]/send-payment-request — the email actually sent. */
async function sendRequest(orderId: string) {
  await actingAs("rc");
  const mark = sentMail.length;
  await ok(
    await sendRequestRoute(
      buildRequest(`/api/orders/${orderId}/send-payment-request`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
  const sent = sentMail
    .slice(mark)
    .filter((m) => (m.headers as Record<string, string>)["X-Entity-Kind"] === EmailKind.PAYMENT_LINK);
  expect(sent, "expected exactly one PAYMENT_LINK email").toHaveLength(1);
  const m = sent[0]!;
  return {
    subject: String(m.subject),
    from: String(m.from ?? ""),
    transport: String(m.__transport ?? ""),
    html: String(m.html),
    text: String(m.text),
  };
}

/** A Stripe delivery to the DEPLOYMENT endpoint, signed with its secret. */
async function deliverToDeployment(event: Stripe.Event) {
  anonymous();
  const payload = JSON.stringify(event);
  const request = new Request(`http://localhost${DEPLOYMENT_ENDPOINT}`, {
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      "stripe-signature": signWebhook(payload, env.server.STRIPE_WEBHOOK_SECRET),
    }),
    body: payload,
  }) as never;
  const { result: res, keys } = await stripeKeysDuring(() => deploymentStripeWebhookRoute(request));
  const reply = await jsonBody<{ ok: boolean; data: Record<string, unknown> }>(res);
  return { ...reply, stripeKeys: keys };
}

const minor = (order: OrderDTO) => Math.round(order.pricing.amount * 100);

/** POST /api/orders/[id]/capture — "Capture payment". */
async function captureVia(orderId: string) {
  await actingAs("rc");
  const stub = getCurrentTestStripe();
  const before = stub.capturesRequested.length;
  const { result: res, keys } = await stripeKeysDuring(() =>
    captureRoute(
      buildRequest(`/api/orders/${orderId}/capture`, {
        method: "POST",
        body: {},
        headers: { "x-forwarded-for": uniqueIp() },
      }),
      idParams(orderId),
    ),
  );
  const reply = await jsonBody<{ ok: boolean; data?: { order: OrderDTO } } & Partial<ApiError>>(res);
  return { status: reply.status, json: reply.body, stripeKeys: keys, captures: stub.capturesRequested.slice(before) };
}

/** POST /api/orders/[id]/cancel-authorization — "Release hold". */
async function releaseVia(orderId: string, reason: string) {
  await actingAs("rc");
  const stub = getCurrentTestStripe();
  const before = stub.cancelsRequested.length;
  const { result: res, keys } = await stripeKeysDuring(() =>
    cancelAuthorizationRoute(
      buildRequest(`/api/orders/${orderId}/cancel-authorization`, {
        method: "POST",
        body: { reason },
        headers: { "x-forwarded-for": uniqueIp() },
      }),
      idParams(orderId),
    ),
  );
  const reply = await jsonBody<{ ok: boolean; data?: { order: OrderDTO } } & Partial<ApiError>>(res);
  return { status: reply.status, json: reply.body, stripeKeys: keys, cancels: stub.cancelsRequested.slice(before) };
}

/** The text a reader sees in rendered HTML. */
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
    .replace(/[­͏​-‏⁠﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The create-order page itself, as Rental's operator opens it. */
async function createPage(): Promise<string> {
  await actingAs("rc");
  const page = (await CreateOrderPage()) as ReactElement;
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: new QueryClient() }, page),
  );
}

/** The create page's service selector: each tab's label, and which is open. */
function tabsOf(html: string): { label: string; selected: boolean }[] {
  return [...html.matchAll(/<button\b([^>]*\brole="tab"[^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
    label: visibleText(m[2]!),
    selected: /aria-selected="true"/.test(m[1]!),
  }));
}

/** One service's panel on the create page (up to the next panel). */
function panelOf(html: string, serviceType: ServiceType): { active: boolean; text: string } {
  const starts = [...html.matchAll(/<div\b[^>]*\brole="tabpanel"[^>]*>/g)].map((m) => ({
    at: m.index!,
    tag: m[0],
  }));
  const i = starts.findIndex((st) => st.tag.includes(`-content-${serviceType}"`));
  expect(i, `no ${serviceType} panel on the create page`).toBeGreaterThanOrEqual(0);
  const end = i + 1 < starts.length ? starts[i + 1]!.at : html.length;
  return {
    active: !/\bhidden=""/.test(starts[i]!.tag) && /data-state="active"/.test(starts[i]!.tag),
    text: visibleText(html.slice(starts[i]!.at, end)),
  };
}

function expectNone(surface: string, markers: string[], what: string) {
  for (const marker of markers) {
    expect(surface.includes(marker), `${what} must not contain «${marker}»`).toBe(false);
  }
}

function expectAll(surface: string, markers: string[], what: string) {
  for (const marker of markers) {
    expect(surface.includes(marker), `${what} must contain «${marker}»`).toBe(true);
  }
}

/* ================================================================== *
 * 0. WORLD
 * ================================================================== */

describe("0. WORLD — Rental is stored as production stores it; FlightBizz beside it with its own flight terms", () => {
  it("0a. rentalconfirmation is the default organization on MANUAL capture with no service list and no legal; globevista sells all three with its own flight terms; every built-in marker line is in its constant", async () => {
    const rc = await rawOrg("rc");
    expect(rc).toMatchObject({
      slug: RC.slug,
      isDefault: true,
      payments: { provider: PaymentGatewayKey.STRIPE, captureMode: CaptureMode.MANUAL },
    });
    expect(rc).not.toHaveProperty("serviceTypes");
    expect(rc).not.toHaveProperty("legal");
    expect(DEPLOYMENT_ENDPOINT).toBe("/api/webhooks/stripe");

    const gv = await rawOrg("gv");
    expect(gv.serviceTypes).toEqual([ServiceType.FLIGHT, ServiceType.HOTEL, ServiceType.CAR_RENTAL]);
    const gvFlight = ((gv.legal as Record<string, unknown>).services as Record<string, Record<string, unknown>>).FLIGHT;
    expect(gvFlight.termsAndConditions).toBe(FLIGHTBIZZ_FLIGHT_TERMS_TEXT);

    for (const line of BUILT_IN_FLIGHT) {
      expect(DEFAULT_FLIGHT_TERMS_AND_CONDITIONS + DEFAULT_FLIGHT_CANCELLATION_POLICY).toContain(line);
    }
    for (const line of BUILT_IN_HOTEL) {
      expect(DEFAULT_HOTEL_TERMS_AND_CONDITIONS + DEFAULT_HOTEL_CANCELLATION_POLICY).toContain(line);
    }
    expect(DEPLOYMENT_CAR_TERMS_TEXT).toContain(CHARGED_TODAY);
  });
});

/* ================================================================== *
 * 1. SWITCH
 * ================================================================== */

describe("1. SWITCH — scripts/set-organization-services.ts gives Rental flights and hotels, keeping car rental first", () => {
  it("1a. before the switch Rental sells car rental only: a flight and a hotel are refused by name, a car rental is created", async () => {
    const flight = await postOrder("rc", flightBody());
    expect(flight.status).toBe(422);
    expect(flight.body.error?.message).toBe(
      "Rental Confirmation does not sell flights, so this order cannot be created for it.",
    );
    const hotel = await postOrder("rc", hotelBody());
    expect(hotel.status).toBe(422);
    expect(hotel.body.error?.message).toBe(
      "Rental Confirmation does not sell hotel stays, so this order cannot be created for it.",
    );
    expect(await Order.countDocuments({ serviceType: { $ne: ServiceType.CAR_RENTAL } })).toBe(0);
    const car = await submitOrder("rc", carBody());
    expect(car.serviceType).toBe(ServiceType.CAR_RENTAL);

    // The create page: the car form alone — no service selector.
    const page = await createPage();
    expect(page).not.toContain('role="tablist"');
    expect(visibleText(page)).toContain("Rental provider & vehicle");
    expect(visibleText(page)).not.toContain(AIRLINE);
  });

  it("1b. the dry run writes nothing; APPLY=1 stores [CAR_RENTAL, FLIGHT, HOTEL] and nothing else; a re-run changes nothing", async () => {
    const before = await rawOrg("rc");

    const dry = await runSetOrganizationServices();
    expect(dry.exitCode, `${dry.stdout}\n${dry.stderr}`).toBe(0);
    expect(reportOf(dry.stdout)).toMatchObject({
      stored: "(none stored — reads as [CAR_RENTAL])",
      before: "[CAR_RENTAL]",
      after: "[CAR_RENTAL, FLIGHT, HOTEL]",
      enabling: "[FLIGHT, HOTEL]",
      disabling: "[]",
    });
    expect(dry.stdout).toContain("dry run: no writes made");
    expect(await rawOrg("rc")).toEqual(before);

    const applied = await runSetOrganizationServices({ APPLY: "1" });
    expect(applied.exitCode, `${applied.stdout}\n${applied.stderr}`).toBe(0);
    expect(applied.stdout).toContain("✓ stored [CAR_RENTAL, FLIGHT, HOTEL]");
    const after = await rawOrg("rc");
    expect(after.serviceTypes).toEqual(ALL_THREE);
    // One field written: everything else — default flag, capture mode,
    // the absent legal, support contacts — byte-identical.
    expect(withoutKeys(after, ["serviceTypes", "updatedAt"])).toEqual(withoutKeys(before, ["updatedAt"]));
    expect(await rawOrg("gv")).toMatchObject({
      serviceTypes: [ServiceType.FLIGHT, ServiceType.HOTEL, ServiceType.CAR_RENTAL],
    });

    const again = await runSetOrganizationServices({ APPLY: "1" });
    expect(again.exitCode, `${again.stdout}\n${again.stderr}`).toBe(0);
    expect(again.stdout).toContain("nothing to change: no writes made");
    expect(await rawOrg("rc")).toEqual(after);
  }, 120_000);

  it("1c. after the switch Rental's create page offers Car rental | Flight | Hotel — car first and open — and each panel picks from its own suppliers", async () => {
    await enableFlightAndHotel();
    const page = await createPage();
    expect(page).toContain('role="tablist"');
    expect(tabsOf(page)).toEqual([
      { label: "Car rental", selected: true },
      { label: "Flight", selected: false },
      { label: "Hotel", selected: false },
    ]);
    const car = panelOf(page, ServiceType.CAR_RENTAL);
    const flight = panelOf(page, ServiceType.FLIGHT);
    const hotel = panelOf(page, ServiceType.HOTEL);
    expect([car.active, flight.active, hotel.active]).toEqual([true, false, false]);
    expect(car.text).toContain("Budget");
    expect(car.text).not.toContain(AIRLINE);
    expect(flight.text).toContain(AIRLINE);
    expect(flight.text).not.toContain(HOTEL_SUPPLIER);
    expect(hotel.text).toContain(HOTEL_SUPPLIER);
    expect(hotel.text).not.toContain(AIRLINE);
  }, 120_000);
});

/* ================================================================== *
 * 2. T&C
 * ================================================================== */

describe("2. T&C — each Rental order freezes ITS service's terms; Rental's car fix reaches only car rentals", () => {
  it("2a. a Rental flight freezes the built-in flight terms and policy, a hotel the built-in hotel text, a car rental the deployment car text — never FlightBizz's own flight text, never another service's", async () => {
    await enableFlightAndHotel();
    const flight = await storedOrder((await submitOrder("rc", flightBody())).id);
    expect(flight.serviceType).toBe(ServiceType.FLIGHT);
    expect(String(flight.organizationId)).toBe(String(orgIds.rc));
    expect(flight.terms).toEqual({
      text: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });
    expect(flight.policy).toMatchObject({
      text: DEFAULT_FLIGHT_CANCELLATION_POLICY,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });

    const hotel = await storedOrder((await submitOrder("rc", hotelBody())).id);
    expect(hotel.terms).toEqual({
      text: DEFAULT_HOTEL_TERMS_AND_CONDITIONS,
      version: DEFAULT_HOTEL_LEGAL_VERSION,
    });
    expect(hotel.policy).toMatchObject({
      text: DEFAULT_HOTEL_CANCELLATION_POLICY,
      version: DEFAULT_HOTEL_LEGAL_VERSION,
    });

    const car = await storedOrder((await submitOrder("rc", carBody())).id);
    expect(car.terms.text).toBe(DEPLOYMENT_CAR_TERMS_TEXT);
    expect(car.policy.text).toBe(DEPLOYMENT_CAR_POLICY_TEXT);

    for (const [what, order] of [["flight", flight], ["hotel", hotel], ["car", car]] as const) {
      const legal = `${order.terms.text}\n${order.policy.text}`;
      expectNone(legal, [FLIGHTBIZZ_FLIGHT_TERMS, FLIGHTBIZZ_FLIGHT_POLICY], `${what} T&C`);
      if (what !== "car") expectNone(legal, [DEPLOYMENT_CAR_TERMS, DEPLOYMENT_CAR_POLICY, CHARGED_TODAY], `${what} T&C`);
      if (what !== "flight") expectNone(legal, BUILT_IN_FLIGHT, `${what} T&C`);
      if (what !== "hotel") expectNone(legal, BUILT_IN_HOTEL, `${what} T&C`);
    }
  }, 120_000);

  it("2b. Rental's legal editors show what the next order freezes: the built-in flight and hotel text, and the inherited deployment car text", async () => {
    await enableFlightAndHotel();
    const flight = await readLegal("rc", ServiceType.FLIGHT);
    expect(flight).toMatchObject({
      brandName: RC.brandName,
      termsAndConditions: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
      termsVersion: DEFAULT_FLIGHT_LEGAL_VERSION,
      termsIsDefault: true,
      sellsFlight: true,
    });
    const hotel = await readLegal("rc", ServiceType.HOTEL);
    expect(hotel).toMatchObject({
      termsAndConditions: DEFAULT_HOTEL_TERMS_AND_CONDITIONS,
      termsVersion: DEFAULT_HOTEL_LEGAL_VERSION,
      termsIsDefault: true,
    });
    const car = await readLegal("rc", ServiceType.CAR_RENTAL);
    expect(car).toMatchObject({
      termsAndConditions: DEPLOYMENT_CAR_TERMS_TEXT,
      termsIsDefault: true,
      sellsCarRental: true,
    });
  }, 120_000);

  it("2c. Rental saves its own CAR terms (the 'charged today' fix): the next car rental freezes them at a new version, the earlier car rental keeps its text, and flights and hotels keep their built-in terms", async () => {
    await enableFlightAndHotel();
    const carBefore = await submitOrder("rc", carBody());
    const frozenBefore = (await storedOrder(carBefore.id)).terms;

    const saved = await saveLegal(
      "rc",
      ServiceType.CAR_RENTAL,
      DEPLOYMENT_CAR_TERMS_TEXT.replace(CHARGED_TODAY, HELD_UNTIL_CONFIRMED),
      DEPLOYMENT_CAR_POLICY_TEXT,
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const newVersion = String(saved.body.data.termsVersion);
    expect(newVersion).not.toBe(frozenBefore.version);
    // Written on Rental only: the deployment Settings text is untouched,
    // and FlightBizz's car rentals still inherit it (below).
    const deployment = await Setting.findOne({ key: "default" }).lean<{ termsAndConditions: string } | null>();
    expect(deployment?.termsAndConditions).toBe(DEPLOYMENT_CAR_TERMS_TEXT);

    const carAfter = (await storedOrder((await submitOrder("rc", carBody())).id)).terms;
    expect(carAfter.text).toContain(HELD_UNTIL_CONFIRMED);
    expect(carAfter.text).not.toContain(CHARGED_TODAY);
    expect(carAfter.version).toBe(newVersion);
    expect((await storedOrder(carBefore.id)).terms).toEqual(frozenBefore);

    const flight = (await storedOrder((await submitOrder("rc", flightBody())).id)).terms;
    expect(flight).toEqual({ text: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS, version: DEFAULT_FLIGHT_LEGAL_VERSION });
    const hotel = (await storedOrder((await submitOrder("rc", hotelBody())).id)).terms;
    expect(hotel).toEqual({ text: DEFAULT_HOTEL_TERMS_AND_CONDITIONS, version: DEFAULT_HOTEL_LEGAL_VERSION });

    const fbCar = (await storedOrder((await submitOrder("gv", carBody())).id)).terms;
    expect(fbCar.text).toBe(DEPLOYMENT_CAR_TERMS_TEXT);
  }, 120_000);
});

/* ================================================================== *
 * 3. PAYMENTS
 * ================================================================== */

describe("3. PAYMENTS — a Rental flight and hotel are holds on the DEPLOYMENT account, captured or released through the deployment endpoint", () => {
  it("3a. flight: the link asks Stripe for a manual hold ('Book', Rental's hold line) on the deployment key; the deployment endpoint authorizes it; Capture settles it PAID with one receipt queued — FlightBizz's key is never used", async () => {
    await enableFlightAndHotel();
    const deploymentKey = env.server.STRIPE_SECRET_KEY;
    const created = await submitOrder("rc", flightBody());
    const link = await generateLink(created.id);
    expect(link.sessions).toHaveLength(1);
    const params = link.sessions[0]!.params as Record<string, unknown>;
    expect((params.payment_intent_data as Record<string, unknown>).capture_method).toBe("manual");
    expect(params.submit_type).toBe("book");
    expect(params.custom_text).toEqual({
      submit: {
        message: `This places a hold on your card, not a charge. ${RC.brandName} collects the amount later and emails you a receipt when it does.`,
      },
    });
    expect(link.stripeKeys.length).toBeGreaterThan(0);
    expect(new Set(link.stripeKeys)).toEqual(new Set([deploymentKey]));
    expect(link.order.payment.capture).toMatchObject({
      method: CaptureMode.MANUAL,
      status: PaymentCaptureStatus.PENDING_AUTHORIZATION,
    });

    const order = link.order;
    const authorized = await deliverToDeployment(
      buildCheckoutCompleted({
        orderId: order.id,
        orderNumber: order.orderNumber,
        sessionId: order.payment.paymentSessionId!,
        paymentIntentId: order.payment.paymentIntentId!,
        amountTotal: minor(order),
        customerEmail: order.customer.email,
        paymentStatus: "unpaid",
      }),
    );
    expect(authorized.status, JSON.stringify(authorized.body)).toBe(200);
    expect(authorized.body.data).toMatchObject({ handled: true, orderId: order.id });
    expect(authorized.stripeKeys).toEqual([deploymentKey]);
    const held = await storedOrder(order.id);
    expect(held.payment.capture).toMatchObject({
      method: CaptureMode.MANUAL,
      status: PaymentCaptureStatus.AUTHORIZED,
      amountAuthorized: 89,
    });
    expect(held.payment.paidAt ?? null).toBeNull();
    expect(held.bookingStatus).toBe(BookingStatus.PENDING);

    const capture = await captureVia(order.id);
    expect(capture.status, JSON.stringify(capture.json)).toBe(200);
    expect(capture.captures).toHaveLength(1);
    expect(new Set(capture.stripeKeys)).toEqual(new Set([deploymentKey]));
    const paid = await storedOrder(order.id);
    expect(paid.status).toBe(OrderStatus.PAID);
    expect(paid.payment.capture).toMatchObject({
      status: PaymentCaptureStatus.CAPTURED,
      amountCaptured: 89,
    });
    expect(paid.bookingStatus).toBe(BookingStatus.CONFIRMED);
    expect(
      await PendingEmail.countDocuments({ orderId: new Types.ObjectId(order.id), kind: EmailKind.PAYMENT_CONFIRMATION }),
    ).toBe(1);

    for (const keys of [link.stripeKeys, authorized.stripeKeys, capture.stripeKeys]) {
      expect(keys).not.toContain(GV_STRIPE_SECRET_KEY);
    }
  }, 120_000);

  it("3b. hotel: the hold is authorized at the deployment endpoint for the prepaid room only, Release voids it ('abandoned', nothing captured), and the release queues nothing", async () => {
    await enableFlightAndHotel();
    const deploymentKey = env.server.STRIPE_SECRET_KEY;
    const created = await submitOrder("rc", hotelBody());
    const link = await generateLink(created.id);
    const params = link.sessions[0]!.params as Record<string, unknown>;
    expect((params.payment_intent_data as Record<string, unknown>).capture_method).toBe("manual");
    expect(new Set(link.stripeKeys)).toEqual(new Set([deploymentKey]));

    const order = link.order;
    expect(minor(order)).toBe(42000);
    const authorized = await deliverToDeployment(
      buildAmountCapturableUpdated({
        paymentIntentId: order.payment.paymentIntentId!,
        orderId: order.id,
        orderNumber: order.orderNumber,
        amountCapturable: minor(order),
      }),
    );
    expect(authorized.status, JSON.stringify(authorized.body)).toBe(200);
    expect((await storedOrder(order.id)).payment.capture).toMatchObject({
      status: PaymentCaptureStatus.AUTHORIZED,
      amountAuthorized: 420,
    });

    const queuedBefore = await PendingEmail.countDocuments({});
    const release = await releaseVia(order.id, "Guest changed plans");
    expect(release.status, JSON.stringify(release.json)).toBe(200);
    expect(release.cancels).toHaveLength(1);
    expect(release.cancels[0]!.id).toBe(order.payment.paymentIntentId);
    expect(release.cancels[0]!.params).toMatchObject({ cancellation_reason: "abandoned" });
    expect(new Set(release.stripeKeys)).toEqual(new Set([deploymentKey]));
    const released = await storedOrder(order.id);
    expect(released.payment.capture).toMatchObject({
      status: PaymentCaptureStatus.CANCELLED,
      cancelReason: "Guest changed plans",
    });
    expect(released.payment.capture?.amountCaptured ?? null).toBeNull();
    expect(released.status).not.toBe(OrderStatus.PAID);
    expect(await PendingEmail.countDocuments({})).toBe(queuedBefore);
    expect(release.stripeKeys).not.toContain(GV_STRIPE_SECRET_KEY);
  }, 120_000);
});

/* ================================================================== *
 * 4. EMAILS
 * ================================================================== */

describe("4. EMAILS — Rental's flight and hotel payment requests: deployment identity, an authorization subject, the service's own terms, nothing of FlightBizz", () => {
  it("4a. flight: sent under EMAIL_FROM on the deployment transport, 'Authorize your card for the Processing Fee • <order>', Rental's name and support contacts, the built-in flight terms and policy — no FlightBizz marker, no car or hotel terms", async () => {
    await enableFlightAndHotel();
    const created = await submitOrder("rc", flightBody());
    await generateLink(created.id);
    const email = await sendRequest(created.id);
    expect(email.transport).toBe("deployment");
    expect(email.from).toBe(env.server.EMAIL_FROM);
    expect(email.subject).toBe(`Authorize your card for the ${FLIGHT_CHARGE} • ${created.orderNumber}`);

    const seen = `${visibleText(email.html)}\n${email.text}`;
    expectAll(seen, [RC.brandName, RC.supportEmail, AIRLINE, ...BUILT_IN_FLIGHT], "flight request email");
    expect(seen).toMatch(/hold/i);
    expectNone(seen, FLIGHTBIZZ_MARKERS, "flight request email");
    expectNone(seen, [DEPLOYMENT_CAR_TERMS, DEPLOYMENT_CAR_POLICY, CHARGED_TODAY, ...BUILT_IN_HOTEL], "flight request email");
  }, 120_000);

  it("4b. hotel: 'Authorize your card for your Marriott booking • <order>', the built-in hotel terms and policy — no FlightBizz marker, no car or flight terms", async () => {
    await enableFlightAndHotel();
    const created = await submitOrder("rc", hotelBody());
    await generateLink(created.id);
    const email = await sendRequest(created.id);
    expect(email.transport).toBe("deployment");
    expect(email.from).toBe(env.server.EMAIL_FROM);
    expect(email.subject).toBe(`Authorize your card for your ${HOTEL_SUPPLIER} booking • ${created.orderNumber}`);

    const seen = `${visibleText(email.html)}\n${email.text}`;
    expectAll(seen, [RC.brandName, RC.supportEmail, ...BUILT_IN_HOTEL], "hotel request email");
    expect(seen).toMatch(/hold/i);
    expectNone(seen, FLIGHTBIZZ_MARKERS, "hotel request email");
    expectNone(seen, [DEPLOYMENT_CAR_TERMS, DEPLOYMENT_CAR_POLICY, CHARGED_TODAY, ...BUILT_IN_FLIGHT], "hotel request email");
  }, 120_000);
});
