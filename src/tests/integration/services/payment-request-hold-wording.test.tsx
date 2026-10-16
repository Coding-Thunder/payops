import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

import {
  GET as consentViewRoute,
  POST as confirmConsentRoute,
} from "@/app/api/consent/[token]/route";
import { POST as generateLinkRoute } from "@/app/api/orders/[id]/generate-payment-link/route";
import { POST as previewRoute } from "@/app/api/orders/[id]/payment-request-preview/route";
import { POST as sendRequestRoute } from "@/app/api/orders/[id]/send-payment-request/route";
import {
  CaptureMode,
  ConsentMode,
  Currency,
  EmailKind,
  OrderStatus,
  PaymentCaptureStatus,
  PaymentGatewayKey,
  PaymentTiming,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { Order, Organization, OrganizationMember } from "@/server/db/models";
import { orgCookieName } from "@/server/auth/org-cookie";
import { formatEmailDate } from "@/server/email/format";
import { renderEmailPreview } from "@/server/email/preview";
import { _setPayPalFetchForTesting } from "@/server/payments/gateways/paypal";
import { composePaymentRequestProps } from "@/server/services/email.service";
import { createOrder } from "@/server/services/order.service";
import { createProvider } from "@/server/services/provider.service";
import { createOrder as factoryCreateOrder } from "@/tests/factories/order.factory";
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
 * THE PAYMENT REQUEST ON MANUAL CAPTURE — the "please pay" email worded for a
 * card HOLD wherever the order's checkout only AUTHORIZES the card, and
 * exactly as it has always been wherever the checkout charges.
 *
 * On a brand with `payments.captureMode = MANUAL` a Stripe checkout places a
 * hold that an operator captures later. A request saying "You pay today" or
 * "Amount paid online" tells that customer money moved when it has not — and
 * the "card authorized — not yet charged" email that follows contradicts it.
 * `paysByAuthorization` decides which requests speak of the hold:
 *
 *   1. the order's own capture record, pinned when its link was generated
 *      (method MANUAL → hold), whatever the brand's mode is now;
 *   2. otherwise, a link that exists charges at checkout → pay wording;
 *   3. otherwise — no link yet, the composer's first preview — what the next
 *      link will be: the brand on MANUAL AND that link on Stripe (its stored
 *      processor, Stripe when it stores none);
 *   4. an order stored without an organization takes the DEFAULT
 *      organization's mode; a brand that stores no mode is AUTOMATIC.
 *
 * Every surface the request reaches is read as the customer reads it — the
 * composer preview, the email as it left (HTML and plain text), the template
 * editor's samples and the "Confirm by email" mailto:
 *
 *   1. precedence   each rule above, with the case that breaks without it;
 *                   a MANUAL brand's PayPal link, sent; and the composer's
 *                   props, which carry the decision only when it is a hold
 *   2. consent      a car under consent mode REQUIRED on a MANUAL brand
 *   3. flight       an itinerary flight's named charge; a legacy flight
 *   4. plain text   the sent email's text part
 *   5. previews     the template editor (`renderEmailPreview`)
 *   6. mailto       the "Confirm by email" fallback's money lines
 *   7. legal text   the frozen car T&C, never re-worded by the capture mode
 *
 * Each hold is set against the pay-now wording an AUTOMATIC brand keeps, so
 * a hold leaking onto an automatic order fails here as surely as the old
 * pay-now wording returning to a manual one. The consent page, /pay/success
 * and the end-to-end brand journeys are pinned in consent-form,
 * pay-success-page and multi-service-org-matrix.
 */

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

/* ------------------------------------------------------------------ *
 * The deployment: three brands, and a default organization on demand
 * ------------------------------------------------------------------ */

interface BrandSpec {
  slug: string;
  brandName: string;
  provider: PaymentGatewayKey;
  captureMode: CaptureMode;
  isDefault?: boolean;
}

type BrandKey = "hold" | "pay" | "paypal";

const BRAND: Record<BrandKey, BrandSpec> = {
  /** Stripe, manual capture: its checkouts only authorize the card. */
  hold: {
    slug: "holdco",
    brandName: "HoldCo Travel",
    provider: PaymentGatewayKey.STRIPE,
    captureMode: CaptureMode.MANUAL,
  },
  /** Stripe, automatic capture: charged at checkout, like every incumbent. */
  pay: {
    slug: "payco",
    brandName: "PayCo Travel",
    provider: PaymentGatewayKey.STRIPE,
    captureMode: CaptureMode.AUTOMATIC,
  },
  /** On MANUAL, but its links open PayPal — never authorize-only here. */
  paypal: {
    slug: "palco",
    brandName: "PalCo Travel",
    provider: PaymentGatewayKey.PAYPAL,
    captureMode: CaptureMode.MANUAL,
  },
};

/** Created only by the tests about orders stored without an organization
 *  (and the preview with no brand selected). */
const DEFAULT_ORGANIZATION: BrandSpec = {
  slug: "rentalconfirmation",
  brandName: "Rental Confirmation",
  provider: PaymentGatewayKey.STRIPE,
  captureMode: CaptureMode.MANUAL,
  isDefault: true,
};

/** Each brand's own test credentials — a non-default brand never falls back
 *  to the deployment's. */
const ORG_ENV: Record<string, string> = {
  ORG_HOLDCO_STRIPE_SECRET_KEY: "sk_test_holdco_only",
  ORG_HOLDCO_STRIPE_WEBHOOK_SECRET: "whsec_holdco_only",
  ORG_PAYCO_STRIPE_SECRET_KEY: "sk_test_payco_only",
  ORG_PAYCO_STRIPE_WEBHOOK_SECRET: "whsec_payco_only",
  ORG_PALCO_PAYPAL_CLIENT_ID: "palco-client-id",
  ORG_PALCO_PAYPAL_CLIENT_SECRET: "palco-client-secret",
  ORG_PALCO_PAYPAL_WEBHOOK_ID: "WEBHOOK-PALCO",
  ORG_PALCO_PAYPAL_SANDBOX: "true",
};

const AIRLINE = "Air India";
/** The operator's name for the one charge an itinerary flight's link collects. */
const CHARGE = "Processing Fee";

/** The car every car test books: $249.99 prepaid, a $100.00 deposit at the
 *  counter. */
const carBody = () =>
  validCreateOrderInput({
    charges: [
      { name: "Rental cost", amount: 249.99, timing: PaymentTiming.PREPAID },
      { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
    ],
  });

/** One way Delhi → Varanasi → Mumbai: Airline Charge $400.00 (never
 *  collected) and the $100.00 Processing Fee the link collects. */
const flightBody = () =>
  oneWayConnectingFlightInput(
    {
      provider: "AIRINDIA",
      charges: [{ name: CHARGE, amount: 100, timing: PaymentTiming.PREPAID }],
    },
    { airlineFare: 400, pnr: null },
  );

type OrderBody = ReturnType<typeof carBody> | ReturnType<typeof flightBody>;

const operator = actorFor(UserRole.ADMIN, { name: "Olivia Operator" });

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
const orgIds = {} as Record<BrandKey, Types.ObjectId>;
let ipSeq = 0;
/** Every PayPal API call after the token, in order. */
let paypalCalls: string[] = [];

/** PayPal's API as far as a link needs it — a token, then the order the
 *  customer approves. Anything else fails loudly; nothing leaves the process. */
function stubPayPal() {
  paypalCalls = [];
  _setPayPalFetchForTesting((async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/v1/oauth2/token")) return json({ access_token: "tok", expires_in: 3600 });
    paypalCalls.push(url);
    if (url.endsWith("/v2/checkout/orders")) {
      const id = `PP-PALCO-${paypalCalls.length}`;
      return json({
        id,
        status: "PAYER_ACTION_REQUIRED",
        links: [{ rel: "payer-action", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }],
      });
    }
    throw new Error(`unexpected PayPal call: ${url}`);
  }) as unknown as typeof fetch);
}

async function makeOrg(spec: BrandSpec): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: spec.slug,
    name: spec.slug,
    brandName: spec.brandName,
    isDefault: spec.isDefault ?? false,
    payments: { provider: spec.provider, captureMode: spec.captureMode },
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT, ServiceType.HOTEL],
    email: {
      fromName: spec.brandName,
      fromEmail: `bookings@${spec.slug}.test`,
      replyTo: `help@${spec.slug}.test`,
    },
    support: { email: `support@${spec.slug}.test`, phone: "+12125550100" },
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

