import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Types } from "mongoose";
import type Stripe from "stripe";

import { POST as createOrderRoute } from "@/app/api/orders/route";
import { GET as getOrderRoute } from "@/app/api/orders/[id]/route";
import { POST as generateLinkRoute } from "@/app/api/orders/[id]/generate-payment-link/route";
import { POST as regenerateLinkRoute } from "@/app/api/orders/[id]/regenerate-link/route";
import { GET as evidenceRoute } from "@/app/api/orders/[id]/evidence/route";
import { POST as previewRoute } from "@/app/api/orders/[id]/payment-request-preview/route";
import { POST as sendRequestRoute } from "@/app/api/orders/[id]/send-payment-request/route";
import {
  GET as consentViewRoute,
  POST as confirmConsentRoute,
} from "@/app/api/consent/[token]/route";
import ConsentPage from "@/app/consent/[token]/page";
import PaymentSuccessPage from "@/app/pay/success/page";
import { OrderPaymentCard } from "@/components/features/orders/order-payment-card";
import {
  DEFAULT_FLIGHT_CHARGE_NAME,
  flightLabelsWithCharge,
} from "@/lib/charges";
import type { EmailTemplateKey } from "@/lib/constants/email-templates";
import {
  BookingType,
  CaptureMode,
  EmailKind,
  OrderEvidenceEventType,
  PaymentGatewayKey,
  PaymentTiming,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { Order, Organization, OrganizationMember } from "@/server/db/models";
import { orgCookieName } from "@/server/auth/org-cookie";
import { renderEmailPreview } from "@/server/email/preview";
import { _setPayPalFetchForTesting } from "@/server/payments/gateways/paypal";
import type { OrderEvidenceChainWithFlightDTO } from "@/server/services/evidence.service";
import { createProvider } from "@/server/services/provider.service";
import { createSettings } from "@/tests/factories/settings.factory";
import {
  oneWayConnectingFlightInput,
  validCreateOrderInput,
} from "@/tests/fixtures/order-input.fixture";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";
import type { OrderDTO, PublicConsentView } from "@/types";

/**
 * THE OPERATOR NAMES THE AMOUNT THE PAYMENT LINK COLLECTS — and the customer
 * reads exactly that name wherever the collected amount is labelled.
 *
 * A flight carries two separate amounts:
 *
 *   Airline Charge   $400   its own field (`flight.airlineFare`): part of the
 *                           booking value, NEVER collected, NEVER sent to
 *                           Stripe or PayPal, and never renamed.
 *   <charge name>    $100   the ONE charge line, named by the operator
 *                           ("Rental Cost", "Processing Fee", "Agency
 *                           Fee"…): the only money the payment link collects.
 *
 * so the customer reads
 *
 *   Airline Charge            $400.00   Not collected through this payment link
 *   Rental Cost               $100.00
 *   Total Booking Value       $500.00
 *   Amount Payable Now        $100.00
 *
 * The STORED name (`order.charges[0].name`) is the source of truth. Every
 * order here is made the way an operator makes it — POST /api/orders with the
 * create form's body, then the composer's link, preview and send routes — and
 * every assertion is on what was actually RENDERED or SENT: the composer
 * preview, the payment request that left through SMTP (HTML, plain text and
 * its "Confirm by email" mailto), the hosted consent page, the confirmation
 * and authorization emails the payment webhooks queue and the outbox
 * delivers, the /pay/success receipt, the operator's order card, and the
 * line item Stripe or PayPal is asked to charge.
 *
 * Car rentals keep their own per-line names and every rental string.
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

const { processGatewayEvent } = await import("@/server/services/webhook.service");
const { drainPendingEmails } = await import("@/server/services/email-outbox.service");

/* ------------------------------------------------------------------ *
 * The money, and the words the customer reads around it
 * ------------------------------------------------------------------ */

const AIRLINE_CHARGE = 400;
const COLLECTED = 100;

const PRICE_BREAKDOWN = "Price breakdown";
const AIRLINE_CHARGE_ROW = "Airline Charge";
const NOT_COLLECTED = "Not collected through this payment link";
const BOOKING_VALUE = "Total Booking Value";
const PAYABLE_NOW = "Amount Payable Now";
const EXPLAINER =
  "Airline Charge is shown for the total booking value and is not collected through this payment link.";
/** The hardcoded label this change removes — in any case, across a line break. */
const SERVICE_CHARGE = /service\s+charge/i;

/** Who and what a booking names — none of it is ever the charge's label. */
const CUSTOMER = "Grace Hopper"; // the fixture's customer
const OPERATOR = "Olivia Operator";
const AIRLINE = "Air India";
const PNR = "PNR7QX";
const ROUTE = "Delhi → Varanasi → Mumbai";
const DEPARTS = "Departs: Sat, Oct 10, 2026 10:30 AM • One way, 1 stop";

const operator = actorFor(UserRole.ADMIN, { name: OPERATOR });

/* ------------------------------------------------------------------ *
 * Three brands: Stripe (automatic capture, sells cars and flights),
 * Stripe on MANUAL capture (authorize first), and PayPal.
 * ------------------------------------------------------------------ */

const BRANDS = {
  skyfare: "SkyFare Travel",
  holdfare: "HoldFare Travel",
  payfare: "PayFare Travel",
} as const;

const ORG_ENV: Record<string, string> = {
  ORG_SKYFARE_STRIPE_SECRET_KEY: "sk_test_skyfare_only",
  ORG_SKYFARE_STRIPE_WEBHOOK_SECRET: "whsec_skyfare_only",
  ORG_HOLDFARE_STRIPE_SECRET_KEY: "sk_test_holdfare_only",
  ORG_HOLDFARE_STRIPE_WEBHOOK_SECRET: "whsec_holdfare_only",
  ORG_PAYFARE_PAYPAL_CLIENT_ID: "test-client-id",
  ORG_PAYFARE_PAYPAL_CLIENT_SECRET: "test-client-secret",
  ORG_PAYFARE_PAYPAL_WEBHOOK_ID: "TESTWEBHOOK",
  ORG_PAYFARE_PAYPAL_SANDBOX: "true",
};

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
let skyfare: Types.ObjectId;
let holdfare: Types.ObjectId;
let payfare: Types.ObjectId;
/** Every request body the PayPal API was sent, in order. */
let paypalBodies: Record<string, unknown>[] = [];
let eventSeq = 0;

async function makeOrg(opts: {
  slug: keyof typeof BRANDS;
  provider: PaymentGatewayKey;
  captureMode?: CaptureMode;
  serviceTypes: ServiceType[];
}): Promise<Types.ObjectId> {
  const brandName = BRANDS[opts.slug];
  const doc = await Organization.create({
    slug: opts.slug,
    name: opts.slug,
    brandName,
    isDefault: false,
    payments: {
      provider: opts.provider,
      ...(opts.captureMode ? { captureMode: opts.captureMode } : {}),
    },
    serviceTypes: opts.serviceTypes,
    email: {
      fromName: brandName,
      fromEmail: `no-reply@${opts.slug}.test`,
      replyTo: `help@${opts.slug}.test`,
    },
    support: { email: `support@${opts.slug}.test`, phone: "+442079460000" },
  });
  const id = doc._id as Types.ObjectId;
  await OrganizationMember.create({
    organizationId: id,
    userId: new Types.ObjectId(operator.id),
    role: operator.role,
    status: RecordState.ACTIVE,
  });
  return id;
}

/** The operator, signed in with `orgId` selected. */
async function actingAs(orgId: Types.ObjectId) {
  sessionMock?.restore();
  sessionMock = await mockSession(operator);
  setNextHeaders({ cookies: { [orgCookieName()]: String(orgId) } });
}

/** A customer's browser or a gateway's webhook: no session, no organization. */
function anonymous() {
  sessionMock?.restore();
  sessionMock = null;
  setNextHeaders({});
}

/** Minimal PayPal API: OAuth, then order creation — recording each body. */
function stubPayPal() {
  paypalBodies = [];
  _setPayPalFetchForTesting((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v1/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (init?.body) paypalBodies.push(JSON.parse(String(init.body)));
    const id = `PP-NAMED-${paypalBodies.length}`;
    return new Response(
      JSON.stringify({
        id,
        status: "PAYER_ACTION_REQUIRED",
        links: [
          {
            rel: "payer-action",
            href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`,
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch);
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  Object.assign(process.env, ORG_ENV);
  sentMail.length = 0;
  stubPayPal();
  skyfare = await makeOrg({
    slug: "skyfare",
    provider: PaymentGatewayKey.STRIPE,
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT],
  });
  holdfare = await makeOrg({
    slug: "holdfare",
    provider: PaymentGatewayKey.STRIPE,
    captureMode: CaptureMode.MANUAL,
    serviceTypes: [ServiceType.FLIGHT],
  });
  payfare = await makeOrg({
    slug: "payfare",
    provider: PaymentGatewayKey.PAYPAL,
    serviceTypes: [ServiceType.FLIGHT],
  });
  await actingAs(skyfare);
  await createProvider(
    {
      key: "AIRINDIA",
      name: AIRLINE,
      logo: "/providers/air-india.png",
      primaryColor: "#C8102E",
      onPrimaryColor: "#FFFFFF",
      tagline: "",
      sortOrder: 0,
      serviceTypes: [ServiceType.FLIGHT],
    } as Parameters<typeof createProvider>[0],
    { actor: operator },
  );
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  _setPayPalFetchForTesting(null);
  for (const k of Object.keys(ORG_ENV)) delete process.env[k];
  setNextHeaders({});
});

/* ------------------------------------------------------------------ *
 * Reading what the customer reads
 * ------------------------------------------------------------------ */

/**
 * The text a reader sees in rendered HTML: no head, no tags, entities and
 * React's text-node separators resolved, the inbox-preview padding dropped,
 * whitespace collapsed.
 */
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

/** An email's plain-text part, whitespace collapsed. */
function plainText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The money block of a rendered page or email: from its title to the end
 * of the Airline Charge explainer that closes it.
 */
function moneyBlock(html: string, title = PRICE_BREAKDOWN): string {
  const text = visibleText(html);
  const from = text.indexOf(title);
  expect(from, `no "${title}" block`).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(EXPLAINER, from);
  expect(to, `"${title}" does not end with the Airline Charge explainer`).toBeGreaterThan(from);
  return text.slice(from, to + EXPLAINER.length);
}

/** An EMAIL's flight rows, as read: label then amount — the airline row's
 *  note on the line under it. */
function emailMoney(chargeName: string, settledLabel: string): string {
  return [
    AIRLINE_CHARGE_ROW, "$400.00", NOT_COLLECTED,
    chargeName, "$100.00",
    BOOKING_VALUE, "$500.00",
    settledLabel, "$100.00",
    EXPLAINER,
  ].join(" ");
}

/** A PAGE's flight rows (receipt, consent page): the airline row's note sits
 *  inside its label, before the amount. */
function pageMoney(chargeName: string, settledLabel: string): string {
  return [
    AIRLINE_CHARGE_ROW, NOT_COLLECTED, "$400.00",
    chargeName, "$100.00",
    BOOKING_VALUE, "$500.00",
    settledLabel, "$100.00",
    EXPLAINER,
  ].join(" ");
}

/** The decoded "Confirm by email" mailto a payment request carries. */
function consentMailto(html: string): string {
  const mailtos = [...html.matchAll(/href="(mailto:[^"]+)"/g)].map((m) =>
    decodeURIComponent(m[1]!.replace(/&amp;/g, "&")),
  );
  const consent = mailtos.find((m) => m.includes("Acknowledgement"));
  expect(consent, "the payment request has no consent mailto").toBeTruthy();
  return consent!;
}

interface SentEmail {
  subject: string;
  html: string;
  text: string;
}

function lastSent(kind: EmailKind): SentEmail {
  const msg = [...sentMail]
    .reverse()
    .find((m) => (m.headers as Record<string, string>)["X-Entity-Kind"] === kind);
  expect(msg, `no ${kind} email was sent`).toBeTruthy();
  return { subject: String(msg!.subject), html: String(msg!.html), text: String(msg!.text) };
}

/** Every value under a key that names money (`unit_amount`, `amount`, …),
 *  anywhere in a gateway request. */
function amountsIn(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) =>
    /amount/i.test(key) ? [v] : amountsIn(v),
  );
}

/* ------------------------------------------------------------------ *
 * What the operator does — through the real route handlers
 * ------------------------------------------------------------------ */

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

async function ok<T>(res: Response, status = 200): Promise<T> {
  const { status: got, body } = await jsonBody<{ ok: boolean; data: T }>(res);
  expect(got, JSON.stringify(body)).toBe(status);
  return body.data;
}

/**
 * A new flight exactly as the create form submits it: the airline charge
 * ($400) in its own field, and ONE charge — named `chargeName`, $100 — that
 * the payment link collects. Air India, Delhi → Varanasi → Mumbai, PNR set.
 */
function flightForm(chargeName: string) {
  return oneWayConnectingFlightInput(
    {
      provider: "AIRINDIA",
      charges: [{ name: chargeName, amount: COLLECTED, timing: PaymentTiming.PREPAID }],
    },
    { airlineFare: AIRLINE_CHARGE, pnr: PNR },
  );
}

/** POST /api/orders — what the create form's submit does. */
async function submitOrder(orgId: Types.ObjectId, body: unknown): Promise<OrderDTO> {
  await actingAs(orgId);
  const { order } = await ok<{ order: OrderDTO }>(
    await createOrderRoute(buildRequest("/api/orders", { method: "POST", body })),
    201,
  );
  return order;
}

/** POST /api/orders/[id]/generate-payment-link — the composer's first step.
 *  Returns the gateway request it made when the brand is on Stripe. */
async function generateLink(orgId: Types.ObjectId, orderId: string) {
  await actingAs(orgId);
  const before = getCurrentTestStripe().sessionsCreated.length;
  const { order } = await ok<{ order: OrderDTO }>(
    await generateLinkRoute(
      buildRequest(`/api/orders/${orderId}/generate-payment-link`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
  const sessions = getCurrentTestStripe().sessionsCreated;
  const stripe = sessions.length > before ? sessions.at(-1)!.params : null;
  return { order, stripe };
}

/** POST /api/orders/[id]/payment-request-preview — the composer's preview. */
async function composerPreview(orgId: Types.ObjectId, orderId: string): Promise<string> {
  await actingAs(orgId);
  const { html } = await ok<{ html: string }>(
    await previewRoute(
      buildRequest(`/api/orders/${orderId}/payment-request-preview`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
  return html;
}

/** POST /api/orders/[id]/send-payment-request — the email actually sent. */
async function sendRequest(orgId: Types.ObjectId, orderId: string) {
  await actingAs(orgId);
  const data = await ok<{ order: OrderDTO; sent: { consentToken: string | null } }>(
    await sendRequestRoute(
      buildRequest(`/api/orders/${orderId}/send-payment-request`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
  return {
    order: data.order,
    consentToken: data.sent.consentToken,
    email: lastSent(EmailKind.PAYMENT_LINK),
  };
}

/** GET /api/orders/[id] — what the operator's order detail page loads. */
async function orderApi(orgId: Types.ObjectId, orderId: string): Promise<OrderDTO> {
  await actingAs(orgId);
  return ok<OrderDTO>(await getOrderRoute(buildRequest(`/api/orders/${orderId}`), idParams(orderId)));
}

/** The order detail page's payment card, rendered from the order API. */
function orderCard(order: OrderDTO): string {
  return renderToStaticMarkup(<OrderPaymentCard order={order} canRegenerate={false} />);
}

/** The order exactly as stored. */
async function stored(orderId: string) {
  const doc = await Order.findById(orderId).lean<{
    charges: { name: string; amount: number; timing: string }[];
    pricing: { amount: number; currency: string };
    flight: { airlineFare: number | null } | null;
  } | null>();
  expect(doc, `order ${orderId} was not stored`).toBeTruthy();
  return doc!;
}

/* ------------------------------------------------------------------ *
 * What the customer and the gateway do
 * ------------------------------------------------------------------ */

/** /consent/[token] — the hosted page the email's button opens. */
async function consentPage(token: string): Promise<string> {
  anonymous();
  return renderToStaticMarkup(await ConsentPage({ params: Promise.resolve({ token }) }));
}

/** The customer signs and confirms on that page (GET, then POST /api/consent/[token]). */
async function confirmConsent(token: string) {
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
        body: { acknowledgement: view.consentMessage, signedName: CUSTOMER },
      }),
      { params: Promise.resolve({ token }) },
    ),
  );
}

/** A gateway delivery to the brand's webhook endpoint, then the outbox run
 *  that delivers the email it queued — exactly as the background job does. */
async function webhookThenOutbox(
  orgId: Types.ObjectId,
  order: OrderDTO,
  type: "checkout.completed" | "payment.authorized",
): Promise<void> {
  anonymous();
  eventSeq += 1;
  const result = await processGatewayEvent(
    {
      eventId: `evt_charge_name_${eventSeq}`,
      type,
      sessionId: order.payment.paymentSessionId,
      orderId: order.id,
      paymentIntentId: order.payment.paymentIntentId,
      amountTotalMinor: Math.round(order.pricing.amount * 100),
      occurredAtMs: Date.now(),
      authorization:
        type === "payment.authorized"
          ? {
              paymentIntentId: order.payment.paymentIntentId,
              captureMethod: "manual",
              paymentIntentStatus: "requires_capture",
              amountCapturableMinor: Math.round(order.pricing.amount * 100),
              amountReceivedMinor: 0,
              cancellationReason: null,
            }
          : null,
      raw: {},
    },
    String(orgId),
  );
  expect(result.handled, JSON.stringify(result)).toBe(true);
  const drained = await drainPendingEmails(10);
  expect(drained.sent, JSON.stringify(drained)).toBe(1);
}

/** /pay/success — where the gateway returns the customer. */
async function receiptPage(order: OrderDTO): Promise<string> {
  anonymous();
  return renderToStaticMarkup(
    await PaymentSuccessPage({
      searchParams: Promise.resolve({
        order: order.orderNumber,
        session_id: order.payment.paymentSessionId!,
      }),
    }),
  );
}

type StripeLineItem = NonNullable<Stripe.Checkout.SessionCreateParams["line_items"]>[number];

function onlyLineItem(params: Stripe.Checkout.SessionCreateParams | null): StripeLineItem {
  expect(params, "Stripe was never asked for a checkout session").toBeTruthy();
  const items = params!.line_items ?? [];
  expect(items).toHaveLength(1);
  return items[0]!;
}

/* ------------------------------------------------------------------ *
 * Whole journeys
 * ------------------------------------------------------------------ */

/**
 * An automatic-capture brand, start to finish: the operator creates the
 * flight, generates the link, previews and sends the request; the customer
 * opens the consent page and confirms; the operator re-sends (now a direct
 * pay button); the payment webhook settles it and the outbox sends the
 * confirmation; the customer lands on the receipt.
 */
async function paidJourney(chargeName: string) {
  const created = await submitOrder(skyfare, flightForm(chargeName));
  const { stripe } = await generateLink(skyfare, created.id);
  const preview = await composerPreview(skyfare, created.id);
  const sent = await sendRequest(skyfare, created.id);
  expect(sent.consentToken, "the send recorded no consent request").toBeTruthy();
  const consent = await consentPage(sent.consentToken!);
  await confirmConsent(sent.consentToken!);
  const previewAfterConsent = await composerPreview(skyfare, created.id);
  const resent = await sendRequest(skyfare, created.id);
  await webhookThenOutbox(skyfare, sent.order, "checkout.completed");
  const confirmation = lastSent(EmailKind.PAYMENT_CONFIRMATION);
  const receipt = await receiptPage(sent.order);
  const detail = await orderApi(skyfare, created.id);
  return {
    created,
    lineItem: onlyLineItem(stripe),
    preview,
    request: sent.email,
    consent,
    previewAfterConsent,
    resent: resent.email,
    confirmation,
    receipt,
    detail,
    card: orderCard(detail),
  };
}

/**
 * A manual-capture brand: the customer's card is AUTHORIZED, not charged —
 * the webhook queues the authorization email and the receipt says "on hold".
 */
async function heldJourney(chargeName: string) {
  const created = await submitOrder(holdfare, flightForm(chargeName));
  const { stripe } = await generateLink(holdfare, created.id);
  const sent = await sendRequest(holdfare, created.id);
  await webhookThenOutbox(holdfare, sent.order, "payment.authorized");
  const authorized = lastSent(EmailKind.PAYMENT_AUTHORIZED);
  const receipt = await receiptPage(sent.order);
  const detail = await orderApi(holdfare, created.id);
  return {
    created,
    stripe,
    lineItem: onlyLineItem(stripe),
    authorized,
    receipt,
    detail,
    card: orderCard(detail),
  };
}

/**
 * Acceptance tests 1–3: the operator's charge name — and never "Service
 * Charge" — on every surface that labels the collected amount, with its
 * amount, in its place among the four rows.
 */
async function expectCustomerSeesChargeName(name: string) {
  const paid = await paidJourney(name);
  const held = await heldJourney(name);

  // The persisted name is the source of truth — stored as typed, served as stored.
  const line = { name, amount: COLLECTED, timing: PaymentTiming.PREPAID };
  expect((await stored(paid.created.id)).charges).toEqual([line]);
  expect((await stored(held.created.id)).charges).toEqual([line]);
  expect(paid.detail.charges).toEqual([line]);

  // EMAILS — the named row with its amount, between the airline charge and
  // the booking value; the last row is what the email says happened to it.
  const requestRows = `${PRICE_BREAKDOWN} ${emailMoney(name, PAYABLE_NOW)}`;
  expect(moneyBlock(paid.preview), "composer preview").toBe(requestRows);
  expect(moneyBlock(paid.request.html), "payment request as sent").toBe(requestRows);
  expect(moneyBlock(paid.previewAfterConsent), "preview after consent").toBe(requestRows);
  expect(moneyBlock(paid.resent.html), "payment request re-sent").toBe(requestRows);
  expect(moneyBlock(paid.confirmation.html), "confirmation").toBe(
    `${PRICE_BREAKDOWN} ${emailMoney(name, `${name} Paid`)}`,
  );
  expect(moneyBlock(held.authorized.html), "authorization").toBe(
    `${PRICE_BREAKDOWN} ${emailMoney(name, `${name} On Hold`)}`,
  );
  // …and the same rows in each email's plain-text part.
  expect(plainText(paid.request.text)).toContain(emailMoney(name, PAYABLE_NOW));
  expect(plainText(paid.confirmation.text)).toContain(emailMoney(name, `${name} Paid`));
  expect(plainText(held.authorized.text)).toContain(emailMoney(name, `${name} On Hold`));

  // Every sentence and label about the collected amount uses the name.
  const request = visibleText(paid.request.html);
  expect(request).toContain(`Complete payment for ${paid.created.orderNumber} — $100.00 ${name}`);
  // …and so do the subject and every button that asks for the money —
  // never the airline: the request's consent button, the consent page's
  // submit button, then (once consented) the pay button.
  expect(paid.request.subject).toBe(`Complete your ${name} payment • ${paid.created.orderNumber}`);
  expect(paid.request.subject).not.toContain(AIRLINE);
  expect(request).toContain(`Review & pay $100.00 ${name}`);
  expect(visibleText(paid.consent)).toContain(`Confirm & pay $100.00 ${name}`);
  expect(request).toContain(`please pay the ${name} using the secure link below to confirm it.`);
  expect(request).toContain(`${PAYABLE_NOW} $100.00 ${name} Order`);
  for (const html of [paid.previewAfterConsent, paid.resent.html]) {
    expect(visibleText(html)).toContain(`Pay the $100.00 ${name} securely with Stripe →`);
  }
  const confirmation = visibleText(paid.confirmation.html);
  expect(confirmation).toContain(`We've received your ${name} payment for new booking`);
  expect(confirmation).toContain(`${name} Paid $100.00 Order`);
  const authorized = visibleText(held.authorized.html);
  expect(authorized).toContain(`Your card has been authorized for the $100.00 ${name} — this is a hold`);
  expect(authorized).toContain(
    `Once it's confirmed we charge exactly the $100.00 ${name} — not a penny more`,
  );
  expect(authorized).toContain(`Your bank may show the $100.00 ${name} as pending until then.`);
  expect(authorized).toContain(`${name} On Hold $100.00`);

  // The request's "Confirm by email" fallback lists the same four rows.
  const mailto = consentMailto(paid.request.html);
  expect(mailto).toContain(
    [
      "Airline Charge: 400.00 USD (not collected through this payment link)",
      `${name}: 100.00 USD`,
      "Total Booking Value: 500.00 USD",
      "Amount Payable Now: 100.00 USD",
    ].join("\n"),
  );

  // PAGES — the consent page the customer confirms on, and the receipt
  // (paid; then, on a manual-capture brand, on hold).
  expect(moneyBlock(paid.consent, "Booking summary"), "consent page").toBe(
    `Booking summary ${PAYABLE_NOW} $100.00 ${name} New booking ${pageMoney(name, PAYABLE_NOW)}`,
  );
  expect(moneyBlock(paid.receipt), "receipt").toBe(
    `${PRICE_BREAKDOWN} ${pageMoney(name, `${name} Paid`)}`,
  );
  expect(visibleText(paid.receipt)).toContain(
    `${BRANDS.skyfare} has confirmed your ${name} payment and a receipt is on its way to your inbox. ${name} Paid $100.00`,
  );
  expect(moneyBlock(held.receipt), "receipt on hold").toBe(
    `${PRICE_BREAKDOWN} ${pageMoney(name, `${name} On Hold`)}`,
  );
  expect(visibleText(held.receipt)).toContain(
    `${BRANDS.holdfare} has placed a hold on your card for the ${name} of $100.00.`,
  );

  // The operator's order detail shows the same name for the same row.
  for (const card of [paid.card, held.card]) {
    expect(visibleText(card)).toContain(
      `${AIRLINE_CHARGE_ROW} $400.00 ${NOT_COLLECTED} ${name} $100.00 ${BOOKING_VALUE} $500.00`,
    );
  }

  // The CHECKOUT page (Stripe, both capture modes): the line item leads with
  // the name, and charges the $100.00 only.
  for (const item of [paid.lineItem, held.lineItem]) {
    expect(item.price_data!.unit_amount).toBe(10000);
    expect(item.price_data!.product_data!.name).toBe(`${name} • ${AIRLINE} • ${ROUTE}`);
    expect(item.price_data!.product_data!.description).toBe(`${name} • ${DEPARTS}`);
  }
  expect(held.stripe!.payment_intent_data?.capture_method).toBe("manual");

  // And nobody reads "Service Charge" — on no customer surface, in no part
  // of any email, not on the checkout page, not on the operator's card.
  const everywhere: Record<string, string> = {
    "composer preview": paid.preview,
    "composer preview after consent": paid.previewAfterConsent,
    "payment request (html)": paid.request.html,
    "payment request (text)": paid.request.text,
    "payment request (subject)": paid.request.subject,
    "payment request re-sent (html)": paid.resent.html,
    "payment request re-sent (text)": paid.resent.text,
    "consent mailto": mailto,
    "consent page": paid.consent,
    "confirmation (html)": paid.confirmation.html,
    "confirmation (text)": paid.confirmation.text,
    "confirmation (subject)": paid.confirmation.subject,
    "authorization (html)": held.authorized.html,
    "authorization (text)": held.authorized.text,
    "authorization (subject)": held.authorized.subject,
    receipt: paid.receipt,
    "receipt on hold": held.receipt,
    "order detail card": paid.card,
    "order detail card on hold": held.card,
    "Stripe line item": JSON.stringify(paid.lineItem),
    "Stripe line item (manual capture)": JSON.stringify(held.lineItem),
  };
  for (const [where, content] of Object.entries(everywhere)) {
    expect(content, `${where} says "service charge"`).not.toMatch(SERVICE_CHARGE);
  }
}

/* ------------------------------------------------------------------ *
 * 1–3. The customer sees the operator's name
 * ------------------------------------------------------------------ */

describe("1–3. the operator names the charge — the customer sees that name on every surface", () => {
  it("1. charge name 'Rental Cost' → the customer sees 'Rental Cost' (preview, sent emails, consent page, receipt, checkout)", async () => {
    await expectCustomerSeesChargeName("Rental Cost");
  });

  it("2. charge name 'Processing Fee' → the customer sees 'Processing Fee'", async () => {
    await expectCustomerSeesChargeName("Processing Fee");
  });

  it("3. charge name 'Agency Fee' → the customer sees 'Agency Fee'", async () => {
    await expectCustomerSeesChargeName("Agency Fee");
  });
});

describe("the label comes from the charge itself", () => {
  it("never from the customer, the agent, the organization, the airline or the booking reference", async () => {
    const journey = await paidJourney("Agency Fee");
    const blocks: Record<string, string> = {
      "composer preview": moneyBlock(journey.preview),
      "payment request": moneyBlock(journey.request.html),
      confirmation: moneyBlock(journey.confirmation.html),
      "consent page": moneyBlock(journey.consent, "Booking summary"),
      receipt: moneyBlock(journey.receipt),
    };
    const notLabels = [
      CUSTOMER,
      OPERATOR,
      BRANDS.skyfare,
      AIRLINE,
      PNR,
      journey.created.orderNumber,
    ];
    for (const [where, block] of Object.entries(blocks)) {
      expect(block, where).toContain("Agency Fee $100.00");
      for (const other of notLabels) {
        expect(block, `${where}'s money block shows "${other}"`).not.toContain(other);
      }
    }
    // On the checkout page the charge's name comes first; the airline and
    // route only describe the trip after it.
    const product = journey.lineItem.price_data!.product_data!;
    expect(product.name.split(" • ")[0]).toBe("Agency Fee");
    expect(product.description!.split(" • ")[0]).toBe("Agency Fee");
  });

  it("a blank charge name is stored as the default 'Service Charge' — the stored name is what the customer reads", async () => {
    const order = await submitOrder(skyfare, flightForm("   "));
    expect((await stored(order.id)).charges).toEqual([
      { name: DEFAULT_FLIGHT_CHARGE_NAME, amount: COLLECTED, timing: PaymentTiming.PREPAID },
    ]);
    const { stripe } = await generateLink(skyfare, order.id);
    expect(moneyBlock(await composerPreview(skyfare, order.id))).toBe(
      `${PRICE_BREAKDOWN} ${emailMoney(DEFAULT_FLIGHT_CHARGE_NAME, PAYABLE_NOW)}`,
    );
    expect(onlyLineItem(stripe).price_data!.product_data!.name).toBe(
      `${DEFAULT_FLIGHT_CHARGE_NAME} • ${AIRLINE} • ${ROUTE}`,
    );
  });
});

/* ------------------------------------------------------------------ *
 * 4. Changing the name
 * ------------------------------------------------------------------ */

describe("4. changing the charge name changes the preview and the actual email", () => {
  it("the same booking named 'Rental Cost', then renamed 'Processing Fee': each order's preview and sent email carry its own name — never the other's", async () => {
    // The operator fills the form, names the charge "Rental Cost" and sends;
    // then submits the same booking again with only the name changed.
    const first = await submitOrder(skyfare, flightForm("Rental Cost"));
    const renamed = await submitOrder(skyfare, flightForm("Processing Fee"));

    const runs = [];
    for (const [order, name, other] of [
      [first, "Rental Cost", "Processing Fee"],
      [renamed, "Processing Fee", "Rental Cost"],
    ] as const) {
      await generateLink(skyfare, order.id);
      const preview = await composerPreview(skyfare, order.id);
      const { email } = await sendRequest(skyfare, order.id);
      runs.push({ order, name, other, preview, email });
    }

    for (const { order, name, other, preview, email } of runs) {
      expect((await stored(order.id)).charges[0]!.name).toBe(name);
      const rows = `${PRICE_BREAKDOWN} ${emailMoney(name, PAYABLE_NOW)}`;
      expect(moneyBlock(preview), `${name}: preview`).toBe(rows);
      expect(moneyBlock(email.html), `${name}: sent email`).toBe(rows);
      expect(plainText(email.text), `${name}: sent email (text)`).toContain(
        emailMoney(name, PAYABLE_NOW),
      );
      expect(visibleText(preview)).toContain(`please pay the ${name} using the secure link`);
      expect(visibleText(email.html)).toContain(`please pay the ${name} using the secure link`);
      expect(consentMailto(email.html)).toContain(`${name}: 100.00 USD`);
      for (const [where, content] of Object.entries({
        preview,
        "sent email (html)": email.html,
        "sent email (text)": email.text,
        "consent mailto": consentMailto(email.html),
      })) {
        expect(content, `${name}: ${where} still says "${other}"`).not.toContain(other);
        expect(content, `${name}: ${where} says "service charge"`).not.toMatch(SERVICE_CHARGE);
      }
    }

    // Each order keeps its own name: the first order's preview, rendered
    // again after the rename, still says "Rental Cost".
    expect(moneyBlock(await composerPreview(skyfare, first.id))).toBe(
      `${PRICE_BREAKDOWN} ${emailMoney("Rental Cost", PAYABLE_NOW)}`,
    );
  });
});

/* ------------------------------------------------------------------ *
 * 5. Only the label changes — never the amount
 * ------------------------------------------------------------------ */

describe("5. only the label changes — Stripe and PayPal are asked for exactly the same amount", () => {
  const NAMES = ["Service Charge", "Rental Cost", "Processing Fee"] as const;

  it("Stripe: unit_amount 10000 whatever the charge is called; only the line item's name and description change, both leading with the name", async () => {
    const runs = [];
    for (const name of NAMES) {
      const order = await submitOrder(skyfare, flightForm(name));
      const { stripe } = await generateLink(skyfare, order.id);
      runs.push({ name, order, params: stripe! });
    }
    expect(getCurrentTestStripe().sessionsCreated).toHaveLength(NAMES.length);

    for (const { name, order, params } of runs) {
      expect(order.pricing).toEqual({ amount: COLLECTED, currency: "USD" });
      expect(order.charges).toEqual([
        { name, amount: COLLECTED, timing: PaymentTiming.PREPAID },
      ]);
      const item = onlyLineItem(params);
      expect(item.quantity).toBe(1);
      expect(item.price_data!.unit_amount).toBe(10000);
      expect(item.price_data!.currency).toBe("usd");
      // The only money in the whole request.
      expect(amountsIn(params)).toEqual([10000]);
      expect(item.price_data!.product_data!.name.startsWith(`${name} • `)).toBe(true);
      expect(item.price_data!.product_data!.description!.startsWith(`${name} • `)).toBe(true);
    }
    // Take the name out and the three line items are identical.
    const withoutName = runs.map(({ name, params }) =>
      JSON.stringify(params.line_items).split(name).join("<charge name>"),
    );
    expect(new Set(withoutName).size).toBe(1);
  });

  it("PayPal: value '100.00' whatever the charge is called; only the purchase description changes, leading with the name", async () => {
    for (const name of NAMES) {
      const order = await submitOrder(payfare, flightForm(name));
      const { order: linked } = await generateLink(payfare, order.id);
      expect(linked.payment.gateway).toBe(PaymentGatewayKey.PAYPAL);
      expect(linked.pricing).toEqual({ amount: COLLECTED, currency: "USD" });
    }
    const created = paypalBodies.filter((b) => "purchase_units" in b) as Array<{
      purchase_units: { description: string; amount: { currency_code: string; value: string } }[];
    }>;
    expect(created).toHaveLength(NAMES.length);

    created.forEach((body, i) => {
      const name = NAMES[i]!;
      expect(body.purchase_units).toHaveLength(1);
      expect(body.purchase_units[0]!.amount).toEqual({ currency_code: "USD", value: "100.00" });
      // The only money in the whole request.
      expect(amountsIn(body)).toEqual([{ currency_code: "USD", value: "100.00" }]);
      expect(body.purchase_units[0]!.description).toBe(`${name} • ${DEPARTS}`);
    });
    const withoutName = created.map((b, i) =>
      b.purchase_units[0]!.description.split(NAMES[i]!).join("<charge name>"),
    );
    expect(new Set(withoutName).size).toBe(1);
    expect(getCurrentTestStripe().sessionsCreated).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 6. The Airline Charge — separate, shown, never collected
 * ------------------------------------------------------------------ */

describe("6. the Airline Charge stays separate and is never sent to the gateway", () => {
  it("is stored on the flight, never as a charge line: the one line is the operator's charge, and pricing.amount is that charge alone", async () => {
    const order = await submitOrder(skyfare, flightForm("Rental Cost"));
    const doc = await stored(order.id);
    expect(doc.charges).toEqual([
      { name: "Rental Cost", amount: COLLECTED, timing: PaymentTiming.PREPAID },
    ]);
    expect(doc.flight!.airlineFare).toBe(AIRLINE_CHARGE);
    expect(doc.pricing.amount).toBe(COLLECTED);
    expect(doc.pricing.amount).not.toBe(AIRLINE_CHARGE + COLLECTED);
  });

  it.each(["Stripe", "PayPal"] as const)(
    "%s is sent only the $100.00 charge — never the airline charge (400) or the booking value (500)",
    async (gateway) => {
      const org = gateway === "Stripe" ? skyfare : payfare;
      const order = await submitOrder(org, flightForm("Rental Cost"));
      const { stripe } = await generateLink(org, order.id);

      if (gateway === "Stripe") {
        expect(amountsIn(stripe)).toEqual([10000]);
        const items = JSON.stringify(stripe!.line_items);
        for (const figure of ["40000", "50000", "400.00", "500.00"]) {
          expect(items).not.toContain(figure);
        }
        for (const figure of ["400.00", "500.00"]) {
          expect(JSON.stringify(stripe)).not.toContain(figure);
        }
        expect(items).not.toContain(AIRLINE_CHARGE_ROW);
      } else {
        const created = paypalBodies.find((b) => "purchase_units" in b);
        expect(created, "PayPal order was never created").toBeTruthy();
        expect(amountsIn(created)).toEqual([{ currency_code: "USD", value: "100.00" }]);
        const sent = JSON.stringify(created);
        for (const figure of ["400.00", "500.00"]) {
          expect(sent).not.toContain(figure);
        }
        expect(sent).not.toContain(AIRLINE_CHARGE_ROW);
        expect(getCurrentTestStripe().sessionsCreated).toHaveLength(0);
      }
    },
  );

  it("the customer sees Airline Charge $400.00 (not collected), Rental Cost $100.00, Total Booking Value $500.00, Amount Payable Now $100.00", async () => {
    const order = await submitOrder(skyfare, flightForm("Rental Cost"));
    await generateLink(skyfare, order.id);
    const preview = await composerPreview(skyfare, order.id);
    const { email, consentToken } = await sendRequest(skyfare, order.id);
    const consent = await consentPage(consentToken!);

    const rows = emailMoney("Rental Cost", PAYABLE_NOW);
    expect(rows).toBe(
      "Airline Charge $400.00 Not collected through this payment link Rental Cost $100.00 Total Booking Value $500.00 Amount Payable Now $100.00 " +
        EXPLAINER,
    );
    expect(moneyBlock(preview)).toBe(`${PRICE_BREAKDOWN} ${rows}`);
    expect(moneyBlock(email.html)).toBe(`${PRICE_BREAKDOWN} ${rows}`);
    expect(plainText(email.text)).toContain(rows);
    expect(moneyBlock(consent, "Booking summary")).toBe(
      `Booking summary ${PAYABLE_NOW} $100.00 Rental Cost New booking ${pageMoney("Rental Cost", PAYABLE_NOW)}`,
    );
    expect(consentMailto(email.html)).toContain(
      "Airline Charge: 400.00 USD (not collected through this payment link)\nRental Cost: 100.00 USD\nTotal Booking Value: 500.00 USD\nAmount Payable Now: 100.00 USD",
    );
    // The amount to pay is the charge, never the airline charge or the total.
    expect(visibleText(email.html)).toContain(`${PAYABLE_NOW} $100.00 Rental Cost`);
    expect(visibleText(email.html)).not.toContain(`${PAYABLE_NOW} $400.00`);
    expect(visibleText(email.html)).not.toContain(`${PAYABLE_NOW} $500.00`);
  });

  it("an operator cannot put the airline's amount on the payment link — not by naming the charge after it, not as a second line", async () => {
    await actingAs(skyfare);
    for (const name of ["Airline Charge", "Airfare", "airline fare"]) {
      const res = await createOrderRoute(
        buildRequest("/api/orders", {
          method: "POST",
          body: { ...flightForm("ignored"), charges: [{ name, amount: 400, timing: PaymentTiming.PREPAID }] },
        }),
      );
      const { status, body } = await jsonBody<unknown>(res);
      expect(status, name).toBe(422);
      expect(JSON.stringify(body), name).toContain(
        "The airline charge has its own field and is never collected here.",
      );
    }
    const twoLines = await createOrderRoute(
      buildRequest("/api/orders", {
        method: "POST",
        body: {
          ...flightForm("ignored"),
          charges: [
            { name: "Airline charge", amount: 400, timing: PaymentTiming.PREPAID },
            { name: "Rental Cost", amount: 100, timing: PaymentTiming.PREPAID },
          ],
        },
      }),
    );
    const { status, body } = await jsonBody<unknown>(twoLines);
    expect(status).toBe(422);
    expect(JSON.stringify(body)).toContain(
      "A flight has one charge: the amount this payment link collects.",
    );
    expect(await Order.countDocuments({ serviceType: ServiceType.FLIGHT })).toBe(0);
    expect(getCurrentTestStripe().sessionsCreated).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * 7. Car rentals — unchanged
 * ------------------------------------------------------------------ */

describe("7. car rental behaviour is unchanged", () => {
  /** What the car form submits: its lines as the operator named them. */
  const carForm = (charges: { name: string; amount: number; timing: PaymentTiming }[]) =>
    validCreateOrderInput({ charges });

  const FLIGHT_ONLY = [
    AIRLINE_CHARGE_ROW,
    NOT_COLLECTED,
    BOOKING_VALUE,
    PAYABLE_NOW,
    PRICE_BREAKDOWN,
  ];

  it("keeps every line as typed — 'What you're paying' / 'Charge breakdown' with 'Amount paid online' — and no flight row, on every surface", async () => {
    const lines = [
      { name: "Rental cost", amount: 249.99, timing: PaymentTiming.PREPAID },
      { name: "Processing Fee", amount: 15, timing: PaymentTiming.PREPAID },
      { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
    ];
    const order = await submitOrder(skyfare, carForm(lines));
    expect(order.serviceType).toBe(ServiceType.CAR_RENTAL);
    expect((await stored(order.id)).charges).toEqual(lines);
    expect(order.pricing.amount).toBe(264.99);

    await generateLink(skyfare, order.id);
    const preview = await composerPreview(skyfare, order.id);
    const sent = await sendRequest(skyfare, order.id);
    const consent = await consentPage(sent.consentToken!);
    await confirmConsent(sent.consentToken!);
    const previewAfterConsent = await composerPreview(skyfare, order.id);
    await webhookThenOutbox(skyfare, sent.order, "checkout.completed");
    const confirmation = lastSent(EmailKind.PAYMENT_CONFIRMATION);
    const receipt = await receiptPage(sent.order);

    const rentalRows =
      "Rental cost $249.99 Processing Fee $15.00 Deposit (due at counter) $100.00 Amount paid online $264.99 Amount due at counter $100.00 Total rental cost $364.99";
    for (const [where, html] of Object.entries({ preview, "sent email": sent.email.html })) {
      expect(visibleText(html), where).toContain(`What you're paying ${rentalRows}`);
      expect(visibleText(html), where).toContain("You pay today $264.99");
    }
    expect(visibleText(confirmation.html)).toContain(`Charge breakdown ${rentalRows}`);
    expect(visibleText(confirmation.html)).toContain("Amount paid $264.99");
    expect(visibleText(consent)).toContain(
      "You are paying today $264.99 New booking Paid online today $264.99 Remaining balance due at rental counter $100.00 Total rental cost $364.99",
    );
    expect(visibleText(receipt)).toContain(
      "Charge breakdown Paid online today $264.99 Remaining balance due at rental counter $100.00 Total rental cost $364.99",
    );
    // A car's pay button stays generic.
    expect(visibleText(previewAfterConsent)).toContain("Pay $264.99 securely with Stripe →");

    for (const [where, content] of Object.entries({
      preview,
      "sent email (html)": sent.email.html,
      "sent email (text)": sent.email.text,
      "consent page": consent,
      "confirmation (html)": confirmation.html,
      receipt,
    })) {
      for (const phrase of FLIGHT_ONLY) {
        expect(content, `${where} shows "${phrase}"`).not.toContain(phrase);
      }
      expect(content, `${where} says "service charge"`).not.toMatch(SERVICE_CHARGE);
    }
  });

  it("keeps the car line item — '<provider> • <vehicle> rental', never led by a line's name — collecting the prepaid total only", async () => {
    const order = await submitOrder(
      skyfare,
      carForm([
        { name: "Rental cost", amount: 249.99, timing: PaymentTiming.PREPAID },
        { name: "Processing Fee", amount: 15, timing: PaymentTiming.PREPAID },
        { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
      ]),
    );
    const { stripe } = await generateLink(skyfare, order.id);
    const item = onlyLineItem(stripe);
    expect(item.price_data!.product_data!.name).toBe("Budget • Toyota Camry rental");
    expect(item.price_data!.product_data!.description).toMatch(/^Pick-up: .+ • Drop-off: .+$/);
    expect(item.price_data!.unit_amount).toBe(26499);
    expect(amountsIn(stripe)).toEqual([26499]);

    // A single car line named like a flight charge is still just a car line.
    const single = await submitOrder(
      skyfare,
      carForm([{ name: "Agency Fee", amount: 180, timing: PaymentTiming.PREPAID }]),
    );
    const { stripe: singleStripe } = await generateLink(skyfare, single.id);
    const singleItem = onlyLineItem(singleStripe);
    expect(singleItem.price_data!.product_data!.name).toBe("Budget • Toyota Camry rental");
    expect(singleItem.price_data!.unit_amount).toBe(18000);
    expect(visibleText(await composerPreview(skyfare, single.id))).toContain(
      "What you're paying Agency Fee $180.00 Amount paid online $180.00 Total rental cost $180.00",
    );
  });
});

/* ------------------------------------------------------------------ *
 * The buttons name the charge on every brand, for every booking type
 * ------------------------------------------------------------------ */

describe("a PayPal brand's flight buttons name the charge — a modification's fee included", () => {
  it("asks to 'Review & pay', then 'Confirm & pay', then 'Pay the $100.00 Modification Fee securely with PayPal →' — under 'Complete your Modification Fee payment'", async () => {
    const created = await submitOrder(
      payfare,
      oneWayConnectingFlightInput(
        {
          provider: "AIRINDIA",
          bookingType: BookingType.MODIFICATION,
          charges: [{ name: "", amount: COLLECTED, timing: PaymentTiming.PREPAID }] as never,
        },
        { airlineFare: AIRLINE_CHARGE, pnr: PNR },
      ),
    );
    await generateLink(payfare, created.id);
    const sent = await sendRequest(payfare, created.id);

    expect(sent.email.subject).toBe(`Complete your Modification Fee payment • ${created.orderNumber}`);
    expect(visibleText(sent.email.html)).toContain("Review & pay $100.00 Modification Fee");
    expect(visibleText(await consentPage(sent.consentToken!))).toContain(
      "Confirm & pay $100.00 Modification Fee",
    );

    await confirmConsent(sent.consentToken!);
    const afterConsent = await composerPreview(payfare, created.id);
    expect(visibleText(afterConsent)).toContain(
      "Pay the $100.00 Modification Fee securely with PayPal →",
    );
    expect(afterConsent).not.toContain("Stripe");
    // The sentences stay neutral — only the buttons name the fee.
    expect(visibleText(afterConsent)).toContain(
      "please complete payment using the secure link below to confirm it.",
    );
  });
});

/* ------------------------------------------------------------------ *
 * The email TEMPLATE previews (Admin → Email previews) — no order
 * ------------------------------------------------------------------ */

describe("the email template previews", () => {
  const sample = flightLabelsWithCharge(DEFAULT_FLIGHT_CHARGE_NAME);

  it.each([
    ["payment-request", PAYABLE_NOW],
    ["payment-confirmation", sample.paidNow],
    ["payment-authorized", sample.heldNow],
  ] as const)(
    "a FLIGHT %s preview renders the four rows with its sample charge name",
    async (templateKey, settled) => {
      const { html } = await renderEmailPreview({
        organizationId: String(skyfare),
        serviceType: ServiceType.FLIGHT,
        templateKey: templateKey as EmailTemplateKey,
      });
      expect(moneyBlock(html)).toBe(
        [
          PRICE_BREAKDOWN,
          AIRLINE_CHARGE_ROW, "$1,240.00", NOT_COLLECTED,
          DEFAULT_FLIGHT_CHARGE_NAME, "$95.00",
          BOOKING_VALUE, "$1,335.00",
          settled, "$95.00",
          EXPLAINER,
        ].join(" "),
      );
    },
  );

  it("a CAR preview keeps its rental rows and shows no flight row", async () => {
    const { html } = await renderEmailPreview({
      organizationId: String(skyfare),
      serviceType: ServiceType.CAR_RENTAL,
      templateKey: "payment-request",
    });
    const text = visibleText(html);
    expect(text).toContain(
      "What you're paying Rental cost $150.00 Counter balance (due at counter) $350.00 Amount paid online $150.00 Amount due at counter $350.00 Total rental cost $500.00",
    );
    expect(text).not.toContain(AIRLINE_CHARGE_ROW);
    expect(text).not.toContain(BOOKING_VALUE);
    expect(text).not.toMatch(SERVICE_CHARGE);
  });
});

describe("a charge nobody named, and a stored name no form accepts", () => {
  it("a NEW modification left unnamed is stored, previewed, emailed and charged as the 'Modification Fee' — never a Service Charge", async () => {
    const created = await submitOrder(
      skyfare,
      oneWayConnectingFlightInput(
        {
          provider: "AIRINDIA",
          bookingType: BookingType.MODIFICATION,
          charges: [{ name: "", amount: COLLECTED, timing: PaymentTiming.PREPAID }] as never,
        },
        { airlineFare: AIRLINE_CHARGE, pnr: PNR },
      ),
    );
    expect((await stored(created.id)).charges).toEqual([
      { name: "Modification Fee", amount: COLLECTED, timing: PaymentTiming.PREPAID },
    ]);

    const { stripe } = await generateLink(skyfare, created.id);
    const item = onlyLineItem(stripe);
    expect(item.price_data?.unit_amount).toBe(COLLECTED * 100);
    expect(item.price_data?.product_data?.name).toMatch(/^Modification Fee • Air India • /);

    const preview = await composerPreview(skyfare, created.id);
    const { email } = await sendRequest(skyfare, created.id);
    for (const [where, html] of [["preview", preview], ["sent email", email.html]] as const) {
      const rows = moneyBlock(html);
      expect(rows, where).toContain("Modification Fee $100.00");
      expect(visibleText(html), where).not.toMatch(SERVICE_CHARGE);
    }
  });

  it("an order stored with an airline name before the rule ('Airfare') keeps the Service Charge wording it was sent with", async () => {
    const created = await submitOrder(skyfare, flightForm("Processing Fee"));
    // As a flight saved before the rule could carry it — around the schema.
    await Order.updateOne({ _id: created.id }, { $set: { "charges.0.name": "Airfare" } });

    const { stripe } = await generateLink(skyfare, created.id);
    const item = onlyLineItem(stripe);
    expect(item.price_data?.unit_amount).toBe(COLLECTED * 100);
    expect(item.price_data?.product_data?.name).toMatch(
      /^Air India • Flight booking service charge • /,
    );

    const { email } = await sendRequest(skyfare, created.id);
    const rows = moneyBlock(email.html);
    expect(rows).toContain("Service Charge $100.00");
    expect(rows).not.toContain("Airfare");
    expect(visibleText(email.html)).not.toContain("Airfare");
  });
});

/* ------------------------------------------------------------------ *
 * Review follow-ups — behaviours the suite did not guard
 * ------------------------------------------------------------------ */

/** The purchase unit PayPal is asked to create. */
interface PayPalOrderBody {
  purchase_units: { description: string; amount: { currency_code: string; value: string } }[];
}

/** POST /api/orders/[id]/regenerate-link — the order card's "Regenerate
 *  link". Returns the gateway request that regeneration made: Stripe's
 *  session params, or the PayPal order body. */
async function regenerateLink(orgId: Types.ObjectId, orderId: string) {
  await actingAs(orgId);
  const stripeBefore = getCurrentTestStripe().sessionsCreated.length;
  const paypalBefore = paypalBodies.length;
  const { order } = await ok<{ order: OrderDTO; checkoutUrl: string }>(
    await regenerateLinkRoute(
      buildRequest(`/api/orders/${orderId}/regenerate-link`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
  const sessions = getCurrentTestStripe().sessionsCreated;
  return {
    order,
    stripe: sessions.length > stripeBefore ? sessions.at(-1)!.params : null,
    paypal: paypalBodies
      .slice(paypalBefore)
      .filter((b): b is PayPalOrderBody & Record<string, unknown> => "purchase_units" in b),
  };
}

/** GET /api/orders/[id]/evidence — the evidence chain page's JSON: the
 *  events, the integrity check over them, and the flight section. */
async function evidenceChain(
  orgId: Types.ObjectId,
  orderId: string,
): Promise<OrderEvidenceChainWithFlightDTO> {
  await actingAs(orgId);
  return ok<OrderEvidenceChainWithFlightDTO>(
    await evidenceRoute(buildRequest(`/api/orders/${orderId}/evidence`), idParams(orderId)),
  );
}

/** The chain verifies end to end: no event's stored payload differs from
 *  what was hashed when it was recorded. */
function expectChainIntact(chain: OrderEvidenceChainWithFlightDTO, where: string) {
  expect(chain.events.length, `${where}: no evidence was recorded`).toBeGreaterThan(0);
  expect(chain.verification, `${where}: ${JSON.stringify(chain.verification)}`).toMatchObject({
    valid: true,
    eventCount: chain.events.length,
    brokenAtSequence: null,
    reason: null,
  });
}

/** The PAYMENT_LINK_GENERATED event — it records the line item's name and
 *  description exactly as the gateway was asked for them. */
function linkGeneratedEvent(chain: OrderEvidenceChainWithFlightDTO) {
  const event = chain.events.find(
    (e) => e.eventType === OrderEvidenceEventType.PAYMENT_LINK_GENERATED,
  );
  expect(event, "no PAYMENT_LINK_GENERATED evidence").toBeTruthy();
  return event!.payload as { productName?: unknown; description?: unknown };
}

/**
 * Text a gateway can carry: well-formed UTF-16 (no half of an emoji), and
 * therefore encodable the way the Stripe SDK form-encodes every value —
 * `encodeURIComponent`, which throws "URI malformed" on a lone surrogate.
 */
function expectGatewaySafe(text: string, where: string) {
  expect(text.isWellFormed(), `${where} is not well-formed UTF-16: ${JSON.stringify(text)}`).toBe(true);
  expect(() => encodeURIComponent(text), `${where} cannot be form-encoded`).not.toThrow();
  expect(text, `${where} carries a replacement character`).not.toContain("\uFFFD");
}

/** A FLIGHT email TEMPLATE preview (Admin → Email previews) for a booking type. */
async function templatePreview(templateKey: EmailTemplateKey, bookingType: BookingType) {
  const { html } = await renderEmailPreview({
    organizationId: String(skyfare),
    serviceType: ServiceType.FLIGHT,
    templateKey,
    bookingType,
  });
  expect(html, `${templateKey} (${bookingType}) rendered nothing`).not.toBe("");
  return html;
}

/** The preview sample's four rows under `chargeName`, ending with `settled`. */
function sampleRows(chargeName: string, settled: string): string {
  return [
    PRICE_BREAKDOWN,
    AIRLINE_CHARGE_ROW, "$1,240.00", NOT_COLLECTED,
    chargeName, "$95.00",
    BOOKING_VALUE, "$1,335.00",
    settled, "$95.00",
    EXPLAINER,
  ].join(" ");
}

describe("review follow-ups", () => {
  /* A. The longest name the form accepts, ending in an emoji ---------- */

  /** EXACTLY 120 UTF-16 code units — the charge-name limit — whose last
   *  two are one emoji's surrogate pair: the line item's 120-unit cut
   *  ("<name> • Air India • …") lands between them. */
  const EMOJI_NAME = `${"A".repeat(118)}🛫`;
  const NAME_HEAD = "A".repeat(118);

  it("A. a 120-unit charge name ending in an emoji: the order saves, Stripe's link is generated with a well-formed line item collecting $100.00, and the evidence chain verifies", async () => {
    expect(EMOJI_NAME).toHaveLength(120);
    expect(EMOJI_NAME.isWellFormed()).toBe(true);

    const order = await submitOrder(skyfare, flightForm(EMOJI_NAME)); // 201
    expect((await stored(order.id)).charges).toEqual([
      { name: EMOJI_NAME, amount: COLLECTED, timing: PaymentTiming.PREPAID },
    ]);

    const { order: linked, stripe } = await generateLink(skyfare, order.id); // 200
    expect(linked.payment.gateway).toBe(PaymentGatewayKey.STRIPE);
    const item = onlyLineItem(stripe);
    expect(item.price_data!.unit_amount).toBe(10000);
    expect(amountsIn(stripe)).toEqual([10000]);

    // The name is cut to the gateway's 120 — before the emoji, never
    // through it — and still leads with the operator's charge name.
    const name = item.price_data!.product_data!.name;
    expectGatewaySafe(name, "Stripe line item name");
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.startsWith(NAME_HEAD), name).toBe(true);
    expect(name.endsWith("…"), name).toBe(true);

    // The description's 127 keeps the whole name, emoji and all.
    const description = item.price_data!.product_data!.description!;
    expectGatewaySafe(description, "Stripe line item description");
    expect(description.length).toBeLessThanOrEqual(127);
    expect(description.startsWith(`${EMOJI_NAME} • `), description).toBe(true);
    expect(description.endsWith("…"), description).toBe(true);

    // What the evidence recorded is what Stripe was asked for, and the
    // chain over it verifies — a half emoji is stored as U+FFFD, which
    // no longer hashes to what was recorded ("payload_tampered").
    const chain = await evidenceChain(skyfare, order.id);
    expectChainIntact(chain, "Stripe order");
    const recorded = linkGeneratedEvent(chain);
    expect(recorded.productName).toBe(name);
    expect(recorded.description).toBe(description);
  });

  it("A. the same name on PayPal: the link is generated, the purchase description is well-formed and leads with the name, value '100.00', and the evidence chain verifies", async () => {
    const order = await submitOrder(payfare, flightForm(EMOJI_NAME)); // 201
    expect((await stored(order.id)).charges[0]!.name).toBe(EMOJI_NAME);

    const { order: linked } = await generateLink(payfare, order.id); // 200
    expect(linked.payment.gateway).toBe(PaymentGatewayKey.PAYPAL);
    expect(String(linked.payment.paymentUrl)).toContain("paypal.com");
    expect(getCurrentTestStripe().sessionsCreated).toHaveLength(0);

    const created = paypalBodies.filter((b) => "purchase_units" in b) as unknown as PayPalOrderBody[];
    expect(created).toHaveLength(1);
    expect(created[0]!.purchase_units).toHaveLength(1);
    const unit = created[0]!.purchase_units[0]!;
    expect(unit.amount).toEqual({ currency_code: "USD", value: "100.00" });
    expect(amountsIn(created[0])).toEqual([{ currency_code: "USD", value: "100.00" }]);
    expectGatewaySafe(unit.description, "PayPal purchase description");
    expect(unit.description.length).toBeLessThanOrEqual(127);
    expect(unit.description.startsWith(`${EMOJI_NAME} • `), unit.description).toBe(true);
    expect(unit.description.endsWith("…"), unit.description).toBe(true);

    // PayPal never sees the 120-unit line-item name — but the evidence
    // records it, and a half emoji there broke the chain.
    const chain = await evidenceChain(payfare, order.id);
    expectChainIntact(chain, "PayPal order");
    const recorded = linkGeneratedEvent(chain);
    expect(typeof recorded.productName).toBe("string");
    const productName = recorded.productName as string;
    expectGatewaySafe(productName, "recorded line item name");
    expect(productName.length).toBeLessThanOrEqual(120);
    expect(productName.startsWith(NAME_HEAD), productName).toBe(true);
    expect(productName.endsWith("…"), productName).toBe(true);
    expect(recorded.description).toBe(unit.description);
  });

  /* B. Regenerating the link ------------------------------------------- */

  it.each([
    ["Stripe, automatic capture", "skyfare"],
    ["Stripe, manual capture", "holdfare"],
    ["PayPal", "payfare"],
  ] as const)(
    "B. regenerating the link on %s asks for the 'Rental Cost' $100.00 only — never the airline charge — and still leads with 'Rental Cost'",
    async (_gateway, slug) => {
      const org = { skyfare, holdfare, payfare }[slug];
      const order = await submitOrder(org, flightForm("Rental Cost"));
      const first = await generateLink(org, order.id);
      const regenerated = await regenerateLink(org, order.id);

      // A NEW link for the same, unchanged order.
      expect(regenerated.order.payment.paymentSessionId).toBeTruthy();
      expect(regenerated.order.payment.paymentSessionId).not.toBe(
        first.order.payment.paymentSessionId,
      );
      expect(regenerated.order.pricing).toEqual({ amount: COLLECTED, currency: "USD" });
      expect((await stored(order.id)).charges).toEqual([
        { name: "Rental Cost", amount: COLLECTED, timing: PaymentTiming.PREPAID },
      ]);

      if (slug === "payfare") {
        expect(regenerated.stripe, "a PayPal regeneration reached Stripe").toBeNull();
        expect(getCurrentTestStripe().sessionsCreated).toHaveLength(0);
        expect(regenerated.paypal).toHaveLength(1);
        const body = regenerated.paypal[0]!;
        expect(body.purchase_units).toHaveLength(1);
        expect(body.purchase_units[0]!.amount).toEqual({ currency_code: "USD", value: "100.00" });
        // The only money in the whole request.
        expect(amountsIn(body)).toEqual([{ currency_code: "USD", value: "100.00" }]);
        const sent = JSON.stringify(body);
        for (const figure of ["400.00", "500.00"]) {
          expect(sent, `regenerated PayPal request carries ${figure}`).not.toContain(figure);
        }
        expect(sent).not.toContain(AIRLINE_CHARGE_ROW);
        const description = body.purchase_units[0]!.description;
        expect(description.split(" • ")[0]).toBe("Rental Cost");
        expect(description).toBe(`Rental Cost • ${DEPARTS}`);
        expect(sent).not.toMatch(SERVICE_CHARGE);
      } else {
        const item = onlyLineItem(regenerated.stripe);
        expect(item.price_data!.unit_amount).toBe(10000);
        // The only money in the whole request.
        expect(amountsIn(regenerated.stripe)).toEqual([10000]);
        const items = JSON.stringify(regenerated.stripe!.line_items);
        for (const figure of ["40000", "50000", "400.00", "500.00"]) {
          expect(items, `regenerated line item carries ${figure}`).not.toContain(figure);
        }
        for (const figure of ["400.00", "500.00"]) {
          expect(JSON.stringify(regenerated.stripe)).not.toContain(figure);
        }
        expect(items).not.toContain(AIRLINE_CHARGE_ROW);
        expect(items).not.toMatch(SERVICE_CHARGE);
        const product = item.price_data!.product_data!;
        expect(product.name.split(" • ")[0]).toBe("Rental Cost");
        expect(product.description!.split(" • ")[0]).toBe("Rental Cost");
        expect(product.name).toBe(`Rental Cost • ${AIRLINE} • ${ROUTE}`);
        expect(product.description).toBe(`Rental Cost • ${DEPARTS}`);
        // Same money, same words as the link it replaces.
        expect(regenerated.stripe!.line_items).toEqual(first.stripe!.line_items);
        if (slug === "holdfare") {
          expect(regenerated.stripe!.payment_intent_data?.capture_method).toBe("manual");
        }
      }

      // The chain over the regeneration still verifies.
      expectChainIntact(await evidenceChain(org, order.id), `${slug} after regeneration`);
    },
  );

  /* C. The Admin email-template preview follows the booking type ------- */

  it.each([
    [BookingType.MODIFICATION, "Modification Fee"],
    [BookingType.CANCELLATION_CHARGE, "Cancellation Charge"],
  ] as const)(
    "C. a FLIGHT %s template preview names the sample charge '%s' in every money label, keeps its sentences neutral, and never says Service Charge",
    async (bookingType, name) => {
      const request = await templatePreview("payment-request", bookingType);
      const confirmation = await templatePreview("payment-confirmation", bookingType);
      const authorized = await templatePreview("payment-authorized", bookingType);

      // The money rows carry the booking type's charge name.
      expect(moneyBlock(request), "payment-request").toBe(sampleRows(name, PAYABLE_NOW));
      expect(moneyBlock(confirmation), "payment-confirmation").toBe(
        sampleRows(name, `${name} Paid`),
      );
      expect(moneyBlock(authorized), "payment-authorized").toBe(
        sampleRows(name, `${name} On Hold`),
      );
      const requestText = visibleText(request);
      const confirmationText = visibleText(confirmation);
      const authorizedText = visibleText(authorized);
      expect(requestText).toContain(`${name} $95.00`);
      expect(confirmationText).toContain(`${name} Paid $95.00`);
      expect(authorizedText).toContain(`${name} On Hold $95.00`);

      // …but every sentence stays neutral: a modification or cancellation
      // charge is not asked for, received or held "as" a named charge.
      expect(requestText).toContain(
        "is reserved — please complete payment using the secure link below to confirm it.",
      );
      expect(requestText).not.toContain("please pay the");
      expect(confirmationText).toContain("We've received your payment for");
      expect(confirmationText).not.toContain(`received your ${name} payment`);
      expect(authorizedText).toContain("Your card has been authorized for $95.00 — this is a hold");
      expect(authorizedText).toContain(
        "Once it's confirmed we charge exactly $95.00 — not a penny more",
      );
      expect(authorizedText).toContain("Your bank may show $95.00 as pending until then.");

      // The payment request's BUTTON names the charge it asks the customer
      // to pay — a payment CTA, worded exactly as a real send words it —
      // while no sentence does.
      const button = `Review & pay $95.00 ${name}`;
      expect(requestText).toContain(`Order ORD-260517-PREVW1 Due May 19, 2026 · 6:00 PM ${button}`);
      for (const [where, html] of Object.entries({ request, confirmation, authorized })) {
        expect(html, `${where} (${bookingType}) says "service charge"`).not.toMatch(SERVICE_CHARGE);
        expect(
          visibleText(html).replace(button, ""),
          `${where} names the charge in a sentence`,
        ).not.toContain(`$95.00 ${name}`);
      }
    },
  );

  it("C. a FLIGHT NEW_BOOKING template preview still names the sample charge 'Service Charge' — rows and sentences", async () => {
    const request = await templatePreview("payment-request", BookingType.NEW_BOOKING);
    const confirmation = await templatePreview("payment-confirmation", BookingType.NEW_BOOKING);
    const authorized = await templatePreview("payment-authorized", BookingType.NEW_BOOKING);

    expect(moneyBlock(request)).toBe(sampleRows("Service Charge", PAYABLE_NOW));
    expect(moneyBlock(confirmation)).toBe(sampleRows("Service Charge", "Service Charge Paid"));
    expect(moneyBlock(authorized)).toBe(sampleRows("Service Charge", "Service Charge On Hold"));
    expect(visibleText(request)).toContain(
      "please pay the Service Charge using the secure link below to confirm it.",
    );
    expect(visibleText(confirmation)).toContain(
      "We've received your Service Charge payment for new booking",
    );
    expect(visibleText(authorized)).toContain(
      "Your card has been authorized for the $95.00 Service Charge — this is a hold",
    );
    for (const html of [request, confirmation, authorized]) {
      expect(visibleText(html)).not.toContain("Modification Fee");
      expect(visibleText(html)).not.toContain("Cancellation Charge");
    }
  });

  /* D. The evidence DTO carries the stored name ------------------------ */

  it("D. the evidence chain's flight section names the charge as stored: 'Rental Cost', service-charge sentences", async () => {
    const order = await submitOrder(skyfare, flightForm("Rental Cost"));
    const chain = await evidenceChain(skyfare, order.id);
    expect(chain.flight, "a flight order's chain has no flight section").toBeTruthy();
    expect(chain.flight!.chargeName).toBe("Rental Cost");
    expect(chain.flight!.serviceChargeModel).toBe(true);
    expect(chain.flight!.amounts).toMatchObject({
      charges: [{ name: "Rental Cost", amount: COLLECTED, timing: PaymentTiming.PREPAID }],
      airlineFare: AIRLINE_CHARGE,
      serviceCharge: COLLECTED,
      payableNow: COLLECTED,
      bookingTotal: AIRLINE_CHARGE + COLLECTED,
    });
    expect(JSON.stringify(chain.flight)).not.toMatch(SERVICE_CHARGE);
  });

  it("D. a modification carries its own name with neutral sentences — and one still stored under the pre-naming 'Service charge' is worded neutrally (chargeName '')", async () => {
    const created = await submitOrder(
      skyfare,
      oneWayConnectingFlightInput(
        {
          provider: "AIRINDIA",
          bookingType: BookingType.MODIFICATION,
          charges: [{ name: "Date Change Fee", amount: COLLECTED, timing: PaymentTiming.PREPAID }],
        },
        { airlineFare: AIRLINE_CHARGE, pnr: PNR },
      ),
    );
    const named = await evidenceChain(skyfare, created.id);
    expect(named.flight!.chargeName).toBe("Date Change Fee");
    expect(named.flight!.serviceChargeModel).toBe(false);

    // As an order made before operators named the charge carries it —
    // written around the schema, which stores the marker as the default.
    await Order.updateOne(
      { _id: created.id },
      { $set: { "charges.0.name": "Service charge" } },
    );
    expect((await stored(created.id)).charges[0]!.name).toBe("Service charge");
    const legacy = await evidenceChain(skyfare, created.id);
    expect(legacy.flight!.chargeName).toBe("");
    expect(legacy.flight!.serviceChargeModel).toBe(false);
    expect(legacy.flight!.amounts.serviceCharge).toBe(COLLECTED);
  });
});