/** The operator, signed in, working in `orgId`'s brand. */
async function actingAs(orgId: Types.ObjectId) {
  sessionMock?.restore();
  sessionMock = await mockSession(operator);
  setNextHeaders({ cookies: { [orgCookieName()]: String(orgId) } });
}

/** A customer's browser: no session, no organization. */
function anonymous() {
  sessionMock?.restore();
  sessionMock = null;
  setNextHeaders({});
}

/** What `scripts/set-organization-capture-mode.ts` writes: that one field. */
async function setCaptureMode(orgId: Types.ObjectId, mode: CaptureMode) {
  await Organization.updateOne({ _id: orgId }, { $set: { "payments.captureMode": mode } });
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  Object.assign(process.env, ORG_ENV);
  sentMail.length = 0;
  stubPayPal();
  for (const key of Object.keys(BRAND) as BrandKey[]) orgIds[key] = await makeOrg(BRAND[key]);
  await actingAs(orgIds.hold);
  // A global airline: every brand may book it.
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
  for (const k of Object.keys(ORG_ENV)) delete process.env[k];
  _setPayPalFetchForTesting(null);
  setNextHeaders({});
});

/* ------------------------------------------------------------------ *
 * What the operator and the customer do — the real routes
 * ------------------------------------------------------------------ */

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

async function ok<T>(res: Response, status = 200): Promise<T> {
  const { status: got, body } = await jsonBody<{ ok: boolean; data: T }>(res);
  expect(got, JSON.stringify(body)).toBe(status);
  return body.data;
}

/** The create form's submit, in `key`'s brand. */
async function book(key: BrandKey, body: OrderBody): Promise<OrderDTO> {
  await actingAs(orgIds[key]);
  const { order } = await createOrder(body, { actor: operator });
  return order;
}

/** POST /api/orders/[id]/generate-payment-link — as the composer posts it
 *  for a brand with one processor: no gateway named. */
async function generateLink(orgId: Types.ObjectId, orderId: string): Promise<OrderDTO> {
  await actingAs(orgId);
  const { order } = await ok<{ order: OrderDTO }>(
    await generateLinkRoute(
      buildRequest(`/api/orders/${orderId}/generate-payment-link`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
  return order;
}

/** What the last checkout session asked Stripe to do with the money. */
function lastCheckoutCaptureMethod(): string | undefined {
  const created = getCurrentTestStripe().sessionsCreated.at(-1);
  expect(created, "no checkout session was created").toBeTruthy();
  return created!.params.payment_intent_data?.capture_method;
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

interface SentEmail {
  subject: string;
  html: string;
  text: string;
}

/** POST /api/orders/[id]/send-payment-request — the email as it left. */
async function sendRequest(orgId: Types.ObjectId, orderId: string) {
  await actingAs(orgId);
  const mark = sentMail.length;
  const data = await ok<{ order: OrderDTO; sent: { consentToken: string | null } }>(
    await sendRequestRoute(
      buildRequest(`/api/orders/${orderId}/send-payment-request`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
  const found = sentMail
    .slice(mark)
    .filter((m) => (m.headers as Record<string, string>)["X-Entity-Kind"] === EmailKind.PAYMENT_LINK);
  expect(found, "expected exactly one payment request email").toHaveLength(1);
  expect(data.sent.consentToken, "the send recorded no consent request").toBeTruthy();
  const email: SentEmail = {
    subject: String(found[0]!.subject),
    html: String(found[0]!.html),
    text: String(found[0]!.text),
  };
  return { email, consentToken: data.sent.consentToken! };
}

/** Booked, linked and sent in `key`'s brand: the request as the customer got it. */
async function requestSent(key: BrandKey, body: OrderBody) {
  const order = await generateLink(orgIds[key], (await book(key, body)).id);
  const sent = await sendRequest(orgIds[key], order.id);
  return { order, due: formatEmailDate(order.payment.expiresAt!), ...sent };
}

function uniqueIp(): string {
  ipSeq += 1;
  return `10.77.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
}

/** The customer opens the email's button and confirms (GET, then POST
 *  /api/consent/[token]). */
async function confirmConsent(token: string, signedName: string) {
  anonymous();
  const params = { params: Promise.resolve({ token }) };
  const view = await ok<PublicConsentView>(
    await consentViewRoute(buildRequest(`/api/consent/${token}`), params),
  );
  await ok<PublicConsentView>(
    await confirmConsentRoute(
      buildRequest(`/api/consent/${token}`, {
        method: "POST",
        body: { acknowledgement: view.consentMessage, signedName },
        headers: { "x-forwarded-for": uniqueIp() },
      }),
      params,
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Reading what the customer reads
 * ------------------------------------------------------------------ */

function decodeEntities(s: string): string {
  return s
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** The text a reader sees in rendered HTML — the hidden inbox preview line
 *  first, then the body: no head, no tags, entities and React's text-node
 *  separators resolved, whitespace collapsed. */
function visibleText(html: string): string {
  return decodeEntities(
    html
      .replace(/<head[\s\S]*?<\/head>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[\u00AD\u034F\u200B-\u200F\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** An email's plain-text part, whitespace collapsed. */
function plainText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The inbox preview line (preheader): the hidden text React Email renders
 *  first in the body and leaves out of the plain-text part. */
function preheader(html: string): string {
  const found = /<div[^>]*data-skip-in-text="true"[^>]*>([^<]*)/.exec(html);
  expect(found, "the email has no inbox preview line").toBeTruthy();
  return decodeEntities(found![1]!).trim();
}

/** The decoded body of the request's "Confirm by email" mailto. */
function consentMailtoBody(html: string): string {
  const mailto = [...html.matchAll(/href="(mailto:[^"]+)"/g)]
    .map((m) => m[1]!.replace(/&amp;/g, "&"))
    .find((m) => decodeURIComponent(m).includes("Acknowledgement"));
  expect(mailto, "the payment request has no consent mailto").toBeTruthy();
  return decodeURIComponent(mailto!.slice(mailto!.indexOf("&body=") + "&body=".length));
}

/** A car's money: the prepaid amount and the balance left at the counter. */
interface CarMoney {
  prepaid: string;
  dueName: string;
  due: string;
  total: string;
}

/** The car the tests book (`carBody`). */
const BOOKED_CAR: CarMoney = { prepaid: "$249.99", dueName: "Deposit", due: "$100.00", total: "$349.99" };
/** The template editor's sample rental. */
const SAMPLE_CAR: CarMoney = { prepaid: "$150.00", dueName: "Counter balance", due: "$350.00", total: "$500.00" };

/** The pay-now wording a HOLD replaces — none of it may reach a customer
 *  whose card is only authorized. */
const PAY_NOW_WORDS = [
  "Complete payment for",
  "complete payment",
  "You pay today",
  "What you're paying",
  "Amount paid online",
  "Payment processed securely",
  "Automated payment receipt",
];

/** …and the hold wording, which never reaches a customer charged at checkout. */
const HOLD_WORDS = [
  "on hold, not charged yet",
  "authorize your card",
  "You won't be charged",
  "Card hold today",
  "A hold on your card",
  "What you'll be charged",
  "a hold, not a charge",
  "Automated payment request",
  "Authorize ",
];

/**
 * A car request's money words: on a HOLD — the intro, the amount and the
 * line under it, the breakdown, the trust line and the footer all say the
 * card is held, not charged — or the pay-now request it has always been;
 * never a word of the other. Consent here is advisory, and its button is
 * "Review & Confirm Booking" either way. `gateway` is the processor the
 * trust line names: none before the order has a link.
 */
function expectCarWording(
  read: string,
  where: string,
  o: { hold: boolean; gateway: string | null; money?: CarMoney },
) {
  const m = o.money ?? BOOKED_CAR;
  expect(read, `${where} must keep the button "Review & Confirm Booking"`).toContain("Review & Confirm Booking");
  const expected = o.hold
    ? [
        "please authorize your card using the secure link below to confirm it. You won't be charged until your rental is confirmed.",
        `Card hold today ${m.prepaid} A hold on your card, not a charge — we charge it only once your rental is confirmed with Budget. Order`,
        `What you'll be charged Rental cost ${m.prepaid} ${m.dueName} (due at counter) ${m.due} ` +
          `Card hold today ${m.prepaid} Amount due at counter ${m.due} Total rental cost ${m.total}`,
        o.gateway
          ? `Card authorized securely via ${o.gateway} — a hold, not a charge. Your card details are encrypted end-to-end`
          : "Card authorized securely — a hold, not a charge. Your card details are encrypted end-to-end",
        "Automated payment request — replies route to our support team.",
      ]
    : [
        "please complete payment using the secure link below to confirm it.",
        `You pay today ${m.prepaid} Order`,
        `What you're paying Rental cost ${m.prepaid} ${m.dueName} (due at counter) ${m.due} ` +
          `Amount paid online ${m.prepaid} Amount due at counter ${m.due} Total rental cost ${m.total}`,
        o.gateway
          ? `Payment processed securely via ${o.gateway}. Your card details are encrypted end-to-end`
          : "Payment processed securely. Your card details are encrypted end-to-end",
        "Automated payment receipt — replies route to our support team.",
      ];
  for (const phrase of expected) {
    expect(read, `${where} must say "${phrase}"`).toContain(phrase);
  }
  for (const word of o.hold ? PAY_NOW_WORDS : HOLD_WORDS) {
    expect(read, `${where} must not say "${word}"`).not.toContain(word);
  }
}

/** An itinerary flight's price breakdown, ending with what the link does
 *  with the charge (`settled`). */
const flightRows = (settled: string, charge = CHARGE, amounts = ["$400.00", "$100.00", "$500.00"]) =>
  [
    "Price breakdown",
    "Airline Charge", amounts[0], "Not collected through this payment link",
    charge, amounts[1],
    "Total Booking Value", amounts[2],
    settled, amounts[1],
    "Airline Charge is shown for the total booking value and is not collected through this payment link.",
  ].join(" ");

/* ------------------------------------------------------------------ *
 * 1. Which requests speak of a hold
 * ------------------------------------------------------------------ */

describe("1. which payment requests speak of a HOLD — paysByAuthorization, rule by rule", () => {
  it("a link generated while the brand was on MANUAL keeps the hold wording after the brand is switched back to AUTOMATIC — the order's own capture record wins", async () => {
    const order = await book("hold", carBody());
    const linked = await generateLink(orgIds.hold, order.id);
    // The checkout this link opens only authorizes the card.
    expect(linked.payment.capture).toMatchObject({
      method: CaptureMode.MANUAL,
      status: PaymentCaptureStatus.PENDING_AUTHORIZATION,
    });
    expect(lastCheckoutCaptureMethod()).toBe("manual");

    await setCaptureMode(orgIds.hold, CaptureMode.AUTOMATIC);
    const preview = await composerPreview(orgIds.hold, order.id);
    const { email } = await sendRequest(orgIds.hold, order.id);

    for (const [where, html] of Object.entries({ "composer preview": preview, "sent email": email.html })) {
      expectCarWording(visibleText(html), where, { hold: true, gateway: "Stripe" });
      expect(preheader(html), where).toBe(
        `Authorize your card for ${order.orderNumber} — $249.99 on hold, not charged yet`,
      );
    }
  });

  it("a link generated while the brand was AUTOMATIC keeps the pay wording after the brand switches to MANUAL — it has no capture record and charges at checkout", async () => {
    const order = await book("pay", carBody());
    const linked = await generateLink(orgIds.pay, order.id);
    expect(linked.payment.capture).toBeNull();
    expect(lastCheckoutCaptureMethod()).toBeUndefined();

    await setCaptureMode(orgIds.pay, CaptureMode.MANUAL);
    const preview = await composerPreview(orgIds.pay, order.id);
    const { email } = await sendRequest(orgIds.pay, order.id);

    for (const [where, html] of Object.entries({ "composer preview": preview, "sent email": email.html })) {
      expectCarWording(visibleText(html), where, { hold: false, gateway: "Stripe" });
      expect(preheader(html), where).toBe(`Complete payment for ${order.orderNumber} — $249.99`);
    }
    // The brand IS on manual now: its next order, not yet linked, speaks of the hold.
    const next = await book("pay", carBody());
    expectCarWording(visibleText(await composerPreview(orgIds.pay, next.id)), "the next order's first preview", {
      hold: true,
      gateway: null,
    });
  });

  it("before any link exists, a MANUAL Stripe brand's first composer preview already speaks of the hold — and the link generated next is the authorize-only checkout it describes", async () => {
    const order = await book("hold", carBody());
    expect(order.payment.paymentUrl).toBeNull();
    expect(order.payment.capture).toBeNull();

    const first = await composerPreview(orgIds.hold, order.id);
    expectCarWording(visibleText(first), "first composer preview", { hold: true, gateway: null });
    expect(preheader(first)).toBe(
      `Authorize your card for ${order.orderNumber} — $249.99 on hold, not charged yet`,
    );

    const linked = await generateLink(orgIds.hold, order.id);
    expect(linked.payment.capture?.method).toBe(CaptureMode.MANUAL);
    expect(lastCheckoutCaptureMethod()).toBe("manual");
  });

  it("a MANUAL brand whose links open PayPal keeps the pay wording — first preview, its PayPal link (no capture record) and the request as sent — since manual capture is Stripe's alone; with its links moved to Stripe its next order speaks of the hold, while the PayPal-linked one still charges at checkout", async () => {
    const order = await book("paypal", carBody());
    expectCarWording(visibleText(await composerPreview(orgIds.paypal, order.id)), "PayPal brand's first preview", {
      hold: false,
      gateway: null,
    });

    const linked = await generateLink(orgIds.paypal, order.id);
    expect(linked.payment.gateway).toBe(PaymentGatewayKey.PAYPAL);
    // PayPal captures when the customer approves: nothing to hold.
    expect(linked.payment.capture).toBeNull();
    expect(paypalCalls.filter((u) => u.endsWith("/v2/checkout/orders"))).toHaveLength(1);
    expect(getCurrentTestStripe().sessionsCreated).toEqual([]);
    const { email } = await sendRequest(orgIds.paypal, order.id);
    const sent = visibleText(email.html);
    expectCarWording(sent, "PayPal brand's request as sent", { hold: false, gateway: "PayPal" });
    expect(sent).not.toContain("Stripe");

    // Only the processor its next link opens changes.
    await Organization.updateOne(
      { _id: orgIds.paypal },
      { $set: { "payments.provider": PaymentGatewayKey.STRIPE } },
    );
    const next = await book("paypal", carBody());
    expectCarWording(visibleText(await composerPreview(orgIds.paypal, next.id)), "the same brand on Stripe", {
      hold: true,
      gateway: null,
    });
    expectCarWording(visibleText(await composerPreview(orgIds.paypal, order.id)), "its order already on PayPal", {
      hold: false,
      gateway: "PayPal",
    });
  });

  it("a MANUAL brand whose document stores no processor at all — a row older than the field — opens Stripe: its first preview already speaks of the hold, and its link is the authorize-only Stripe checkout", async () => {
    await Organization.collection.updateOne(
      { _id: orgIds.hold },
      { $unset: { "payments.provider": "" } },
    );
    const order = await book("hold", carBody());

    expectCarWording(visibleText(await composerPreview(orgIds.hold, order.id)), "first preview, no processor stored", {
      hold: true,
      gateway: null,
    });
    const linked = await generateLink(orgIds.hold, order.id);
    expect(linked.payment.gateway).toBe(PaymentGatewayKey.STRIPE);
    expect(linked.payment.capture?.method).toBe(CaptureMode.MANUAL);
    expect(lastCheckoutCaptureMethod()).toBe("manual");
  });

  it("an order stored without an organization follows the DEFAULT organization's mode — the hold while it is on MANUAL, the pay wording once it is AUTOMATIC", async () => {
    const defaultOrg = await makeOrg(DEFAULT_ORGANIZATION);
    const legacy = await factoryCreateOrder({
      status: OrderStatus.NOT_INITIATED,
      pricing: { amount: 249.99, currency: Currency.USD },
      charges: [
        { name: "Rental cost", amount: 249.99, timing: PaymentTiming.PREPAID },
        { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
      ],
    });
    expect(legacy.organizationId).toBeNull();
    const id = String(legacy._id);

    expectCarWording(visibleText(await composerPreview(defaultOrg, id)), "default organization on MANUAL", {
      hold: true,
      gateway: null,
    });
    await setCaptureMode(defaultOrg, CaptureMode.AUTOMATIC);
    expectCarWording(visibleText(await composerPreview(defaultOrg, id)), "default organization on AUTOMATIC", {
      hold: false,
      gateway: null,
    });
  });

  it("an AUTOMATIC brand keeps the pay wording, and a brand with no capture mode stored at all IS automatic — its first preview byte for byte the same, its link charging at checkout, its preview and sent email the pay-now request", async () => {
    const order = await book("pay", carBody());
    const first = await composerPreview(orgIds.pay, order.id);
    expectCarWording(visibleText(first), "first composer preview", { hold: false, gateway: null });
    expect(preheader(first)).toBe(`Complete payment for ${order.orderNumber} — $249.99`);

    // Every incumbent brand's document predates the field: no key at all.
    // With no link yet the request asks the brand — and must read AUTOMATIC.
    await Organization.collection.updateOne(
      { _id: orgIds.pay },
      { $unset: { "payments.captureMode": "" } },
    );
    expect(await composerPreview(orgIds.pay, order.id)).toBe(first);

    const linked = await generateLink(orgIds.pay, order.id);
    expect(linked.payment.capture).toBeNull();
    expect(lastCheckoutCaptureMethod()).toBeUndefined();
    const preview = await composerPreview(orgIds.pay, order.id);
    expectCarWording(visibleText(preview), "composer preview with its link", { hold: false, gateway: "Stripe" });
    expect(preheader(preview)).toBe(`Complete payment for ${order.orderNumber} — $249.99`);

    const { email } = await sendRequest(orgIds.pay, order.id);
    expectCarWording(visibleText(email.html), "sent email", { hold: false, gateway: "Stripe" });
  });

  it("the composer hands the template `authorizationHold: true` on a hold and no such key otherwise — an automatic request's props are exactly the props they have always been", async () => {
    const held = await book("hold", carBody());
    const paid = await book("pay", carBody());
    const viaPayPal = await book("paypal", carBody());

    expect(await composePaymentRequestProps(held)).toHaveProperty("authorizationHold", true);
    const heldLinked = await generateLink(orgIds.hold, held.id);
    expect(await composePaymentRequestProps(heldLinked)).toHaveProperty("authorizationHold", true);

    const paidLinked = await generateLink(orgIds.pay, paid.id);
    for (const [where, order] of Object.entries({
      "AUTOMATIC brand, no link yet": paid,
      "AUTOMATIC brand, linked": paidLinked,
      "MANUAL brand on PayPal": viaPayPal,
    })) {
      expect(await composePaymentRequestProps(order), where).not.toHaveProperty("authorizationHold");
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2. Consent required
 * ------------------------------------------------------------------ */

describe("2. a car where consent is REQUIRED", () => {
  beforeEach(async () => {
    await createSettings({ consentMode: ConsentMode.REQUIRED });
  });

  it("on a MANUAL Stripe brand asks to 'Agree & Continue to Authorization' and says 'Confirmation is required before your card can be authorized.' — composer preview, sent HTML and plain text", async () => {
    const order = await generateLink(orgIds.hold, (await book("hold", carBody())).id);
    const preview = await composerPreview(orgIds.hold, order.id);
    const { email } = await sendRequest(orgIds.hold, order.id);
    const due = formatEmailDate(order.payment.expiresAt!);

    for (const [where, read] of Object.entries({
      "composer preview": visibleText(preview),
      "sent email (html)": visibleText(email.html),
      "sent email (text)": plainText(email.text),
    })) {
      expect(read, where).toContain("Agree & Continue to Authorization");
      expect(read, where).toContain("Confirmation is required before your card can be authorized.");
      expect(read, where).not.toContain("Agree & Continue to Payment");
      expect(read, where).not.toContain("Confirmation is required before payment can be completed.");
    }
    // The button sits right under the held amount and its due date.
    expect(visibleText(email.html)).toContain(
      `Order ${order.orderNumber} Due ${due} Agree & Continue to Authorization`,
    );
  });

  it("on a MANUAL Stripe brand, once the customer has confirmed, the composer's button is 'Authorize $249.99 securely with Stripe →' — never 'Pay $249.99'", async () => {
    const { order, due, consentToken } = await requestSent("hold", carBody());
    await confirmConsent(consentToken, order.customer.name);
    const after = visibleText(await composerPreview(orgIds.hold, order.id));

    expect(after).toContain(
      `Order ${order.orderNumber} Due ${due} Authorize $249.99 securely with Stripe → ` +
        "You already confirmed this booking — this opens Stripe Checkout.",
    );
    expect(after).not.toContain("Pay $249.99");
    expect(after).not.toContain("Agree & Continue");
  });

  it("on an AUTOMATIC brand keeps 'Agree & Continue to Payment', 'Confirmation is required before payment can be completed.' and, once confirmed, 'Pay $249.99 securely with Stripe →'", async () => {
    const { order, due, email, consentToken } = await requestSent("pay", carBody());
    for (const [where, read] of Object.entries({
      "sent email (html)": visibleText(email.html),
      "sent email (text)": plainText(email.text),
    })) {
      expect(read, where).toContain("Agree & Continue to Payment");
      expect(read, where).toContain("Confirmation is required before payment can be completed.");
      expect(read, where).not.toContain("Authorization");
      expect(read, where).not.toContain("can be authorized");
    }

    await confirmConsent(consentToken, order.customer.name);
    const after = visibleText(await composerPreview(orgIds.pay, order.id));
    expect(after).toContain(
      `Order ${order.orderNumber} Due ${due} Pay $249.99 securely with Stripe → ` +
        "You already confirmed this booking — this opens Stripe Checkout.",
    );
    expect(after).not.toContain("Authorize");
  });
});

/* ------------------------------------------------------------------ *
 * 3. Flights
 * ------------------------------------------------------------------ */

describe("3. a flight on a MANUAL Stripe brand", () => {
  it("an itinerary flight's request puts the named 'Processing Fee' on hold — preheader, intro, hero, consent button and price breakdown — never 'Amount Payable Now'; the AUTOMATIC brand's same flight keeps each pay-now line", async () => {
    const held = await requestSent("hold", flightBody());
    const paid = await requestSent("pay", flightBody());
    const read = visibleText(held.email.html);
    const on = held.order.orderNumber;

    expect(preheader(held.email.html)).toBe(
      `Authorize your card for ${on} — $100.00 ${CHARGE} on hold, not charged yet`,
    );
    expect(read).toContain(
      `please authorize the ${CHARGE} using the secure link below to confirm it. You won't be charged until your flight is confirmed.`,
    );
    expect(read).toContain(
      `${CHARGE} On Hold $100.00 ${CHARGE} A hold on your card, not a charge — we charge it only once your flight is confirmed with ${AIRLINE}. ` +
        `Order ${on} Due ${held.due} Review & authorize $100.00 ${CHARGE}`,
    );
    expect(read).toContain(flightRows(`${CHARGE} On Hold`));
    expect(read).toContain(
      "Card authorized securely via Stripe — a hold, not a charge. Your card details are encrypted end-to-end",
    );
    for (const said of [
      "Amount Payable Now",
      "Review & pay",
      `please pay the ${CHARGE}`,
      "Complete payment for",
      "Payment processed securely",
      "Automated payment receipt",
    ]) {
      expect(read, `the held flight's request says "${said}"`).not.toContain(said);
    }

    const paidRead = visibleText(paid.email.html);
    expect(preheader(paid.email.html)).toBe(`Complete payment for ${paid.order.orderNumber} — $100.00 ${CHARGE}`);
    expect(paidRead).toContain(
      `Amount Payable Now $100.00 ${CHARGE} Order ${paid.order.orderNumber} Due ${paid.due} Review & pay $100.00 ${CHARGE}`,
    );
    expect(paidRead).toContain(flightRows("Amount Payable Now"));
    // (Its built-in flight terms do mention a card "authorized (held)" —
    // legal text, the same under either mode.)
    for (const said of [
      `${CHARGE} On Hold`,
      "on hold, not charged yet",
      "please authorize",
      "& authorize",
      "A hold on your card",
      "a hold, not a charge",
    ]) {
      expect(paidRead, `the paid flight's request says "${said}"`).not.toContain(said);
    }
  });

  it("where consent is REQUIRED, the itinerary flight's button asks to 'Agree & authorize $100.00 Processing Fee'; once confirmed it is 'Authorize the $100.00 Processing Fee securely with Stripe →'", async () => {
    await createSettings({ consentMode: ConsentMode.REQUIRED });
    const { order, due, email, consentToken } = await requestSent("hold", flightBody());

    for (const [where, read] of Object.entries({
      "sent email (html)": visibleText(email.html),
      "sent email (text)": plainText(email.text),
    })) {
      expect(read, where).toContain(`Agree & authorize $100.00 ${CHARGE}`);
      expect(read, where).toContain("Confirmation is required before your card can be authorized.");
      expect(read, where).not.toContain("Agree & pay");
      expect(read, where).not.toContain("Confirmation is required before payment can be completed.");
    }

    await confirmConsent(consentToken, order.customer.name);
    const after = visibleText(await composerPreview(orgIds.hold, order.id));
    expect(after).toContain(
      `Order ${order.orderNumber} Due ${due} Authorize the $100.00 ${CHARGE} securely with Stripe → ` +
        "You already confirmed this booking — this opens Stripe Checkout.",
    );
    expect(after).not.toContain(`Pay the $100.00 ${CHARGE}`);
  });

  it("a flight created before itineraries — its charge never named — holds the 'Amount On Hold' in its hero, its breakdown and its mailto, and once confirmed offers 'Authorize $420.50 securely with Stripe →'", async () => {
    // Flat flight fields and its whole fare as one prepaid "Airfare" line.
    const legacy = await factoryCreateOrder({
      serviceType: ServiceType.FLIGHT,
      organizationId: orgIds.hold,
      status: OrderStatus.NOT_INITIATED,
      pricing: { amount: 420.5, currency: Currency.USD },
    });
    const order = await generateLink(orgIds.hold, String(legacy._id));
    expect(order.payment.capture?.method).toBe(CaptureMode.MANUAL);
    const { email, consentToken } = await sendRequest(orgIds.hold, order.id);
    const read = visibleText(email.html);
    const on = order.orderNumber;

    expect(preheader(email.html)).toBe(`Authorize your card for ${on} — $420.50 on hold, not charged yet`);
    expect(read).toContain(
      "please authorize your card using the secure link below to confirm it. You won't be charged until your flight is confirmed.",
    );
    expect(read).toContain(
      `Amount On Hold $420.50 A hold on your card, not a charge — we charge it only once your flight is confirmed with Budget. Order ${on}`,
    );
    expect(read).toContain("Price breakdown Airfare $420.50 Total Booking Value $420.50 Amount On Hold $420.50");
    expect(read).toContain(
      "Card authorized securely via Stripe — a hold, not a charge. Your card details are encrypted end-to-end",
    );
    expect(read).toContain("Automated payment request — replies route to our support team.");
    expect(consentMailtoBody(email.html)).toContain(
      ["Total Booking Value: 420.50 USD", "Amount On Hold: 420.50 USD", "Payment link: "].join("\n"),
    );
    expect(consentMailtoBody(email.html)).not.toContain("Payable Now");
    for (const said of [
      "Amount Payable Now",
      "please complete payment",
      "Complete payment for",
      "Payment processed securely",
      "Automated payment receipt",
    ]) {
      expect(read, `the legacy flight's request says "${said}"`).not.toContain(said);
    }

    await confirmConsent(consentToken, order.customer.name);
    const after = visibleText(await composerPreview(orgIds.hold, order.id));
    expect(after).toContain(
      "Authorize $420.50 securely with Stripe → You already confirmed this booking — this opens Stripe Checkout.",
    );
    expect(after).not.toContain("Pay $420.50");
  });
});

/* ------------------------------------------------------------------ *
 * 4. The plain-text part
 * ------------------------------------------------------------------ */

describe("4. the plain-text part of a sent MANUAL request", () => {
  it("a car's text part carries the hold wording — and never 'You pay today', 'Amount paid online', 'What you're paying' or 'payment receipt', in any case", async () => {
    const { email } = await requestSent("hold", carBody());
    const text = plainText(email.text);

    expect(text).toContain(
      "please authorize your card using the secure link below to confirm it. You won't be charged until your rental is confirmed.",
    );
    expect(text).toContain(
      "Card hold today $249.99 A hold on your card, not a charge — we charge it only once your rental is confirmed with Budget.",
    );
    // The text part capitalises headings.
    expect(text).toContain(
      "WHAT YOU'LL BE CHARGED Rental cost $249.99 Deposit (due at counter) $100.00 " +
        "Card hold today $249.99 Amount due at counter $100.00 Total rental cost $349.99",
    );
    expect(text).toContain("Card authorized securely via Stripe — a hold, not a charge.");
    expect(text).toContain("Automated payment request — replies route to our support team.");
    for (const said of [
      /you pay today/i,
      /amount paid online/i,
      /what you're paying/i,
      /payment receipt/i,
      /complete payment/i,
      /payment processed securely/i,
    ]) {
      expect(text).not.toMatch(said);
    }
  });

  it("an itinerary flight's text part names the 'Processing Fee On Hold' and the authorize button — never 'Amount Payable Now', 'Review & pay' or 'payment receipt'", async () => {
    const { email } = await requestSent("hold", flightBody());
    const text = plainText(email.text);

    expect(text).toContain(
      `please authorize the ${CHARGE} using the secure link below to confirm it. You won't be charged until your flight is confirmed.`,
    );
    expect(text).toContain(
      `${CHARGE} On Hold $100.00 ${CHARGE} A hold on your card, not a charge — we charge it only once your flight is confirmed with ${AIRLINE}.`,
    );
    expect(text).toContain(`Review & authorize $100.00 ${CHARGE}`);
    expect(text).toContain(
      `PRICE BREAKDOWN Airline Charge $400.00 Not collected through this payment link ${CHARGE} $100.00 ` +
        `Total Booking Value $500.00 ${CHARGE} On Hold $100.00`,
    );
    expect(text).toContain("Card authorized securely via Stripe — a hold, not a charge.");
    expect(text).toContain("Automated payment request — replies route to our support team.");
    for (const said of [
      /amount payable now/i,
      /review & pay/i,
      /please pay the/i,
      /payment receipt/i,
      /payment processed securely/i,
    ]) {
      expect(text).not.toMatch(said);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5. The template editor's previews
 * ------------------------------------------------------------------ */

describe("5. the template editor's payment-request previews (renderEmailPreview)", () => {
  /** Admin → Email templates → Payment request, for `orgId`'s brand (or no
   *  brand selected), with that service's sample booking. */
  async function templatePreview(
    orgId: Types.ObjectId | null,
    serviceType: ServiceType = ServiceType.CAR_RENTAL,
  ): Promise<string> {
    const { html } = await renderEmailPreview({
      organizationId: orgId ? String(orgId) : null,
      serviceType,
      templateKey: "payment-request",
    });
    expect(html, `the ${serviceType} preview rendered nothing`).not.toBe("");
    return html;
  }

  it("a MANUAL Stripe brand's car sample puts its $150.00 on hold — preheader, intro, hero, breakdown, trust line and footer", async () => {
    const html = await templatePreview(orgIds.hold);
    const read = visibleText(html);

    expectCarWording(read, "MANUAL brand's car preview", { hold: true, gateway: "Stripe", money: SAMPLE_CAR });
    expect(preheader(html)).toBe("Authorize your card for ORD-260517-PREVW1 — $150.00 on hold, not charged yet");
    expect(read).toContain(
      `${BRAND.hold.brandName}. Automated payment request — replies route to our support team. Powered by Stripe.`,
    );
  });

  it("a MANUAL Stripe brand's flight sample puts its 'Service Charge' on hold — 'Service Charge On Hold', 'Review & authorize $95.00 Service Charge'", async () => {
    const html = await templatePreview(orgIds.hold, ServiceType.FLIGHT);
    const read = visibleText(html);

    expect(preheader(html)).toBe(
      "Authorize your card for ORD-260517-PREVW1 — $95.00 Service Charge on hold, not charged yet",
    );
    expect(read).toContain(
      `Service Charge On Hold $95.00 Service Charge A hold on your card, not a charge — we charge it only once your flight is confirmed with ${AIRLINE}. ` +
        "Order ORD-260517-PREVW1 Due May 19, 2026 · 6:00 PM Review & authorize $95.00 Service Charge",
    );
    expect(read).toContain(
      flightRows("Service Charge On Hold", "Service Charge", ["$1,240.00", "$95.00", "$1,335.00"]),
    );
    for (const said of ["Amount Payable Now", "Review & pay", "please pay the", "Complete payment for"]) {
      expect(read, said).not.toContain(said);
    }
  });

  it("a MANUAL Stripe brand's hotel sample holds the stay's prepayment until the hotel is confirmed with the supplier", async () => {
    await createProvider(
      {
        key: "HARBOURSTAYS",
        name: "Harbour Stays",
        logo: "/providers/preview.png",
        primaryColor: "#0B3D91",
        onPrimaryColor: "#FFFFFF",
        tagline: "",
        sortOrder: 0,
        serviceTypes: [ServiceType.HOTEL],
      } as Parameters<typeof createProvider>[0],
      { actor: operator },
    );
    const read = visibleText(await templatePreview(orgIds.hold, ServiceType.HOTEL));

    expect(read).toContain(
      "please authorize your card using the secure link below to confirm it. You won't be charged until your hotel is confirmed.",
    );
    expect(read).toContain(
      "Card hold today $150.00 A hold on your card, not a charge — we charge it only once your hotel is confirmed with Harbour Stays.",
    );
    expect(read).toContain(
      "What you'll be charged Room charge $150.00 Balance at the property (due at the property) $350.00 " +
        "Card hold today $150.00 Amount due at the property $350.00 Total hotel cost $500.00",
    );
    expect(read).toContain("Card authorized securely via Stripe — a hold, not a charge.");
    for (const said of [
      "Amount payable now",
      "You pay today",
      "What you're paying",
      "complete payment",
      "Payment processed securely",
      "Automated payment receipt",
    ]) {
      expect(read, said).not.toContain(said);
    }
  });

  it("under consent mode REQUIRED, a MANUAL Stripe brand's samples ask to 'Agree & Continue to Authorization' (its flight: 'Agree & authorize $95.00 Service Charge')", async () => {
    await createSettings({ consentMode: ConsentMode.REQUIRED });
    const car = visibleText(await templatePreview(orgIds.hold));
    const flight = visibleText(await templatePreview(orgIds.hold, ServiceType.FLIGHT));

    expect(car).toContain("Due May 19, 2026 · 6:00 PM Agree & Continue to Authorization");
    expect(flight).toContain("Due May 19, 2026 · 6:00 PM Agree & authorize $95.00 Service Charge");
    for (const [where, read] of Object.entries({ car, flight })) {
      expect(read, where).toContain("Confirmation is required before your card can be authorized.");
      expect(read, where).not.toContain("Agree & Continue to Payment");
      expect(read, where).not.toContain("Agree & pay");
      expect(read, where).not.toContain("Confirmation is required before payment can be completed.");
    }
  });

  it("the same brand switched to AUTOMATIC previews the pay wording", async () => {
    await setCaptureMode(orgIds.hold, CaptureMode.AUTOMATIC);
    const html = await templatePreview(orgIds.hold);

    expectCarWording(visibleText(html), "AUTOMATIC brand's car preview", {
      hold: false,
      gateway: "Stripe",
      money: SAMPLE_CAR,
    });
    expect(preheader(html)).toBe("Complete payment for ORD-260517-PREVW1 — $150.00");
  });

  it("a MANUAL brand whose links open PayPal previews the pay wording, naming PayPal", async () => {
    const read = visibleText(await templatePreview(orgIds.paypal));
    expectCarWording(read, "PayPal brand's car preview", { hold: false, gateway: "PayPal", money: SAMPLE_CAR });
    expect(read).not.toContain("Stripe");
  });

  it("with no brand selected, the preview is the deployment's sample in the pay wording — even while the default organization is on MANUAL", async () => {
    await makeOrg(DEFAULT_ORGANIZATION);
    const html = await templatePreview(null);

    expectCarWording(visibleText(html), "preview with no brand selected", {
      hold: false,
      gateway: "Stripe",
      money: SAMPLE_CAR,
    });
    expect(preheader(html)).toBe("Complete payment for ORD-260517-PREVW1 — $150.00");
  });
});

/* ------------------------------------------------------------------ *
 * 6. The "Confirm by email" fallback
 * ------------------------------------------------------------------ */

describe("6. the 'Confirm by email' mailto of a sent request", () => {
  it("a MANUAL itinerary flight's money lines end with 'Processing Fee On Hold: 100.00 USD' and never say 'Amount Payable Now'; the AUTOMATIC brand's identical lines end with 'Amount Payable Now: 100.00 USD'", async () => {
    const held = consentMailtoBody((await requestSent("hold", flightBody())).email.html);
    const paid = consentMailtoBody((await requestSent("pay", flightBody())).email.html);
    /** The four money lines, then the link line that follows them. */
    const moneyLines = (settled: string) =>
      [
        "Airline Charge: 400.00 USD (not collected through this payment link)",
        `${CHARGE}: 100.00 USD`,
        "Total Booking Value: 500.00 USD",
        `${settled}: 100.00 USD`,
        "Payment link: ",
      ].join("\n");

    expect(held).toContain(moneyLines(`${CHARGE} On Hold`));
    expect(held).not.toContain("Payable Now");
    expect(paid).toContain(moneyLines("Amount Payable Now"));
    expect(paid).not.toContain("On Hold");
  });

  it("a MANUAL car keeps its one 'Amount: 249.99 USD' line, exactly as an AUTOMATIC car's", async () => {
    const held = consentMailtoBody((await requestSent("hold", carBody())).email.html);
    const paid = consentMailtoBody((await requestSent("pay", carBody())).email.html);

    for (const [where, body] of Object.entries({ "MANUAL car": held, "AUTOMATIC car": paid })) {
      expect(body, where).toMatch(/\nDrop-off: [^\n]+\nAmount: 249\.99 USD\nPayment link: /);
      expect(body, where).not.toMatch(/on hold|payable now|authoriz/i);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 7. The legal text
 * ------------------------------------------------------------------ */

describe("7. the car's legal text is the operator's — the capture mode never re-words it", () => {
  it("an AUTOMATIC and a MANUAL brand's car requests print the same frozen Terms & Conditions — 'The prepaid amount is charged today …' included — and the same cancellation policy, word for word, in HTML and plain text, while the money words around them differ", async () => {
    const paid = await requestSent("pay", carBody());
    const held = await requestSent("hold", carBody());

    // Both orders froze the deployment's car text at creation.
    const frozen = async (id: string) => {
      const doc = await Order.findById(id).lean<{
        terms: { text: string; version: string };
        policy: { text: string; version: string };
      } | null>();
      return {
        terms: { text: doc!.terms.text, version: doc!.terms.version },
        policy: { text: doc!.policy.text, version: doc!.policy.version },
      };
    };
    const legal = await frozen(held.order.id);
    expect(legal).toEqual(await frozen(paid.order.id));
    expect(legal.terms.text).toContain("The prepaid amount is charged today to secure your reservation.");

    /** The text between a block's heading and the version line closing it. */
    const block = (read: string, heading: string, closing: string) => {
      const from = read.indexOf(heading);
      const to = read.indexOf(closing, from);
      expect(from, `no "${heading}"`).toBeGreaterThanOrEqual(0);
      expect(to, `"${heading}" has no "${closing}" line`).toBeGreaterThan(from);
      return read.slice(from + heading.length, to).trim();
    };
    const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

    for (const [where, email] of Object.entries({ "MANUAL request": held.email, "AUTOMATIC request": paid.email })) {
      const html = visibleText(email.html);
      // The text part capitalises headings.
      const text = plainText(email.text);
      expect(block(html, "Terms & Conditions", "Terms version"), `${where} (html)`).toBe(oneLine(legal.terms.text));
      expect(block(text, "TERMS & CONDITIONS", "Terms version"), `${where} (text)`).toBe(oneLine(legal.terms.text));
      expect(block(html, "Cancellation & refund policy", "Policy version"), `${where} (html)`).toBe(
        oneLine(legal.policy.text),
      );
      expect(block(text, "CANCELLATION & REFUND POLICY", "Policy version"), `${where} (text)`).toBe(
        oneLine(legal.policy.text),
      );
    }

    // …while the capture mode did re-word the money around them.
    expect(visibleText(held.email.html)).toContain("Card hold today $249.99");
    expect(visibleText(paid.email.html)).toContain("You pay today $249.99");
  });
});
