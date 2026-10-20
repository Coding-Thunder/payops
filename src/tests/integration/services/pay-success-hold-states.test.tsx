import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cloneElement,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Types } from "mongoose";
import type Stripe from "stripe";

import { DELETE as archiveOrderRoute } from "@/app/api/orders/[id]/route";
import { POST as deploymentWebhook } from "@/app/api/webhooks/stripe/route";
import { POST as brandWebhook } from "@/app/api/webhooks/stripe/[orgSlug]/route";
import { PaymentSuccessAutoRefresh } from "@/app/pay/success/auto-refresh";
import PaymentSuccessPage, { generateMetadata } from "@/app/pay/success/page";
import {
  DEFAULT_FLIGHT_CHARGE_NAME,
  FLIGHT_AMOUNT_LABELS,
  flightLabelsWithCharge,
} from "@/lib/charges";
import {
  AuditAction,
  BookingStatus,
  BookingType,
  CaptureMode,
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
import { formatDateTime } from "@/lib/format";
import {
  AuditLog,
  Branding,
  Order,
  Organization,
  PendingEmail,
  ProcessedWebhookEvent,
} from "@/server/db/models";
import { orgCookieName } from "@/server/auth/org-cookie";
import { _setPayPalFetchForTesting } from "@/server/payments/gateways/paypal";
import { createOrder, initiatePayment } from "@/server/services/order.service";
import {
  createOrder as factoryCreateOrder,
  itineraryFlight,
  type OrderSeed,
} from "@/tests/factories/order.factory";
import { createSettings } from "@/tests/factories/settings.factory";
import {
  buildCheckoutExpired,
  buildPaymentIntentFailed,
  signWebhook,
} from "@/tests/factories/stripe-event.factory";
import {
  flightServiceCharge,
  oneWayConnectingFlightInput,
  validCreateOrderInput,
  validHotelOrderInput,
} from "@/tests/fixtures/order-input.fixture";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";
import { buildRequest, expectOk, jsonBody, type ApiEnvelope } from "@/tests/utils/api";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";
import type { OrderDTO } from "@/types";

/**
 * /pay/success for every MANUAL-capture state — the page a customer lands on
 * after authorizing a card hold, or comes back to later — rendered for real
 * (server component, real services, real database, the Stripe stub).
 *
 * On manual capture the checkout only AUTHORIZES the card. `payment.capture`
 * walks PENDING_AUTHORIZATION → AUTHORIZED, then the operator Captures (PAID,
 * CAPTURED) or Releases the hold (CANCELLED, status unchanged), or Stripe lets
 * it lapse (AUTHORIZATION_EXPIRED). At every step the page must say what
 * actually happened to the money — and so must its tab title, which reads
 * the very same order:
 *
 *   hold still landing (the     "We’re confirming your card" (title
 *   request sent, or the link   "Confirming your card"); the amount is the
 *   only copied)                "Card hold today" — on a flight "<charge> On
 *                               Hold" — never paid, never payable, never
 *                               "finalise this charge", never "nothing was
 *                               charged"; the give-up hint says "hold"
 *   hold standing (authorized,  "Card authorized", "Amount on hold", collected
 *   capturing, capture refused) "only once <condition>" — no spinner; and
 *                               still "Card authorized" on an order no longer
 *                               awaiting the gateway (EXPIRED): money held is
 *                               never "nothing was charged"
 *   released or lapsed          "Hold released" / "You have not been charged"
 *                               / "this hold will never be collected" — never
 *                               "Payment received", never a spinner, and still
 *                               after the order is archived
 *   never held: the checkout    "Payment status" / "You have not been charged"
 *   expired, or the operator    / "This payment link is no longer active, and
 *   archived the order, before  nothing was charged to your card" (title
 *   the customer authorized     "Payment status"), the info icon on a neutral
 *   (EXPIRED, the hold still    hero, never the paid green; the amount is
 *   PENDING_AUTHORIZATION)      "Not charged", and so are a car's online
 *                               breakdown row and a flight's hero label and
 *                               last breakdown row — never paid, received or
 *                               receipted, never a hold, never a spinner
 *   captured                    the ordinary paid receipt — from the moment
 *                               the order is PAID, before the capture record
 *                               itself says CAPTURED
 *   a link matching no order,   "Payment status" / "We couldn’t match this
 *   or naming no session        payment" — no state, no order details; a
 *                               link with no session id pairs with nothing,
 *                               not even an order that has no session yet
 *                               (a draft)
 *
 * The <condition> follows the booking type: a new booking is collected once
 * "your rental is confirmed", a change once "the change to your rental is
 * confirmed", a cancellation charge once "your cancellation is processed" —
 * and a flight or a hotel is named as such ("your flight", "your hotel").
 * An automatic-capture order (`capture` null) reads exactly as it always
 * has, even after its organization switched to MANUAL — an EXPIRED one too
 * (its checkout expired, or it was archived, which asks Stripe nothing),
 * which this page has always shown as the paid receipt.
 *
 * A card declined at checkout drives a manual order to FAILED while its hold
 * is still PENDING_AUTHORIZATION, and Checkout keeps the session open for
 * another card. A customer back here after that retry is waiting on a hold,
 * not on a failed payment: "We’re confirming your card" while Stripe has the
 * session open; once Stripe reports it complete and unpaid, the first-render
 * reconcile records the hold, which puts the order back in progress
 * (PAYMENT_PENDING) — "Card authorized". Never "Payment received". An
 * automatic order a decline drove to FAILED reads exactly as it did before:
 * its decline asks Stripe nothing (only a manual order's decline is checked
 * against the intent its session holds now), and the page does not
 * reconcile it.
 *
 * It also pins WHEN the page asks Stripe. The first-render reconcile runs
 * while there is something left to record: an automatic order still awaiting
 * the gateway, a manual one still PENDING_AUTHORIZATION (a decline may have
 * driven it to FAILED meanwhile), or one whose capture is in flight or was
 * refused — that capture may have gone through at Stripe, and only a
 * session Stripe reports paid moves the order to PAID, settling the capture
 * record (CAPTURED) and the booking (CONFIRMED) with it. While Stripe still
 * reports that hold uncaptured, asking leaves no trail: the hold is on record
 * already, so nothing is claimed and no duplicate-event row is written. A
 * standing, released or lapsed hold IS the gateway's truth; asking again
 * could flip it to PAID. A checkout Stripe reports expired is recorded
 * as EXPIRED, and that render already says nothing was charged. An EXPIRED
 * order is not awaiting the gateway, so its page asks nothing. Archiving an
 * order whose hold is still pending first expires its open checkout at
 * Stripe (archiveOrder), so the customer's link no longer works.
 * A return link pairs with an order only when it names that order's own
 * session: Stripe's `session_id` or PayPal's `token`. One naming none pairs
 * with nothing, and nothing is reconciled for it.
 * The tab title runs the same read, pairing check and reconcile as the page,
 * so it names the state the page shows even when it is read first, and pairs
 * a PayPal return (`token`) exactly as the page does. Within one request the
 * two share that read (React `cache()`), so Stripe is asked once. The next
 * request, such as the page's own auto-refresh, reads the order afresh.
 *
 * The world: Rental Confirmation, the DEFAULT organization (its brand is the
 * deployment Branding singleton), on deployment Stripe with MANUAL capture,
 * its Stripe events delivered to the deployment endpoint (POST
 * /api/webhooks/stripe); FlightBizz (GlobeVista) selling flights and hotels
 * on MANUAL Stripe keys of its own, its events delivered to its own
 * endpoint (POST /api/webhooks/stripe/globevista).
 */

/**
 * ONE SERVER REQUEST. Next resolves the tab title (generateMetadata) and the
 * page separately, and may stream the title after the page. React's
 * `cache()` is what lets them share one read of the order. That memoization
 * exists only in React's server build. Vitest loads the client build, whose
 * `cache()` passes every call straight through. This stand-in memoizes the
 * way the server build does inside `visit()`: the same function called with
 * the same arguments gets the first call's promise. Everywhere else it
 * passes calls through, exactly like the client build, so every other test
 * runs unchanged.
 */
const serverRequest = vi.hoisted(() => ({
  memo: null as Map<unknown, Map<string, unknown>> | null,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    cache:
      <Args extends unknown[], Result>(fn: (...args: Args) => Result) =>
      (...args: Args): Result => {
        const memo = serverRequest.memo;
        if (!memo) return fn(...args);
        const calls = memo.get(fn) ?? new Map<string, unknown>();
        memo.set(fn, calls);
        const key = JSON.stringify(args);
        if (!calls.has(key)) calls.set(key, fn(...args));
        return calls.get(key) as Result;
      },
  };
});

const SESSION = "cs_test_hold_states";
const RENTAL = "Rental Confirmation";
const FLIGHTBIZZ = "FlightBizz";

const AUTHORIZED_AT = new Date("2026-10-06T10:00:00.000Z");
const EXPIRES_AT = new Date("2026-10-13T10:00:00.000Z");
const RELEASED_AT = new Date("2026-10-07T09:00:00.000Z");
const PAID_AT = new Date("2026-10-08T12:00:00.000Z");

/** Stripe's message for a card declined at checkout — the reason a failed
 *  order records. */
const CARD_DECLINED = "Your card was declined.";

/** FlightBizz's own Stripe account — test credentials, set the way
 *  production sets them (env), restored after each test. */
const FLIGHTBIZZ_ENV: Record<string, string> = {
  ORG_GLOBEVISTA_STRIPE_SECRET_KEY: "sk_test_globevista_only",
  ORG_GLOBEVISTA_STRIPE_WEBHOOK_SECRET: "whsec_globevista_only",
};

const operator = actorFor(UserRole.ADMIN, { name: "Olivia Operator" });

let rental: Types.ObjectId;
let flightBizz: Types.ObjectId;
let envBefore: Record<string, string | undefined> = {};
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  envBefore = Object.fromEntries(
    Object.keys(FLIGHTBIZZ_ENV).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, FLIGHTBIZZ_ENV);
  await Branding.findOneAndUpdate(
    { key: "default" },
    {
      $set: {
        key: "default",
        brandName: RENTAL,
        supportEmail: "support@rentalconfirmation.test",
        supportPhone: "+15550001111",
        primaryColor: "#0B1220",
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  rental = (
    await Organization.create({
      slug: "rentalconfirmation",
      name: RENTAL,
      brandName: RENTAL,
      isDefault: true,
      payments: { provider: PaymentGatewayKey.STRIPE, captureMode: CaptureMode.MANUAL },
      serviceTypes: [ServiceType.CAR_RENTAL],
    })
  )._id as Types.ObjectId;
  flightBizz = (
    await Organization.create({
      slug: "globevista",
      name: "GlobeVista",
      brandName: FLIGHTBIZZ,
      isDefault: false,
      payments: { provider: PaymentGatewayKey.STRIPE, captureMode: CaptureMode.MANUAL },
      serviceTypes: [ServiceType.FLIGHT, ServiceType.HOTEL],
    })
  )._id as Types.ObjectId;
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  setNextHeaders({});
  for (const [k, before] of Object.entries(envBefore)) {
    if (before === undefined) delete process.env[k];
    else process.env[k] = before;
  }
});

/* ------------------------------------------------------------------ *
 * Orders and renders
 * ------------------------------------------------------------------ */

/** A manual-capture record in `status`, as the webhook, capture and release
 *  services leave it (their own files pin those transitions). */
function heldCapture(
  status: PaymentCaptureStatus,
  overrides: Record<string, unknown> = {},
) {
  const released =
    status === PaymentCaptureStatus.CANCELLED ||
    status === PaymentCaptureStatus.AUTHORIZATION_EXPIRED;
  return {
    method: CaptureMode.MANUAL,
    status,
    authorizedAt: AUTHORIZED_AT,
    amountAuthorized: 199.5,
    captureExpiresAt: EXPIRES_AT,
    ...(released
      ? {
          cancelledAt: RELEASED_AT,
          cancelReason:
            status === PaymentCaptureStatus.CANCELLED ? "abandoned" : "automatic",
        }
      : {}),
    ...(status === PaymentCaptureStatus.CAPTURE_FAILED
      ? { lastError: "Your card was declined." }
      : {}),
    ...overrides,
  };
}

/** An order the customer is returning for — a Rental Confirmation car
 *  unless the seed says otherwise — pinned to Stripe and to SESSION (or to
 *  the session its `payment` names). */
async function seeded(seed: OrderSeed) {
  const status = seed.status ?? OrderStatus.PAYMENT_PENDING;
  const paid = status === OrderStatus.PAID;
  const doc = await factoryCreateOrder({
    organizationId: rental,
    ...seed,
    status,
    payment: {
      status,
      stripeSessionId: SESSION,
      paidAt: paid ? PAID_AT : null,
      amountReceived: paid ? (seed.pricing?.amount ?? 199.5) : null,
      processedWebhookEventIds: [],
      ...(seed.payment ?? {}),
    } as OrderSeed["payment"],
  });
  await Order.updateOne({ _id: doc._id }, { $set: { "payment.gateway": PaymentGatewayKey.STRIPE } });
  return doc;
}

const withHold = (status: PaymentCaptureStatus, overrides: Record<string, unknown> = {}) =>
  ({ capture: heldCapture(status, overrides) }) as unknown as OrderSeed["payment"];

/** $199.50 online plus a $100.00 deposit at the rental counter. */
const COUNTER_BALANCE: OrderSeed["charges"] = [
  { name: "Rental cost", amount: 199.5, timing: PaymentTiming.PREPAID },
  { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
];

/** A car booking an operator enters at $249.99 online plus a $100.00
 *  deposit at the rental counter. */
const counterBalanceInput = () =>
  validCreateOrderInput({
    charges: [
      { name: "Rental cost", amount: 249.99, timing: PaymentTiming.PREPAID },
      { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
    ],
  });

/** A FlightBizz itinerary flight: $400 airline charge, $100 collected under
 *  `chargeName` (by default the name a new order stores for a blank one). */
const itineraryFlightSeed = (chargeName: string = DEFAULT_FLIGHT_CHARGE_NAME): OrderSeed => ({
  organizationId: flightBizz,
  serviceType: ServiceType.FLIGHT,
  flight: itineraryFlight({ airlineFare: 400 }),
  pricing: { amount: 100, currency: Currency.USD },
  charges: [{ name: chargeName, amount: 100, timing: PaymentTiming.PREPAID }],
});

function visibleText(html: string): string {
  return html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
}

/** The page as the returning customer gets it: its element tree and its
 *  visible text, whitespace collapsed. Rendered ONCE — a render may
 *  reconcile with the gateway. */
async function renderPage(
  orderNumber: string,
  query: Record<string, string> = { session_id: SESSION },
) {
  const page = await PaymentSuccessPage({
    searchParams: Promise.resolve({ order: orderNumber, ...query }),
  } as Parameters<typeof PaymentSuccessPage>[0]);
  return { page, text: visibleText(renderToStaticMarkup(page)) };
}

async function receiptText(
  orderNumber: string,
  query: Record<string, string> = { session_id: SESSION },
): Promise<string> {
  return (await renderPage(orderNumber, query)).text;
}

/** The browser tab's title for the same return URL the page was given. It
 *  runs the page's own read — and may reconcile, exactly as a render does. */
async function tabTitle(
  orderNumber: string,
  query: Record<string, string> = { session_id: SESSION },
): Promise<string> {
  const meta = await generateMetadata({
    searchParams: Promise.resolve({ order: orderNumber, ...query }),
  } as Parameters<typeof generateMetadata>[0]);
  return meta.title.absolute;
}

/** One visit to the return URL, as Next serves it: the tab title and the
 *  page resolved side by side in ONE request, sharing whatever they read
 *  through React `cache()` (see `serverRequest`). */
async function visit(orderNumber: string, query: Record<string, string>) {
  serverRequest.memo = new Map();
  try {
    const [title, { page, text }] = await Promise.all([
      tabTitle(orderNumber, query),
      renderPage(orderNumber, query),
    ]);
    return { title, page, text };
  } finally {
    serverRequest.memo = null;
  }
}

type AutoRefreshElement = ReactElement<ComponentProps<typeof PaymentSuccessAutoRefresh>>;

/** The page's "still confirming" status line, or null when it shows none. */
function findAutoRefresh(node: ReactNode): AutoRefreshElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findAutoRefresh(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === PaymentSuccessAutoRefresh) return node as AutoRefreshElement;
  return findAutoRefresh((node.props as { children?: ReactNode }).children);
}

/** What that line tells the customer once its refresh cap has run out — a
 *  zero cap paints the exhausted state on the first render. */
function hintAfterTheCap(page: ReactElement): string {
  const line = findAutoRefresh(page);
  expect(line, "the page shows no 'still confirming' line").not.toBeNull();
  return visibleText(renderToStaticMarkup(cloneElement(line!, { capSeconds: 0 }))).trim();
}

/** Whether the hero shows its spinning "still confirming" icon. */
function heroSpins(page: ReactElement): boolean {
  return renderToStaticMarkup(page).includes("animate-spin");
}

/** The hero's icon, the page's first drawing: "info" (a circled i, a
 *  status with no money to report), "card" (a hold), "spinner" (still
 *  confirming) or "check" (paid). */
function heroIcon(page: ReactElement): "info" | "card" | "spinner" | "check" | "none" {
  const svg = renderToStaticMarkup(page).match(/<svg[\s\S]*?<\/svg>/)?.[0];
  if (!svg) return "none";
  if (svg.includes("animate-spin")) return "spinner";
  if (svg.includes('d="M12 16v-4"') && svg.includes('d="M12 8h.01"')) return "info";
  if (svg.includes("<rect")) return "card";
  if (svg.includes('d="M20 6 9 17l-5-5"')) return "check";
  return "none";
}

/** The hero's colour: the tone of its icon's disc and of the eyebrow over
 *  the heading — "slate" (neutral, no money to report), "sky" (a hold),
 *  "amber" (still confirming) or "emerald" (paid). */
function heroTone(page: ReactElement): { disc: string | null; eyebrow: string | null } {
  const html = renderToStaticMarkup(page);
  return {
    disc: html.match(/h-14 w-14 items-center justify-center rounded-full bg-(\w+)-100/)?.[1] ?? null,
    eyebrow:
      html.match(/mt-5 text-xs font-semibold uppercase tracking-\[0\.18em\] text-(\w+)-\d+/)?.[1] ??
      null,
  };
}

/** `work` done by an operator signed in and working in `orgId`. The
 *  customer's browser that follows carries no session and no organization. */
async function asOperatorIn<T>(orgId: Types.ObjectId, work: () => Promise<T>): Promise<T> {
  sessionMock = await mockSession(operator);
  setNextHeaders({ cookies: { [orgCookieName()]: String(orgId) } });
  try {
    return await work();
  } finally {
    sessionMock.restore();
    sessionMock = null;
    setNextHeaders({});
  }
}

/** An operator working in `orgId` creates the booking and generates its
 *  payment link — the real services, against the Stripe stub. */
async function linkedOrder(
  orgId: Types.ObjectId,
  input: Parameters<typeof createOrder>[0] = validCreateOrderInput(),
): Promise<OrderDTO> {
  return asOperatorIn(orgId, async () => {
    const { order } = await createOrder(input, { actor: operator });
    return (await initiatePayment(order.id, { actor: operator })).order;
  });
}

/** An operator working in `orgId` creates the booking and stops there: a
 *  draft (NOT_INITIATED), with no payment link and so no payment session. */
async function draftOrder(
  orgId: Types.ObjectId,
  input: Parameters<typeof createOrder>[0] = validCreateOrderInput(),
): Promise<OrderDTO> {
  return asOperatorIn(orgId, async () => (await createOrder(input, { actor: operator })).order);
}

/** The Checkout session the stub created for `order` — what Stripe answers
 *  when asked about it. */
function checkoutOf(order: OrderDTO): {
  status: string;
  payment_status?: string;
  payment_intent?: string | null;
} {
  const created = getCurrentTestStripe().sessionsCreated.find(
    (s) => s.result.id === order.payment.paymentSessionId,
  );
  expect(created, `no Checkout session was created for ${order.orderNumber}`).toBeTruthy();
  return created!.result as unknown as {
    status: string;
    payment_status?: string;
    payment_intent?: string | null;
  };
}

/** A $199.50 manual-capture Checkout session the stub answers for, in
 *  `state` — for an order seeded straight into the database whose return
 *  the page reconciles. Created through the stub's own API, as link
 *  generation creates one. */
async function stubCheckout(state: { status: string; payment_status?: string }): Promise<string> {
  const session = await getCurrentTestStripe()
    .asStripe()
    .checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: 19950,
            product_data: { name: "Rental cost" },
          },
        },
      ],
      payment_intent_data: { capture_method: "manual" },
    });
  Object.assign(session, state);
  return session.id;
}

/** Rental Confirmation's capture mode, switched with the one-field write
 *  scripts/set-organization-capture-mode.ts makes. */
async function setRentalCaptureMode(mode: CaptureMode) {
  await Organization.collection.updateOne(
    { _id: rental },
    { $set: { "payments.captureMode": mode } },
  );
}

/** Every question the page puts to Stripe about a session: the reconcile's
 *  `checkout.sessions.retrieve`. */
function stripeSessionLookups() {
  return vi.spyOn(getCurrentTestStripe().asStripe().checkout.sessions, "retrieve");
}

async function stored(orderId: string) {
  const doc = await Order.findById(orderId).lean();
  expect(doc, `order ${orderId} is missing`).toBeTruthy();
  return doc!;
}

/** What has been recorded about the order: the audit rows that name it — a
 *  duplicate-event row is keyed by the event id and names the order in its
 *  metadata — and the gateway event ids claimed for it. */
async function trailOf(orderId: string) {
  const [audits, claims] = await Promise.all([
    AuditLog.find({ $or: [{ entityId: orderId }, { "metadata.orderId": orderId }] }).lean(),
    ProcessedWebhookEvent.find({ orderId }).lean(),
  ]);
  return {
    audits: audits.map((row) => row.action),
    claims: claims.map((row) => row.gatewayEventId),
  };
}

interface WebhookReply {
  received: true;
  handled: boolean;
  duplicate: boolean;
  orderId?: string;
  reason?: string;
}

/** Stripe's delivery of `event` to the deployment endpoint, POST
 *  /api/webhooks/stripe, which serves Rental Confirmation: signed with the
 *  deployment secret, carrying no operator cookies. Acknowledged (200) —
 *  the endpoint's verdict. */
async function deliver(event: Stripe.Event): Promise<WebhookReply> {
  const payload = JSON.stringify(event);
  const { status, body } = await jsonBody<ApiEnvelope<WebhookReply>>(
    await deploymentWebhook(
      buildRequest("/api/webhooks/stripe", {
        method: "POST",
        body: payload,
        headers: {
          "stripe-signature": signWebhook(payload, process.env.STRIPE_WEBHOOK_SECRET!),
        },
      }),
    ),
  );
  expect(status, JSON.stringify(body)).toBe(200);
  expectOk(body);
  return body.data;
}

/** Stripe's delivery of `event` from FlightBizz's own account to its own
 *  endpoint, POST /api/webhooks/stripe/globevista: signed with FlightBizz's
 *  secret, carrying no operator cookies. Acknowledged (200) — the
 *  endpoint's verdict. */
async function deliverToFlightBizz(event: Stripe.Event): Promise<WebhookReply> {
  const payload = JSON.stringify(event);
  const { status, body } = await jsonBody<ApiEnvelope<WebhookReply>>(
    await brandWebhook(
      buildRequest("/api/webhooks/stripe/globevista", {
        method: "POST",
        body: payload,
        headers: {
          "stripe-signature": signWebhook(
            payload,
            FLIGHTBIZZ_ENV.ORG_GLOBEVISTA_STRIPE_WEBHOOK_SECRET,
          ),
        },
      }),
      { params: Promise.resolve({ orgSlug: "globevista" }) },
    ),
  );
  expect(status, JSON.stringify(body)).toBe(200);
  expectOk(body);
  return body.data;
}

/**
 * The customer's first card is declined at checkout: Stripe's
 * `payment_intent.payment_failed` for the intent behind the order's session,
 * through the real webhook. The order is FAILED by the service that fails
 * it, and its capture record (PENDING_AUTHORIZATION on a manual order, null
 * on an automatic one) is left as it was.
 *
 * The order is given production's shape first. A Checkout Session has no
 * PaymentIntent until the customer pays, so the order records none (the
 * stub mints one with every session) and the webhook asks Stripe which
 * intent the session holds. It holds this one, so the decline is current,
 * not a replaced link's. Returns that session, still open (Checkout lets the
 * customer try another card on it), and its intent.
 */
async function declinedAtCheckout(order: OrderDTO) {
  await Order.updateOne({ _id: order.id }, { $set: { "payment.paymentIntentId": null } });
  const checkout = checkoutOf(order);
  const intentId = checkout.payment_intent;
  expect(intentId, "the checkout names no intent").toMatch(/^pi_/);
  const decline = buildPaymentIntentFailed({ paymentIntentId: intentId!, message: CARD_DECLINED });
  // Stripe's event carries the order's metadata; the factory's carries none.
  Object.assign(decline.data.object, {
    metadata: { orderId: order.id, orderNumber: order.orderNumber },
  });

  expect(await deliver(decline)).toEqual({
    received: true,
    handled: true,
    duplicate: false,
    orderId: order.id,
  });
  const failed = await stored(order.id);
  expect(failed.status).toBe(OrderStatus.FAILED);
  expect(failed.payment.status).toBe(OrderStatus.FAILED);
  expect(failed.payment.failureReason).toBe(CARD_DECLINED);
  expect(failed.payment.paymentIntentId ?? null).toBeNull();
  expect(failed.payment.capture?.status ?? null).toBe(order.payment.capture?.status ?? null);
  expect(checkout.status).toBe("open");
  return { checkout, intentId: intentId! };
}

/**
 * A link the customer has not used: an operator working in `orgId` creates
 * the booking and generates its payment link (LINK_GENERATED; on a MANUAL
 * brand the hold is PENDING_AUTHORIZATION), in production's shape. A
 * Checkout Session has no PaymentIntent until the customer pays, so the
 * order records none (the stub mints one with every session).
 */
async function unusedLink(
  orgId: Types.ObjectId,
  input: Parameters<typeof createOrder>[0] = validCreateOrderInput(),
): Promise<OrderDTO> {
  const order = await linkedOrder(orgId, input);
  await Order.updateOne({ _id: order.id }, { $set: { "payment.paymentIntentId": null } });
  return order;
}

/** The payment request email went out: the send-payment-request route's
 *  own conditional write after a successful send (LINK_GENERATED →
 *  PAYMENT_PENDING). That route's own files pin the send. */
async function requestSent(order: OrderDTO) {
  const { modifiedCount } = await Order.updateOne(
    { _id: order.id, status: OrderStatus.LINK_GENERATED },
    {
      $set: {
        status: OrderStatus.PAYMENT_PENDING,
        "payment.status": OrderStatus.PAYMENT_PENDING,
      },
    },
  );
  expect(modifiedCount).toBe(1);
}

/** The operator archives the order from its page (DELETE /api/orders/[id],
 *  the Archive button), working in the order's organization. */
async function archivedByOperator(
  order: OrderDTO,
  orgId: Types.ObjectId = rental,
): Promise<OrderDTO> {
  const { status, body } = await asOperatorIn(orgId, async () =>
    jsonBody<ApiEnvelope<OrderDTO>>(
      await archiveOrderRoute(
        buildRequest(`/api/orders/${order.id}`, {
          method: "DELETE",
          body: { reason: "Customer changed plans" },
        }),
        { params: Promise.resolve({ id: order.id }) },
      ),
    ),
  );
  expect(status, JSON.stringify(body)).toBe(200);
  expectOk(body);
  expect(body.data.state).toBe(RecordState.ARCHIVED);
  return body.data;
}

/** Archiving a manual order whose hold was still pending expired its open
 *  checkout at Stripe (archiveOrder), and Stripe reports it expired from
 *  then on. The stub records the expiry but keeps answering "open", so the
 *  answer Stripe now gives is set here. */
function checkoutExpiredByTheArchive(order: OrderDTO) {
  expect(getCurrentTestStripe().sessionsExpired).toEqual([order.payment.paymentSessionId]);
  Object.assign(checkoutOf(order), { status: "expired" });
}

/** The checkout's own deadline passed before the customer paid: Stripe
 *  reports it expired from then on, and its checkout.session.expired
 *  reaches the endpoint serving the order's brand (`to`: the deployment
 *  endpoint unless told otherwise). The webhook makes the order EXPIRED. */
async function checkoutExpiredAtStripe(
  order: OrderDTO,
  to: (event: Stripe.Event) => Promise<WebhookReply> = deliver,
) {
  Object.assign(checkoutOf(order), { status: "expired" });
  expect(
    await to(
      buildCheckoutExpired({
        sessionId: order.payment.paymentSessionId!,
        orderId: order.id,
        orderNumber: order.orderNumber,
      }),
    ),
  ).toEqual({ received: true, handled: true, duplicate: false, orderId: order.id });
}

/** What a hold that was let go may never be called: paid, being paid, held,
 *  or still in flight — nor may its page claim anything about the booking
 *  (a lapsed hold says nothing about whether it was ever confirmed). */
const NEVER_ON_A_RELEASED_HOLD = [
  "Payment received",
  "Payment confirmed",
  "Amount paid",
  "Payment processed",
  "Confirming with",
  "We’re confirming",
  "refreshes automatically",
  "Card authorized",
  "Amount on hold",
  "Card hold today",
  "Authorization expires",
  "confirmed",
];

const RELEASE_TAIL =
  "You have not been charged, and this hold will never be collected. Your bank may take a few days to remove the pending amount from your statement.";

/* ------------------------------------------------------------------ *
 * Released — the operator let the hold go
 * ------------------------------------------------------------------ */

describe("a RELEASED hold (capture CANCELLED): the customer hears they were never charged", () => {
  it.each([OrderStatus.PAYMENT_PENDING, OrderStatus.LINK_GENERATED])(
    "on a %s car order: 'Hold released' / 'You have not been charged', the release in the brand's words, the amount 'Hold released — not charged', the card-details trust line — never a payment, never a spinner",
    async (status) => {
      const order = await seeded({ status, payment: withHold(PaymentCaptureStatus.CANCELLED) });
      const { page, text } = await renderPage(order.orderNumber);

      expect(text).toContain(
        `Hold released You have not been charged ${RENTAL} has released the hold on your card for $199.50. ${RELEASE_TAIL}`,
      );
      expect(text).toContain(`Hold released — not charged $199.50 Order ${order.orderNumber}`);
      expect(text).toContain("Card details handled securely by Stripe — PCI-DSS Level 1 certified.");
      for (const phrase of NEVER_ON_A_RELEASED_HOLD) {
        expect(text, `released hold says "${phrase}"`).not.toContain(phrase);
      }
      // Settled: nothing left to wait for, so nothing refreshes.
      expect(findAutoRefresh(page)).toBeNull();
      expect(await tabTitle(order.orderNumber)).toBe(`Hold released • ${RENTAL}`);
    },
  );

  it("a car with a counter balance: the breakdown's online row reads 'Hold released — not charged' where it said 'Paid online today', and the balance and total stay", async () => {
    const order = await seeded({
      charges: COUNTER_BALANCE,
      payment: withHold(PaymentCaptureStatus.CANCELLED),
    });
    const text = await receiptText(order.orderNumber);

    expect(text).toContain(
      "Charge breakdown Hold released — not charged $199.50 " +
        "Remaining balance due at rental counter $100.00 Total rental cost $299.50",
    );
    expect(text).not.toContain("Paid online today");
    expect(text).not.toContain("Authorized online today");
  });
});

/* ------------------------------------------------------------------ *
 * Expired — Stripe let the hold lapse
 * ------------------------------------------------------------------ */

describe("an EXPIRED hold (capture AUTHORIZATION_EXPIRED): Stripe let it lapse", () => {
  it("car: 'The hold on your card for $199.50 has expired and been released' — not the operator's release, nothing claimed about the booking, and never a payment", async () => {
    const order = await seeded({ payment: withHold(PaymentCaptureStatus.AUTHORIZATION_EXPIRED) });
    const text = await receiptText(order.orderNumber);

    expect(text).toContain(
      `Hold released You have not been charged The hold on your card for $199.50 has expired and been released. ${RELEASE_TAIL}`,
    );
    expect(text).not.toContain("has released the hold");
    expect(text).toContain(`Hold released — not charged $199.50 Order ${order.orderNumber}`);
    expect(text).toContain("Card details handled securely by Stripe — PCI-DSS Level 1 certified.");
    for (const phrase of NEVER_ON_A_RELEASED_HOLD) {
      expect(text, `expired hold says "${phrase}"`).not.toContain(phrase);
    }
    expect(await tabTitle(order.orderNumber)).toBe(`Hold released • ${RENTAL}`);
  });

  it("hotel: the same lapse — 'The hold on your card for $300.00 has expired and been released' — with the property balance under the released row", async () => {
    const order = await seeded({
      organizationId: flightBizz,
      serviceType: ServiceType.HOTEL,
      pricing: { amount: 300, currency: Currency.USD },
      charges: [
        { name: "Room charge", amount: 300, timing: PaymentTiming.PREPAID },
        { name: "Resort fee", amount: 50, timing: PaymentTiming.DUE_AT_COUNTER },
      ],
      payment: withHold(PaymentCaptureStatus.AUTHORIZATION_EXPIRED, { amountAuthorized: 300 }),
    });
    const text = await receiptText(order.orderNumber);

    expect(text).toContain(
      `Hold released You have not been charged The hold on your card for $300.00 has expired and been released. ${RELEASE_TAIL}`,
    );
    expect(text).toContain(
      "Charge breakdown Hold released — not charged $300.00 " +
        "Remaining balance due at the property $50.00 Total hotel cost $350.00",
    );
    for (const phrase of NEVER_ON_A_RELEASED_HOLD) {
      expect(text, `expired hold says "${phrase}"`).not.toContain(phrase);
    }
    expect(await tabTitle(order.orderNumber)).toBe(`Hold released • ${FLIGHTBIZZ}`);
  });
});

/* ------------------------------------------------------------------ *
 * Released, then archived — no longer waiting on the gateway
 * ------------------------------------------------------------------ */

describe("a hold that was let go, on an order the operator then archived", () => {
  // Archiving a PAYMENT_PENDING order moves it to EXPIRED and leaves the
  // hold record alone (archiveOrder). Once the order is not waiting on the
  // gateway, a page that lost track of the release would not show the
  // spinner. It would show the paid receipt.
  it.each([
    {
      capture: PaymentCaptureStatus.CANCELLED,
      lead: `${RENTAL} has released the hold on your card for $199.50.`,
    },
    {
      capture: PaymentCaptureStatus.AUTHORIZATION_EXPIRED,
      lead: "The hold on your card for $199.50 has expired and been released.",
    },
  ])(
    "$capture on an archived (EXPIRED) car order: still 'Hold released' / 'You have not been charged', in the tab title too — never 'Payment received'",
    async ({ capture, lead }) => {
      const order = await seeded({
        status: OrderStatus.EXPIRED,
        state: RecordState.ARCHIVED,
        payment: withHold(capture),
      });
      const { page, text } = await renderPage(order.orderNumber);

      expect(text).toContain(`Hold released You have not been charged ${lead} ${RELEASE_TAIL}`);
      expect(text).toContain(`Hold released — not charged $199.50 Order ${order.orderNumber}`);
      expect(text).toContain("Card details handled securely by Stripe — PCI-DSS Level 1 certified.");
      for (const phrase of NEVER_ON_A_RELEASED_HOLD) {
        expect(text, `archived released hold says "${phrase}"`).not.toContain(phrase);
      }
      expect(findAutoRefresh(page)).toBeNull();
      expect(await tabTitle(order.orderNumber)).toBe(`Hold released • ${RENTAL}`);
    },
  );
});

/* ------------------------------------------------------------------ *
 * Still standing — a hold on an order no longer awaiting the gateway
 * ------------------------------------------------------------------ */

describe("a hold that still stands on an order no longer awaiting the gateway (EXPIRED): still a hold, never 'nothing was charged'", () => {
  // Stripe's authorization is recorded whatever the order's status
  // (applyPaymentAuthorized), so a hold can stand on an order that is no
  // longer awaiting the gateway. That money is held. A page that read every
  // unpaid manual order not awaiting the gateway as never held would tell
  // this customer nothing was charged and the link is dead.
  it.each([
    PaymentCaptureStatus.AUTHORIZED,
    PaymentCaptureStatus.CAPTURE_PENDING,
    PaymentCaptureStatus.CAPTURE_FAILED,
  ])(
    "%s on an archived (EXPIRED) car order: 'Card authorized' / 'Your card has been authorized', the hold placed on the card, the amount on hold, the card-authorized trust line and the card icon on a hold-blue hero, title 'Card authorized • <brand>' — never 'Payment status', 'no longer active' or 'Not charged', never a payment, and Stripe is never asked",
    async (capture) => {
      const order = await seeded({
        status: OrderStatus.EXPIRED,
        state: RecordState.ARCHIVED,
        payment: withHold(capture),
      });
      const lookups = stripeSessionLookups();

      const { title, page, text } = await visit(order.orderNumber, { session_id: SESSION });

      expect(text).toContain(
        `Card authorized Your card has been authorized ${RENTAL} has placed a hold on your card for $199.50. You have not been charged yet`,
      );
      expect(text).toContain(
        `Amount on hold $199.50 Order ${order.orderNumber} ${formatDateTime(AUTHORIZED_AT)}`,
      );
      expect(text).toContain("Card authorized securely by Stripe — PCI-DSS Level 1 certified.");
      for (const phrase of [
        "Payment status",
        "no longer active",
        "nothing was charged",
        "Not charged",
        "Card details handled",
        "Payment received",
        "Payment confirmed",
        "Amount paid",
        "Payment processed",
        "Hold released",
        "Confirming with",
        "refreshes automatically",
      ]) {
        expect(text, `a hold standing on an EXPIRED order says "${phrase}"`).not.toContain(phrase);
      }
      expect(heroIcon(page)).toBe("card");
      expect(heroTone(page)).toEqual({ disc: "sky", eyebrow: "sky" });
      expect(findAutoRefresh(page)).toBeNull();
      expect(title).toBe(`Card authorized • ${RENTAL}`);
      // Not awaiting the gateway: nothing is asked, and the order is left
      // exactly as recorded.
      expect(lookups).not.toHaveBeenCalled();
      const doc = await stored(String(order._id));
      expect(doc.status).toBe(OrderStatus.EXPIRED);
      expect(doc.payment.capture?.status).toBe(capture);
    },
  );
});

/* ------------------------------------------------------------------ *
 * An itinerary flight's released / expired hold names the charge
 * ------------------------------------------------------------------ */

describe("an itinerary flight's released or expired hold names the charge it held", () => {
  it.each([
    {
      capture: PaymentCaptureStatus.CANCELLED,
      lead: `${FLIGHTBIZZ} has released the hold on your card for the ${DEFAULT_FLIGHT_CHARGE_NAME} of $100.00.`,
    },
    {
      capture: PaymentCaptureStatus.AUTHORIZATION_EXPIRED,
      lead: `The hold on your card for the ${DEFAULT_FLIGHT_CHARGE_NAME} of $100.00 has expired and been released.`,
    },
  ])(
    "$capture: the hero names the Service Charge, and the hero label and the breakdown's last row read 'Hold released — not charged' — never On Hold, Paid or Payable Now",
    async ({ capture, lead }) => {
      const order = await seeded({
        ...itineraryFlightSeed(),
        payment: withHold(capture, { amountAuthorized: 100 }),
      });
      const text = await receiptText(order.orderNumber);

      expect(text).toContain(`Hold released You have not been charged ${lead} ${RELEASE_TAIL}`);
      expect(text).toContain(`Hold released — not charged $100.00 Order ${order.orderNumber}`);
      const box = text.slice(text.indexOf(FLIGHT_AMOUNT_LABELS.breakdownTitle));
      expect(box).toContain(
        [
          FLIGHT_AMOUNT_LABELS.airlineFare,
          FLIGHT_AMOUNT_LABELS.airlineFareNote,
          "$400.00",
          FLIGHT_AMOUNT_LABELS.serviceCharge,
          "$100.00",
          FLIGHT_AMOUNT_LABELS.bookingTotal,
          "$500.00",
          "Hold released — not charged",
          "$100.00",
          FLIGHT_AMOUNT_LABELS.airlineFareExplainer,
        ].join(" "),
      );
      expect(text).not.toContain("On Hold");
      expect(text).not.toMatch(/\bPaid\b/);
      expect(text).not.toContain("Payable Now");
      for (const phrase of NEVER_ON_A_RELEASED_HOLD) {
        expect(text, `released flight hold says "${phrase}"`).not.toContain(phrase);
      }
      expect(await tabTitle(order.orderNumber)).toBe(`Hold released • ${FLIGHTBIZZ}`);
    },
  );

  it("an operator-named charge is released by its own name — 'for the Agency Fee of $100.00' — never 'Service Charge'", async () => {
    const order = await seeded({
      ...itineraryFlightSeed("Agency Fee"),
      payment: withHold(PaymentCaptureStatus.CANCELLED, { amountAuthorized: 100 }),
    });
    const text = await receiptText(order.orderNumber);
    const labels = flightLabelsWithCharge("Agency Fee");

    expect(text).toContain(
      `${FLIGHTBIZZ} has released the hold on your card for the Agency Fee of $100.00. ${RELEASE_TAIL}`,
    );
    expect(text).toContain(
      `Agency Fee $100.00 ${FLIGHT_AMOUNT_LABELS.bookingTotal} $500.00 Hold released — not charged $100.00`,
    );
    expect(text).not.toContain(labels.heldNow);
    expect(text).not.toContain(labels.paidNow);
    expect(text.toLowerCase()).not.toContain("service charge");
  });
});

/* ------------------------------------------------------------------ *
 * Never held — the link died before the customer authorized
 * ------------------------------------------------------------------ */

describe("a manual order whose link died before any hold (EXPIRED, the hold still PENDING_AUTHORIZATION): the customer hears nothing was charged", () => {
  // Archiving a PAYMENT_PENDING order makes it EXPIRED. A LINK_GENERATED
  // one keeps its status, so its page still asks Stripe (archiveOrder).
  // Nothing was ever held. Once the order is not waiting on the gateway, a
  // page that only knew paid, held and released would show the paid
  // receipt.

  /** What the page of an order that never held anything may not say: paid,
   *  received or receipted; held, authorized or released; payable; still
   *  confirming; or unmatched. */
  const NEVER_ON_AN_UNCHARGED_ORDER = [
    "Payment received",
    "Payment confirmed",
    "has confirmed your",
    "Amount paid",
    "Paid online today",
    "Payment processed",
    "Payable",
    "Confirming with",
    "We’re confirming",
    "finalise",
    "refreshes automatically",
    "Card authorized",
    "Amount on hold",
    "Card hold today",
    "Authorized online today",
    "Hold released",
    "Authorization expires",
    "We couldn’t match",
  ];

  /** The page and its tab title for an order that never held anything, in
   *  the order's brand: nothing charged, nothing held, nothing to wait for. */
  function expectNotCharged(
    { title, page, text }: Awaited<ReturnType<typeof visit>>,
    order: { brand: string; amount: string; orderNumber: string },
  ) {
    expect(text).toContain(
      "Payment status You have not been charged " +
        "This payment link is no longer active, and nothing was charged to your card. " +
        `Your latest email from ${order.brand} has the up-to-date details of your booking.`,
    );
    expect(text).toContain(`Not charged ${order.amount} Order ${order.orderNumber}`);
    expect(text).toContain("Card details handled securely by Stripe — PCI-DSS Level 1 certified.");
    for (const phrase of NEVER_ON_AN_UNCHARGED_ORDER) {
      expect(text, `an order never held says "${phrase}"`).not.toContain(phrase);
    }
    expect(text).not.toMatch(/\bPaid\b/);
    for (const word of ["receipt", "hold", "authoriz"]) {
      expect(text.toLowerCase(), `an order never held says "${word}"`).not.toContain(word);
    }
    // Settled, with no money to report: the info icon on a neutral hero —
    // never the paid green — nothing spinning, nothing refreshing.
    expect(heroIcon(page)).toBe("info");
    expect(heroTone(page)).toEqual({ disc: "slate", eyebrow: "slate" });
    expect(heroSpins(page)).toBe(false);
    expect(findAutoRefresh(page)).toBeNull();
    expect(title).toBe(`Payment status • ${order.brand}`);
  }

  /** How the link died. `killAsks`: Stripe lookups the death itself made.
   *  `pageAsks`: whether the order was still awaiting the gateway, so the
   *  visit asks Stripe and records the expiry. */
  const DEAD_LINKS = [
    {
      how: "archived by the operator once its request email had gone out, which expired its open checkout at Stripe and made the order EXPIRED",
      kill: async (order: OrderDTO) => {
        await requestSent(order);
        await archivedByOperator(order);
        checkoutExpiredByTheArchive(order);
      },
      archived: true,
      // Asked before the expiry and again after it (only "expired" archives).
      killAsks: 2,
      pageAsks: false,
    },
    {
      how: "archived by the operator while its link had only been copied (still LINK_GENERATED), which expired its checkout; the page asks Stripe, which reports it expired",
      kill: async (order: OrderDTO) => {
        await archivedByOperator(order);
        checkoutExpiredByTheArchive(order);
      },
      archived: true,
      killAsks: 2,
      pageAsks: true,
    },
    {
      how: "its checkout expired at Stripe, which said so (checkout.session.expired)",
      kill: (order: OrderDTO) => checkoutExpiredAtStripe(order),
      archived: false,
      killAsks: 0,
      pageAsks: false,
    },
    {
      how: "its checkout expired at Stripe before the webhook arrived; the page asks Stripe, which reports it expired",
      kill: async (order: OrderDTO) => {
        Object.assign(checkoutOf(order), { status: "expired" });
      },
      archived: false,
      killAsks: 0,
      pageAsks: true,
    },
  ];

  it.each(DEAD_LINKS)(
    "a car, $how: opened with its own session id, 'Payment status' / 'You have not been charged' / 'This payment link is no longer active, and nothing was charged to your card', the amount 'Not charged', the card-details trust line and the info icon on a neutral hero, title 'Payment status • <brand>' — never paid, received or receipted, never a hold, never a spinner",
    async ({ kill, archived, killAsks, pageAsks }) => {
      const order = await unusedLink(rental);
      expect(order.payment.capture).toMatchObject({
        method: CaptureMode.MANUAL,
        status: PaymentCaptureStatus.PENDING_AUTHORIZATION,
      });
      const sessionId = order.payment.paymentSessionId!;
      const lookups = stripeSessionLookups();

      await kill(order);

      expect(lookups.mock.calls.map(([id]) => id)).toEqual(Array(killAsks).fill(sessionId));
      expect((await stored(order.id)).status).toBe(
        pageAsks ? OrderStatus.LINK_GENERATED : OrderStatus.EXPIRED,
      );

      const visited = await visit(order.orderNumber, { session_id: sessionId });

      // One request: the page and its title share one read, so Stripe is
      // asked at most once, and only while the order awaited the gateway.
      expect(lookups.mock.calls.slice(killAsks).map(([id]) => id)).toEqual(
        pageAsks ? [sessionId] : [],
      );
      const doc = await stored(order.id);
      expect(doc.status).toBe(OrderStatus.EXPIRED);
      expect(doc.payment.status).toBe(OrderStatus.EXPIRED);
      expect(doc.state).toBe(archived ? RecordState.ARCHIVED : RecordState.ACTIVE);
      expect(doc.payment.capture).toMatchObject({
        method: CaptureMode.MANUAL,
        status: PaymentCaptureStatus.PENDING_AUTHORIZATION,
      });
      expect(doc.payment.paidAt ?? null).toBeNull();
      expectNotCharged(visited, { brand: RENTAL, amount: "$249.99", orderNumber: order.orderNumber });
    },
  );

  // The boundary. While the link still works, a customer back here may have
  // just authorized, so the page waits for the hold. That is the usual
  // return: the request email went out (PAYMENT_PENDING), or the link was
  // only copied (LINK_GENERATED). Neither is a dead link.
  it.each([
    { link: "its request email sent (PAYMENT_PENDING)", sent: true, status: OrderStatus.PAYMENT_PENDING },
    { link: "its link only copied (LINK_GENERATED)", sent: false, status: OrderStatus.LINK_GENERATED },
  ])(
    "a car, $link, its checkout still open and the hold not landed yet: still being confirmed, never 'nothing was charged' — 'We’re confirming your card' and the hold sentence, 'Card hold today', the spinner on an amber hero, title 'Confirming your card • <brand>' — Stripe asked once, nothing recorded",
    async ({ sent, status }) => {
      const order = await unusedLink(rental);
      if (sent) await requestSent(order);
      const sessionId = order.payment.paymentSessionId!;
      expect(checkoutOf(order).status).toBe("open");
      const lookups = stripeSessionLookups();
      const trailBefore = await trailOf(order.id);

      const { title, page, text } = await visit(order.orderNumber, { session_id: sessionId });

      expect(lookups.mock.calls.map(([id]) => id)).toEqual([sessionId]);
      const doc = await stored(order.id);
      expect(doc.status).toBe(status);
      expect(doc.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);
      expect(await trailOf(order.id)).toEqual(trailBefore);
      expect(text).toContain(
        `Confirming with Stripe We’re confirming your card ${RENTAL} is waiting for Stripe to confirm the hold on your card. ` +
          "You won’t be charged until your rental is confirmed. This page refreshes automatically.",
      );
      expect(text).toContain(`Card hold today $249.99 Order ${order.orderNumber}`);
      for (const phrase of [
        "Payment status",
        "You have not been charged",
        "no longer active",
        "nothing was charged",
        "Not charged",
        "Payment received",
        "Payment confirmed",
        "Amount paid",
      ]) {
        expect(text, `a live link, its hold still landing, says "${phrase}"`).not.toContain(phrase);
      }
      expect(heroIcon(page)).toBe("spinner");
      expect(heroTone(page)).toEqual({ disc: "amber", eyebrow: "amber" });
      expect(findAutoRefresh(page)).not.toBeNull();
      expect(title).toBe(`Confirming your card • ${RENTAL}`);
    },
  );

  it("an itinerary flight, FlightBizz's checkout expired (checkout.session.expired to its own endpoint): the same page in FlightBizz's name, the hero label and the breakdown's last row 'Not charged' — never '<charge> On Hold', '<charge> Paid' or 'Amount Payable Now'", async () => {
    const order = await unusedLink(
      flightBizz,
      oneWayConnectingFlightInput({ charges: flightServiceCharge(100, DEFAULT_FLIGHT_CHARGE_NAME) }),
    );
    expect(order.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);
    await checkoutExpiredAtStripe(order, deliverToFlightBizz);
    const lookups = stripeSessionLookups();

    const visited = await visit(order.orderNumber, { session_id: order.payment.paymentSessionId! });

    expect(lookups).not.toHaveBeenCalled();
    const doc = await stored(order.id);
    expect(doc.status).toBe(OrderStatus.EXPIRED);
    expect(doc.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);
    expectNotCharged(visited, {
      brand: FLIGHTBIZZ,
      amount: "$100.00",
      orderNumber: order.orderNumber,
    });
    const box = visited.text.slice(visited.text.indexOf(FLIGHT_AMOUNT_LABELS.breakdownTitle));
    expect(box).toContain(
      [
        FLIGHT_AMOUNT_LABELS.airlineFare,
        FLIGHT_AMOUNT_LABELS.airlineFareNote,
        "$400.00",
        DEFAULT_FLIGHT_CHARGE_NAME,
        "$100.00",
        FLIGHT_AMOUNT_LABELS.bookingTotal,
        "$500.00",
        "Not charged",
        "$100.00",
        FLIGHT_AMOUNT_LABELS.airlineFareExplainer,
      ].join(" "),
    );
    for (const phrase of [
      FLIGHT_AMOUNT_LABELS.heldNow,
      FLIGHT_AMOUNT_LABELS.paidNow,
      FLIGHT_AMOUNT_LABELS.payableNow,
      "On Hold",
    ]) {
      expect(visited.text, `a flight never held says "${phrase}"`).not.toContain(phrase);
    }
  });

  it("a car with a counter balance, archived once its request had gone out: the breakdown's online row reads 'Not charged' where it said 'Paid online today', and the balance and total stay", async () => {
    const order = await unusedLink(rental, counterBalanceInput());
    await requestSent(order);
    await archivedByOperator(order);
    checkoutExpiredByTheArchive(order);

    const visited = await visit(order.orderNumber, { session_id: order.payment.paymentSessionId! });

    expect((await stored(order.id)).status).toBe(OrderStatus.EXPIRED);
    expectNotCharged(visited, { brand: RENTAL, amount: "$249.99", orderNumber: order.orderNumber });
    expect(visited.text).toContain(
      `Not charged $249.99 Order ${order.orderNumber} ` +
        "Charge breakdown Not charged $249.99 " +
        "Remaining balance due at rental counter $100.00 Total rental cost $349.99",
    );
  });

  // The page has always shown an automatic order that is not awaiting the
  // gateway the paid receipt, an EXPIRED one included. Manual capture
  // leaves that alone, even once the organization has switched to MANUAL:
  // the page, the archive and the expiry all go by the order's own capture
  // record, and an automatic order has none.
  it.each([
    {
      how: "its checkout expired at Stripe (checkout.session.expired)",
      kill: (order: OrderDTO) => checkoutExpiredAtStripe(order),
    },
    {
      how: "archived by the operator once its request email had gone out, which retires nothing at Stripe",
      kill: async (order: OrderDTO) => {
        await requestSent(order);
        await archivedByOperator(order);
        expect(getCurrentTestStripe().sessionsExpired).toEqual([]);
      },
    },
  ])(
    "an AUTOMATIC car order (capture null, its link made before Rental Confirmation switched to MANUAL) with a counter balance, $how: EXPIRED, it reads exactly as before — 'Payment confirmed' / 'Payment received', 'Amount paid' and 'Paid online today', the payment trust line and the check icon on the green hero, title 'Payment received' — never 'Payment status', 'Not charged' or a hold, and Stripe is never asked",
    async ({ kill }) => {
      await setRentalCaptureMode(CaptureMode.AUTOMATIC);
      const order = await unusedLink(rental, counterBalanceInput());
      expect(order.payment.capture).toBeNull();
      await setRentalCaptureMode(CaptureMode.MANUAL);
      const lookups = stripeSessionLookups();

      await kill(order);
      const { title, page, text } = await visit(order.orderNumber, {
        session_id: order.payment.paymentSessionId!,
      });

      expect(lookups).not.toHaveBeenCalled();
      const doc = await stored(order.id);
      expect(doc.status).toBe(OrderStatus.EXPIRED);
      expect(doc.payment.capture ?? null).toBeNull();
      expect(text).toContain(
        `Payment confirmed Payment received Thank you. ${RENTAL} has confirmed your payment and a receipt is on its way to your inbox.`,
      );
      expect(text).toContain(
        `Amount paid $249.99 Order ${order.orderNumber} ` +
          "Charge breakdown Paid online today $249.99 " +
          "Remaining balance due at rental counter $100.00 Total rental cost $349.99",
      );
      expect(text).toContain("Payment processed securely by Stripe — PCI-DSS Level 1 certified.");
      expect(text.toLowerCase()).not.toContain("hold");
      for (const phrase of [
        "Payment status",
        "not been charged",
        "Not charged",
        "no longer active",
        "Confirming with",
        "We’re confirming",
        "refreshes automatically",
        "Card authorized",
        "Card details handled",
      ]) {
        expect(text, `an automatic EXPIRED order says "${phrase}"`).not.toContain(phrase);
      }
      expect(heroIcon(page)).toBe("check");
      expect(heroTone(page)).toEqual({ disc: "emerald", eyebrow: "emerald" });
      expect(findAutoRefresh(page)).toBeNull();
      expect(title).toBe(`Payment received • ${RENTAL}`);
    },
  );
});

/* ------------------------------------------------------------------ *
 * A hold that still stands while the capture is in flight or refused
 * ------------------------------------------------------------------ */

describe("a hold that still stands while the operator's capture is in flight or was refused", () => {
  it.each([PaymentCaptureStatus.CAPTURE_PENDING, PaymentCaptureStatus.CAPTURE_FAILED])(
    "%s on a car, Stripe still holding the card uncaptured: the page asks and keeps the hold — 'Card authorized', collected only once the rental is confirmed, the amount on hold, when it was authorized and when the authorization expires, the tab title — with no spinner, and asking records nothing (no claim, no duplicate-event row)",
    async (capture) => {
      // What Stripe reports while it still only holds the card: the checkout
      // completed, nothing captured.
      const sessionId = await stubCheckout({ status: "complete", payment_status: "unpaid" });
      const order = await seeded({
        charges: COUNTER_BALANCE,
        payment: { ...withHold(capture), stripeSessionId: sessionId } as OrderSeed["payment"],
      });
      const lookups = stripeSessionLookups();
      const trailBefore = await trailOf(String(order._id));

      const { page, text } = await renderPage(order.orderNumber, { session_id: sessionId });

      expect(lookups.mock.calls.map(([id]) => id)).toEqual([sessionId]);
      const doc = await stored(String(order._id));
      expect(doc.status).toBe(OrderStatus.PAYMENT_PENDING);
      expect(doc.payment.paidAt ?? null).toBeNull();
      expect(doc.payment.capture?.status).toBe(capture);
      expect(text).toContain(
        `Card authorized Your card has been authorized ${RENTAL} has placed a hold on your card for $199.50. ` +
          "You have not been charged yet — the amount is collected only once your rental is confirmed, and you’ll get a receipt then.",
      );
      expect(text).toContain(
        `Amount on hold $199.50 Order ${order.orderNumber} ${formatDateTime(AUTHORIZED_AT)}`,
      );
      expect(text).toContain(
        "Charge breakdown Authorized online today $199.50 " +
          "Remaining balance due at rental counter $100.00 Total rental cost $299.50",
      );
      expect(text).toContain(`Authorization expires ${formatDateTime(EXPIRES_AT)}`);
      expect(text).toContain("Card authorized securely by Stripe — PCI-DSS Level 1 certified.");
      for (const phrase of [
        "Confirming with",
        "refreshes automatically",
        "We’re confirming",
        "Card hold today",
        "Payment received",
        "Payment confirmed",
        "Amount paid",
        "Paid online today",
        "Payment processed",
        "Hold released",
        // The refused capture's error is the operator's, not the customer's:
        // their hold still stands.
        "declined",
      ]) {
        expect(text, `a standing hold says "${phrase}"`).not.toContain(phrase);
      }
      expect(findAutoRefresh(page)).toBeNull();
      expect(await tabTitle(order.orderNumber, { session_id: sessionId })).toBe(
        `Card authorized • ${RENTAL}`,
      );
      // The title, read in a request of its own, asked Stripe too. The hold
      // is on record already, so neither request recorded anything: no claim
      // of `authorize:<session>`, no duplicate-event audit row.
      expect(lookups).toHaveBeenCalledTimes(2);
      const trailAfter = await trailOf(String(order._id));
      expect(trailAfter).toEqual(trailBefore);
      expect(trailAfter.claims).not.toContain(`authorize:${sessionId}`);
      expect(trailAfter.audits).not.toContain(AuditAction.WEBHOOK_DUPLICATE);
    },
  );
});

/* ------------------------------------------------------------------ *
 * Confirming a hold — back from Stripe before the authorization landed
 * ------------------------------------------------------------------ */

describe("confirming a hold: the customer is back from Stripe before the authorization has landed", () => {
  it("car — Rental Confirmation, the default organization, on MANUAL: 'We’re confirming your card' and the hold sentence while Stripe confirms — never 'finalise this charge' — and the give-up hint names the hold", async () => {
    const order = await linkedOrder(rental);
    expect(getCurrentTestStripe().sessionsCreated.at(-1)?.manualCapture).toBe(true);
    expect(order.payment.capture).toMatchObject({
      method: CaptureMode.MANUAL,
      status: PaymentCaptureStatus.PENDING_AUTHORIZATION,
    });

    // The checkout is still open at Stripe: nothing to record yet.
    const { page, text } = await renderPage(order.orderNumber, {
      session_id: order.payment.paymentSessionId!,
    });

    expect(text).toContain(
      `Confirming with Stripe We’re confirming your card ${RENTAL} is waiting for Stripe to confirm the hold on your card. ` +
        "You won’t be charged until your rental is confirmed. This page refreshes automatically. Confirming with Stripe…",
    );
    for (const phrase of [
      "finalise this charge",
      "We’re confirming your payment",
      "Payment confirmed",
      "Payment received",
      "Card authorized",
      "Hold released",
    ]) {
      expect(text, `a hold being confirmed says "${phrase}"`).not.toContain(phrase);
    }
    expect(hintAfterTheCap(page)).toBe(
      "Still confirming with Stripe. Try refreshing this page in a minute, or contact support if the hold appears on your card.",
    );

    const doc = await stored(order.id);
    expect(doc.status).toBe(OrderStatus.LINK_GENERATED);
    expect(doc.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);
  });

  it("itinerary flight — FlightBizz on MANUAL: the hold sentence names the Service Charge and the flight, never 'finalise your Service Charge payment'", async () => {
    const order = await linkedOrder(flightBizz, oneWayConnectingFlightInput());
    expect(getCurrentTestStripe().sessionsCreated.at(-1)?.manualCapture).toBe(true);
    expect(order.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);

    const { page, text } = await renderPage(order.orderNumber, {
      session_id: order.payment.paymentSessionId!,
    });

    expect(text).toContain(
      `Confirming with Stripe We’re confirming your card ${FLIGHTBIZZ} is waiting for Stripe to confirm the hold on your card for the ${DEFAULT_FLIGHT_CHARGE_NAME}. ` +
        "You won’t be charged until your flight is confirmed. This page refreshes automatically. Confirming with Stripe…",
    );
    expect(text).not.toContain(`finalise your ${DEFAULT_FLIGHT_CHARGE_NAME} payment`);
    expect(text).not.toContain("We’re confirming your payment");
    expect(hintAfterTheCap(page)).toBe(
      "Still confirming with Stripe. Try refreshing this page in a minute, or contact support if the hold appears on your card.",
    );
  });

  it("hotel — FlightBizz on MANUAL: the hold sentence waits on the hotel ('until your hotel is confirmed'), never the rental", async () => {
    const order = await linkedOrder(flightBizz, validHotelOrderInput());
    expect(getCurrentTestStripe().sessionsCreated.at(-1)?.manualCapture).toBe(true);
    expect(order.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);

    const { page, text } = await renderPage(order.orderNumber, {
      session_id: order.payment.paymentSessionId!,
    });

    expect(text).toContain(
      `Confirming with Stripe We’re confirming your card ${FLIGHTBIZZ} is waiting for Stripe to confirm the hold on your card. ` +
        "You won’t be charged until your hotel is confirmed. This page refreshes automatically. Confirming with Stripe…",
    );
    expect(text).not.toContain("until your rental is confirmed");
    expect(text).not.toContain("finalise this charge");
    expect(hintAfterTheCap(page)).toBe(
      "Still confirming with Stripe. Try refreshing this page in a minute, or contact support if the hold appears on your card.",
    );
  });
});

describe("confirming a hold: its amount is a hold placed on the card today — never paid, never payable", () => {
  it("a car with a counter balance: 'Card hold today' on the amount AND on the breakdown's online row, with the balance and total, and the card-details trust line — never 'Amount paid', 'Paid online today' or 'Payment processed'", async () => {
    const order = await linkedOrder(rental, counterBalanceInput());
    expect(order.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);

    const text = await receiptText(order.orderNumber, { session_id: order.payment.paymentSessionId! });

    expect(text).toContain(
      `Card hold today $249.99 Order ${order.orderNumber} ` +
        "Charge breakdown Card hold today $249.99 " +
        "Remaining balance due at rental counter $100.00 Total rental cost $349.99",
    );
    expect(text).toContain("Card details handled securely by Stripe — PCI-DSS Level 1 certified.");
    for (const phrase of [
      "Amount paid",
      "Paid online today",
      "Payment processed",
      "Payment received",
      "Amount on hold",
      "Authorized online today",
      "Card authorized",
    ]) {
      expect(text, `a hold being confirmed says "${phrase}"`).not.toContain(phrase);
    }
  });

  it.each([DEFAULT_FLIGHT_CHARGE_NAME, "Agency Fee"])(
    "an itinerary flight charging the '%s': the hero label and the breakdown's last row read '<charge> On Hold', with the card-details trust line — never 'Amount Payable Now', '<charge> Paid' or 'Amount paid'",
    async (chargeName) => {
      const order = await linkedOrder(
        flightBizz,
        oneWayConnectingFlightInput({ charges: flightServiceCharge(100, chargeName) }),
      );
      expect(order.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);

      const text = await receiptText(order.orderNumber, { session_id: order.payment.paymentSessionId! });

      expect(text).toContain(`${chargeName} On Hold $100.00 Order ${order.orderNumber}`);
      const box = text.slice(text.indexOf(FLIGHT_AMOUNT_LABELS.breakdownTitle));
      expect(box).toContain(
        [
          FLIGHT_AMOUNT_LABELS.airlineFare,
          FLIGHT_AMOUNT_LABELS.airlineFareNote,
          "$400.00",
          chargeName,
          "$100.00",
          FLIGHT_AMOUNT_LABELS.bookingTotal,
          "$500.00",
          `${chargeName} On Hold`,
          "$100.00",
          FLIGHT_AMOUNT_LABELS.airlineFareExplainer,
        ].join(" "),
      );
      expect(text).toContain("Card details handled securely by Stripe — PCI-DSS Level 1 certified.");
      for (const phrase of [
        FLIGHT_AMOUNT_LABELS.payableNow,
        `${chargeName} Paid`,
        "Amount paid",
        "Paid online today",
        "Payment processed",
        "Payment received",
      ]) {
        expect(text, `a flight hold being confirmed says "${phrase}"`).not.toContain(phrase);
      }
    },
  );
});

/* ------------------------------------------------------------------ *
 * What the hold waits for follows the booking type
 * ------------------------------------------------------------------ */

describe("what a hold waits for follows the booking type — a new booking, a change, a cancellation charge", () => {
  const CONDITIONS = [
    { bookingType: BookingType.NEW_BOOKING, condition: "your rental is confirmed" },
    { bookingType: BookingType.MODIFICATION, condition: "the change to your rental is confirmed" },
    { bookingType: BookingType.CANCELLATION_CHARGE, condition: "your cancellation is processed" },
  ];
  const othersThan = (bookingType: BookingType) =>
    CONDITIONS.filter((c) => c.bookingType !== bookingType).map((c) => c.condition);

  it.each(CONDITIONS)(
    "$bookingType car, hold standing: the amount is collected only once $condition — and no other booking type's condition",
    async ({ bookingType, condition }) => {
      const order = await seeded({ bookingType, payment: withHold(PaymentCaptureStatus.AUTHORIZED) });
      const text = await receiptText(order.orderNumber);

      expect(text).toContain(
        `Card authorized Your card has been authorized ${RENTAL} has placed a hold on your card for $199.50. ` +
          `You have not been charged yet — the amount is collected only once ${condition}, and you’ll get a receipt then.`,
      );
      for (const other of othersThan(bookingType)) {
        expect(text).not.toContain(`once ${other}`);
      }
    },
  );

  it.each(CONDITIONS)(
    "$bookingType car, hold still landing: not charged until $condition — and no other booking type's condition",
    async ({ bookingType, condition }) => {
      const order = await linkedOrder(rental, validCreateOrderInput({ bookingType }));
      expect(order.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);

      const text = await receiptText(order.orderNumber, { session_id: order.payment.paymentSessionId! });

      expect(text).toContain(
        `Confirming with Stripe We’re confirming your card ${RENTAL} is waiting for Stripe to confirm the hold on your card. ` +
          `You won’t be charged until ${condition}. This page refreshes automatically.`,
      );
      for (const other of othersThan(bookingType)) {
        expect(text).not.toContain(`until ${other}`);
      }
    },
  );

  // A new itinerary flight has its own hero sentence, which names the charge
  // it holds. A change to one, and a hotel, use the shared sentence with
  // their own noun.
  it.each([
    {
      booking: "a new itinerary flight",
      seed: (): OrderSeed => ({
        ...itineraryFlightSeed(),
        payment: withHold(PaymentCaptureStatus.AUTHORIZED, { amountAuthorized: 100 }),
      }),
      hold: `for the ${DEFAULT_FLIGHT_CHARGE_NAME} of $100.00`,
      condition: "your flight is confirmed",
    },
    {
      booking: "a change to an itinerary flight",
      seed: (): OrderSeed => ({
        ...itineraryFlightSeed(),
        bookingType: BookingType.MODIFICATION,
        payment: withHold(PaymentCaptureStatus.AUTHORIZED, { amountAuthorized: 100 }),
      }),
      hold: "for $100.00",
      condition: "the change to your flight is confirmed",
    },
    {
      booking: "a new hotel stay",
      seed: (): OrderSeed => ({
        organizationId: flightBizz,
        serviceType: ServiceType.HOTEL,
        pricing: { amount: 300, currency: Currency.USD },
        charges: [{ name: "Room charge", amount: 300, timing: PaymentTiming.PREPAID }],
        payment: withHold(PaymentCaptureStatus.AUTHORIZED, { amountAuthorized: 300 }),
      }),
      hold: "for $300.00",
      condition: "your hotel is confirmed",
    },
  ])(
    "$booking, hold standing: the amount is collected only once $condition, the booking named as it is, never the rental, and the tab title says 'Card authorized'",
    async ({ seed, hold, condition }) => {
      const order = await seeded(seed());
      const text = await receiptText(order.orderNumber);

      expect(text).toContain(
        `Card authorized Your card has been authorized ${FLIGHTBIZZ} has placed a hold on your card ${hold}. ` +
          `You have not been charged yet — the amount is collected only once ${condition}, and you’ll get a receipt then.`,
      );
      expect(text).not.toContain("your rental");
      expect(await tabTitle(order.orderNumber)).toBe(`Card authorized • ${FLIGHTBIZZ}`);
    },
  );
});

/* ------------------------------------------------------------------ *
 * When the page asks Stripe
 * ------------------------------------------------------------------ */

describe("the first-render reconcile asks Stripe only while there is something left to record", () => {
  it("a manual order still PENDING_AUTHORIZATION whose checkout completed: asks Stripe once and records the HOLD — 'Card authorized', never PAID", async () => {
    const order = await linkedOrder(rental);
    // An authorized, uncaptured Checkout: complete, nothing paid.
    Object.assign(checkoutOf(order), { status: "complete", payment_status: "unpaid" });
    const lookups = stripeSessionLookups();

    const text = await receiptText(order.orderNumber, { session_id: order.payment.paymentSessionId! });

    // Asked once, about this order's own session.
    expect(lookups.mock.calls.map(([id]) => id)).toEqual([order.payment.paymentSessionId]);
    const doc = await stored(order.id);
    expect(doc.status).toBe(OrderStatus.LINK_GENERATED);
    expect(doc.payment.paidAt ?? null).toBeNull();
    expect(doc.payment.capture).toMatchObject({
      status: PaymentCaptureStatus.AUTHORIZED,
      amountAuthorized: 249.99,
    });
    expect(text).toContain("Card authorized Your card has been authorized");
    expect(text).toContain("Amount on hold $249.99");
    expect(text).not.toContain("Payment received");
    expect(await tabTitle(order.orderNumber, { session_id: order.payment.paymentSessionId! })).toBe(
      `Card authorized • ${RENTAL}`,
    );
  });

  it("an automatic order (capture null) whose checkout completed: asks Stripe once and records the payment — 'Payment received'", async () => {
    await setRentalCaptureMode(CaptureMode.AUTOMATIC);
    const order = await linkedOrder(rental);
    expect(order.payment.capture).toBeNull();
    Object.assign(checkoutOf(order), { status: "complete", payment_status: "paid" });
    const lookups = stripeSessionLookups();

    const text = await receiptText(order.orderNumber, { session_id: order.payment.paymentSessionId! });

    expect(lookups.mock.calls.map(([id]) => id)).toEqual([order.payment.paymentSessionId]);
    expect((await stored(order.id)).status).toBe(OrderStatus.PAID);
    expect(text).toContain("Payment confirmed Payment received");
  });

  it.each([PaymentCaptureStatus.CAPTURE_PENDING, PaymentCaptureStatus.CAPTURE_FAILED])(
    "asks once the capture is %s — it may have gone through at Stripe — and a session Stripe reports paid moves the order to PAID with the paid receipt, the capture record CAPTURED and the booking CONFIRMED",
    async (capture) => {
      const order = await linkedOrder(rental);
      const sessionId = order.payment.paymentSessionId!;
      await Order.updateOne(
        { _id: order.id },
        { $set: { "payment.capture": heldCapture(capture, { amountAuthorized: 249.99 }) } },
      );
      // Stripe took the money, whatever the app recorded about the capture.
      Object.assign(checkoutOf(order), { status: "complete", payment_status: "paid" });
      const lookups = stripeSessionLookups();
      const since = Date.now();

      const { page, text } = await renderPage(order.orderNumber, { session_id: sessionId });

      expect(lookups.mock.calls.map(([id]) => id)).toEqual([sessionId]);
      const doc = await stored(order.id);
      expect(doc.status).toBe(OrderStatus.PAID);
      expect(doc.payment.status).toBe(OrderStatus.PAID);
      expect(doc.payment.paidAt).toBeInstanceOf(Date);
      expect(doc.payment.amountReceived).toBe(249.99);
      // The visit settles the capture record and the booking as Stripe's
      // capture webhook would, so no operator surface offers Capture (or a
      // refused capture's error) on a paid order.
      expect(doc.payment.capture).toMatchObject({
        method: CaptureMode.MANUAL,
        status: PaymentCaptureStatus.CAPTURED,
        amountCaptured: 249.99,
        lastError: null,
      });
      expect(doc.payment.capture?.capturedAt).toBeInstanceOf(Date);
      expect(doc.payment.capture!.capturedAt!.getTime()).toBeGreaterThanOrEqual(since);
      expect(doc.bookingStatus).toBe(BookingStatus.CONFIRMED);
      // The receipt the page promises is on its way.
      expect(
        await PendingEmail.countDocuments({ orderId: order.id, kind: EmailKind.PAYMENT_CONFIRMATION }),
      ).toBe(1);
      expect(text).toContain(
        `Payment confirmed Payment received Thank you. ${RENTAL} has confirmed your payment and a receipt is on its way to your inbox.`,
      );
      expect(text).toContain(
        `Amount paid $249.99 Order ${order.orderNumber} ${formatDateTime(doc.payment.paidAt!)}`,
      );
      expect(text).toContain("Payment processed securely by Stripe — PCI-DSS Level 1 certified.");
      expect(text.toLowerCase()).not.toContain("hold");
      expect(text).not.toContain("Card authorized");
      expect(text).not.toContain("not been charged");
      expect(findAutoRefresh(page)).toBeNull();
      expect(await tabTitle(order.orderNumber, { session_id: sessionId })).toBe(
        `Payment received • ${RENTAL}`,
      );
    },
  );

  it.each([
    { capture: PaymentCaptureStatus.AUTHORIZED, shows: "Card authorized" },
    { capture: PaymentCaptureStatus.CANCELLED, shows: "Hold released" },
    { capture: PaymentCaptureStatus.AUTHORIZATION_EXPIRED, shows: "Hold released" },
  ])(
    "never asks once the hold is $capture — not for the page nor its title, not even when Stripe would now report the session paid — so the order is left exactly as recorded",
    async ({ capture, shows }) => {
      const order = await linkedOrder(rental);
      const sessionId = order.payment.paymentSessionId!;
      await Order.updateOne(
        { _id: order.id },
        { $set: { "payment.capture": heldCapture(capture, { amountAuthorized: 249.99 }) } },
      );
      // What Stripe reports once a hold is captured: had the page asked,
      // this answer would have recorded a payment.
      Object.assign(checkoutOf(order), { status: "complete", payment_status: "paid" });
      const lookups = stripeSessionLookups();

      const text = await receiptText(order.orderNumber, { session_id: sessionId });
      const title = await tabTitle(order.orderNumber, { session_id: sessionId });

      expect(lookups).not.toHaveBeenCalled();
      const doc = await stored(order.id);
      expect(doc.status).toBe(OrderStatus.LINK_GENERATED);
      expect(doc.payment.status).toBe(OrderStatus.LINK_GENERATED);
      expect(doc.payment.paidAt ?? null).toBeNull();
      expect(doc.payment.capture?.status).toBe(capture);
      expect(text).toContain(shows);
      expect(text).not.toContain("Payment received");
      expect(title).toBe(`${shows} • ${RENTAL}`);
    },
  );
});

/* ------------------------------------------------------------------ *
 * The tab title and the page read the same reconciled order
 * ------------------------------------------------------------------ */

describe("the tab title reads the same reconciled order as the page, so the two agree whichever is read first", () => {
  it("a manual order still PENDING_AUTHORIZATION whose checkout completed (authorized, unpaid): the title, read FIRST, already says 'Card authorized' — its read recorded the hold, with the intent Stripe reported — and the body says so too; Stripe is asked once for both", async () => {
    const order = await linkedOrder(rental);
    const sessionId = order.payment.paymentSessionId!;
    // Production: a Checkout session has no PaymentIntent until the customer
    // pays, so the order carries none until the authorization is recorded.
    await Order.updateOne({ _id: order.id }, { $set: { "payment.paymentIntentId": null } });
    const checkout = checkoutOf(order);
    Object.assign(checkout, { status: "complete", payment_status: "unpaid" });
    expect(checkout.payment_intent, "the completed checkout names no intent").toMatch(/^pi_/);
    const lookups = stripeSessionLookups();

    expect(await tabTitle(order.orderNumber, { session_id: sessionId })).toBe(
      `Card authorized • ${RENTAL}`,
    );
    const afterTitle = await stored(order.id);
    expect(afterTitle.payment.capture?.status).toBe(PaymentCaptureStatus.AUTHORIZED);
    expect(afterTitle.payment.paymentIntentId).toBe(checkout.payment_intent);

    const { page, text } = await renderPage(order.orderNumber, { session_id: sessionId });

    expect(text).toContain(
      `Card authorized Your card has been authorized ${RENTAL} has placed a hold on your card for $249.99. ` +
        "You have not been charged yet — the amount is collected only once your rental is confirmed, and you’ll get a receipt then.",
    );
    expect(text).not.toContain("Payment received");
    expect(text).not.toContain("We’re confirming");
    expect(findAutoRefresh(page)).toBeNull();
    expect(lookups.mock.calls.map(([id]) => id)).toEqual([sessionId]);
    const doc = await stored(order.id);
    expect(doc.status).toBe(OrderStatus.LINK_GENERATED);
    expect(doc.payment.paidAt ?? null).toBeNull();
  });

  it("the same order with its checkout still open: the title says 'Confirming your card' and the body that the hold is being confirmed — neither a payment nor a standing hold — and nothing is recorded", async () => {
    const order = await linkedOrder(rental);
    const sessionId = order.payment.paymentSessionId!;
    await Order.updateOne({ _id: order.id }, { $set: { "payment.paymentIntentId": null } });

    expect(await tabTitle(order.orderNumber, { session_id: sessionId })).toBe(
      `Confirming your card • ${RENTAL}`,
    );
    const { page, text } = await renderPage(order.orderNumber, { session_id: sessionId });

    expect(text).toContain(
      `Confirming with Stripe We’re confirming your card ${RENTAL} is waiting for Stripe to confirm the hold on your card.`,
    );
    for (const phrase of ["Payment received", "Payment confirmed", "Card authorized", "Hold released"]) {
      expect(text, `a hold being confirmed says "${phrase}"`).not.toContain(phrase);
    }
    expect(findAutoRefresh(page)).not.toBeNull();
    const doc = await stored(order.id);
    expect(doc.status).toBe(OrderStatus.LINK_GENERATED);
    expect(doc.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);
    expect(doc.payment.paymentIntentId ?? null).toBeNull();
  });

  it("in one request the title and the page share ONE read of the order (Stripe asked once, both say the hold is being confirmed), and the auto-refresh's next request reads it afresh and shows the hold that landed meanwhile", async () => {
    const order = await linkedOrder(rental);
    const query = { session_id: order.payment.paymentSessionId! };
    const lookups = stripeSessionLookups();

    // The checkout is still open, so every read of the order asks Stripe.
    const first = await visit(order.orderNumber, query);

    expect(lookups.mock.calls.map(([id]) => id)).toEqual([query.session_id]);
    expect(first.title).toBe(`Confirming your card • ${RENTAL}`);
    expect(first.text).toContain(
      `We’re confirming your card ${RENTAL} is waiting for Stripe to confirm the hold on your card.`,
    );
    expect(findAutoRefresh(first.page)).not.toBeNull();

    // The customer's card is authorized; the page reloads itself.
    Object.assign(checkoutOf(order), { status: "complete", payment_status: "unpaid" });
    const next = await visit(order.orderNumber, query);

    expect(lookups.mock.calls.map(([id]) => id)).toEqual([query.session_id, query.session_id]);
    expect(next.title).toBe(`Card authorized • ${RENTAL}`);
    expect(next.text).toContain(
      `Card authorized Your card has been authorized ${RENTAL} has placed a hold on your card for $249.99.`,
    );
    expect(findAutoRefresh(next.page)).toBeNull();
    expect((await stored(order.id)).payment.capture?.status).toBe(PaymentCaptureStatus.AUTHORIZED);
  });

  it("a PayPal return carries `token`, not `session_id`: the title pairs it exactly as the page does, 'Payment received' over the paid receipt, never 'Payment status'", async () => {
    // Nothing in this test may reach PayPal.
    _setPayPalFetchForTesting((async () => {
      throw new Error("network disabled in this test");
    }) as unknown as typeof fetch);
    try {
      const tripStays = await Organization.create({
        slug: "tripstays",
        name: "TripStays",
        brandName: "Trip Stays",
        isDefault: false,
        payments: { provider: PaymentGatewayKey.PAYPAL },
        serviceTypes: [ServiceType.CAR_RENTAL],
      });
      const order = await seeded({
        organizationId: tripStays._id as Types.ObjectId,
        status: OrderStatus.PAID,
      });
      await Order.updateOne(
        { _id: order._id },
        { $set: { "payment.gateway": PaymentGatewayKey.PAYPAL } },
      );
      // PayPal sends the customer back with its order id and the payer.
      const query = { token: SESSION, PayerID: "PAYERQ7Z2" };

      const text = await receiptText(order.orderNumber, query);

      expect(text).toContain(
        "Payment confirmed Payment received Thank you. Trip Stays has confirmed your payment and a receipt is on its way to your inbox.",
      );
      expect(text).toContain("Payment processed securely by PayPal — PCI-DSS Level 1 certified.");
      expect(await tabTitle(order.orderNumber, query)).toBe("Payment received • Trip Stays");
    } finally {
      _setPayPalFetchForTesting(null);
    }
  });
});

/* ------------------------------------------------------------------ *
 * A declined card, then another card on the same Checkout
 * ------------------------------------------------------------------ */

describe("a card declined at checkout, then another card on the same Checkout: the customer is back for a hold, not a failed payment", () => {
  // Stripe's decline lands while the hold is still PENDING_AUTHORIZATION,
  // so the webhook fails the order. Checkout keeps the session open; the
  // customer authorizes another card on it and Stripe sends them here,
  // usually before any webhook has recorded that authorization.

  /** Neither a payment nor the decline that came before the hold. */
  const NEVER_ON_A_RETRIED_HOLD = [
    "Payment received",
    "Payment confirmed",
    "Amount paid",
    "Paid online today",
    "Payment processed",
    "Hold released",
    "Payment failed",
    "declined",
  ];

  it("its retry authorized (Stripe: complete, unpaid): one request asks Stripe once and records the hold — the order back in progress (PAYMENT_PENDING, no failure reason), the authorization email queued once — and the page AND its title say 'Card authorized … You have not been charged yet'", async () => {
    const order = await linkedOrder(rental);
    const sessionId = order.payment.paymentSessionId!;
    expect(order.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);
    const { checkout, intentId } = await declinedAtCheckout(order);
    // The other card is authorized on the same session: complete, nothing
    // captured.
    Object.assign(checkout, { status: "complete", payment_status: "unpaid" });
    const lookups = stripeSessionLookups();

    const { title, page, text } = await visit(order.orderNumber, { session_id: sessionId });

    // Asked once, about this order's own session, for the page and its title.
    expect(lookups.mock.calls.map(([id]) => id)).toEqual([sessionId]);
    const doc = await stored(order.id);
    expect(doc.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(doc.payment.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(doc.payment.failureReason ?? null).toBeNull();
    expect(doc.payment.capture).toMatchObject({
      status: PaymentCaptureStatus.AUTHORIZED,
      amountAuthorized: 249.99,
    });
    expect(doc.payment.paymentIntentId).toBe(intentId);
    expect(doc.payment.paidAt ?? null).toBeNull();
    expect(
      await PendingEmail.countDocuments({ orderId: order.id, kind: EmailKind.PAYMENT_AUTHORIZED }),
    ).toBe(1);
    expect(
      await PendingEmail.countDocuments({ orderId: order.id, kind: EmailKind.PAYMENT_CONFIRMATION }),
    ).toBe(0);

    expect(title).toBe(`Card authorized • ${RENTAL}`);
    expect(text).toContain(
      `Card authorized Your card has been authorized ${RENTAL} has placed a hold on your card for $249.99. ` +
        "You have not been charged yet — the amount is collected only once your rental is confirmed, and you’ll get a receipt then.",
    );
    expect(text).toContain(
      `Amount on hold $249.99 Order ${order.orderNumber} ${formatDateTime(doc.payment.capture!.authorizedAt!)}`,
    );
    expect(text).toContain(
      `Authorization expires ${formatDateTime(doc.payment.capture!.captureExpiresAt!)}`,
    );
    expect(text).toContain("Card authorized securely by Stripe — PCI-DSS Level 1 certified.");
    for (const phrase of [
      ...NEVER_ON_A_RETRIED_HOLD,
      "We’re confirming",
      "Confirming with",
      "refreshes automatically",
    ]) {
      expect(text, `a retried hold, authorized, says "${phrase}"`).not.toContain(phrase);
    }
    // The hold stands: nothing left to wait for.
    expect(findAutoRefresh(page)).toBeNull();
    expect(heroSpins(page)).toBe(false);
  });

  it("its checkout still open at Stripe: 'We’re confirming your card' and the hold sentence, the spinner, title 'Confirming your card' — nothing recorded yet — and once Stripe reports the authorization, the auto-refresh's next request records it: 'Card authorized', the order back in progress", async () => {
    const order = await linkedOrder(rental);
    const query = { session_id: order.payment.paymentSessionId! };
    const { checkout, intentId } = await declinedAtCheckout(order);
    const lookups = stripeSessionLookups();

    const first = await visit(order.orderNumber, query);

    expect(lookups.mock.calls.map(([id]) => id)).toEqual([query.session_id]);
    expect(first.title).toBe(`Confirming your card • ${RENTAL}`);
    expect(first.text).toContain(
      `Confirming with Stripe We’re confirming your card ${RENTAL} is waiting for Stripe to confirm the hold on your card. ` +
        "You won’t be charged until your rental is confirmed. This page refreshes automatically. Confirming with Stripe…",
    );
    expect(first.text).toContain(`Card hold today $249.99 Order ${order.orderNumber}`);
    expect(first.text).toContain("Card details handled securely by Stripe — PCI-DSS Level 1 certified.");
    for (const phrase of [...NEVER_ON_A_RETRIED_HOLD, "Card authorized", "Amount on hold"]) {
      expect(first.text, `a retried hold, being confirmed, says "${phrase}"`).not.toContain(phrase);
    }
    expect(heroSpins(first.page)).toBe(true);
    expect(hintAfterTheCap(first.page)).toBe(
      "Still confirming with Stripe. Try refreshing this page in a minute, or contact support if the hold appears on your card.",
    );
    const waiting = await stored(order.id);
    expect(waiting.status).toBe(OrderStatus.FAILED);
    expect(waiting.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);

    // Stripe reports the other card's authorization; the page reloads itself.
    Object.assign(checkout, { status: "complete", payment_status: "unpaid" });
    const next = await visit(order.orderNumber, query);

    expect(lookups.mock.calls.map(([id]) => id)).toEqual([query.session_id, query.session_id]);
    expect(next.title).toBe(`Card authorized • ${RENTAL}`);
    expect(next.text).toContain(
      `Card authorized Your card has been authorized ${RENTAL} has placed a hold on your card for $249.99. ` +
        "You have not been charged yet",
    );
    for (const phrase of NEVER_ON_A_RETRIED_HOLD) {
      expect(next.text, `a retried hold, authorized, says "${phrase}"`).not.toContain(phrase);
    }
    expect(findAutoRefresh(next.page)).toBeNull();
    const held = await stored(order.id);
    expect(held.status).toBe(OrderStatus.PAYMENT_PENDING);
    expect(held.payment.capture?.status).toBe(PaymentCaptureStatus.AUTHORIZED);
    expect(held.payment.paymentIntentId).toBe(intentId);
  });

  it.each([
    { checkout: "still open", state: {} },
    {
      checkout: "completed and paid (the retry went through)",
      state: { status: "complete", payment_status: "paid" },
    },
  ])(
    "an AUTOMATIC order (capture null, its link made before Rental Confirmation switched to MANUAL) a declined card drove to FAILED, its checkout $checkout: reads exactly as before — 'Payment confirmed' / 'Payment received', 'Amount paid', the payment trust line, title 'Payment received' — no hold, no spinner, and Stripe is never asked, neither by the decline nor by the page, so the order stays FAILED",
    async ({ state }) => {
      await setRentalCaptureMode(CaptureMode.AUTOMATIC);
      const order = await linkedOrder(rental);
      expect(order.payment.capture).toBeNull();
      await setRentalCaptureMode(CaptureMode.MANUAL);
      const sessionId = order.payment.paymentSessionId!;
      const lookups = stripeSessionLookups();
      const { checkout } = await declinedAtCheckout(order);
      Object.assign(checkout, state);

      const { title, page, text } = await visit(order.orderNumber, { session_id: sessionId });

      expect(text).toContain(
        `Payment confirmed Payment received Thank you. ${RENTAL} has confirmed your payment and a receipt is on its way to your inbox.`,
      );
      expect(text).toContain(`Amount paid $249.99 Order ${order.orderNumber}`);
      expect(text).toContain("Payment processed securely by Stripe — PCI-DSS Level 1 certified.");
      expect(text.toLowerCase()).not.toContain("hold");
      for (const phrase of [
        "Confirming with",
        "We’re confirming",
        "refreshes automatically",
        "Card authorized",
        "not been charged",
      ]) {
        expect(text, `an automatic FAILED order says "${phrase}"`).not.toContain(phrase);
      }
      expect(findAutoRefresh(page)).toBeNull();
      expect(heroSpins(page)).toBe(false);
      expect(title).toBe(`Payment received • ${RENTAL}`);
      // Stripe is never asked. The decline was not checked against the
      // intent the session holds now: that check is for manual-capture
      // orders only (handlePaymentFailed), and the order's own capture
      // record decides, not its organization's mode. And a FAILED automatic
      // order is not awaiting the gateway, as before: the page records
      // nothing, and a completed checkout is left to Stripe's
      // checkout.session.completed webhook.
      expect(lookups).not.toHaveBeenCalled();
      const doc = await stored(order.id);
      expect(doc.status).toBe(OrderStatus.FAILED);
      expect(doc.payment.failureReason).toBe(CARD_DECLINED);
      expect(doc.payment.capture ?? null).toBeNull();
    },
  );
});

/* ------------------------------------------------------------------ *
 * A return link that matches no current payment
 * ------------------------------------------------------------------ */

describe("a return link that matches no current payment: a neutral page and title — no state, no order details", () => {
  // A stale link (e.g. one whose hold was released and replaced by a new
  // link) or a hand-edited one. With no order matched there is no payment
  // status to state, least of all "Payment received", and nothing about the
  // order may show: the order number alone must buy a stranger nothing.
  const LINKS = [
    { link: "a session_id from another checkout", query: { session_id: "cs_test_someone_else" } },
    { link: "no session_id at all", query: {} as Record<string, string> },
  ];
  const ORDERS = [
    {
      order: "a paid Rental Confirmation car order",
      brand: RENTAL,
      seed: (): OrderSeed => ({ status: OrderStatus.PAID }),
      details: ["Toyota", "Corolla", "LAX Airport"],
    },
    {
      order: "a released FlightBizz flight hold",
      brand: FLIGHTBIZZ,
      seed: (): OrderSeed => ({
        ...itineraryFlightSeed(),
        payment: withHold(PaymentCaptureStatus.CANCELLED, { amountAuthorized: 100 }),
      }),
      details: ["Delhi", "Air India", DEFAULT_FLIGHT_CHARGE_NAME],
    },
  ];

  /** The neutral page: the order's brand, and nothing else about it — no
   *  payment state, no order number, customer or booking, nothing to wait
   *  for. */
  function expectNeutralUnmatched(
    { page, text }: Awaited<ReturnType<typeof renderPage>>,
    order: { brand: string; orderNumber: string; customer: OrderDTO["customer"]; details: string[] },
  ) {
    expect(text).toContain(
      `Payment status We couldn’t match this payment This link doesn’t match a current ${order.brand} payment, ` +
        `so there is no payment status to show here. Your latest email from ${order.brand} has the up-to-date details of your booking.`,
    );
    for (const phrase of [
      "Payment received",
      "Payment confirmed",
      "Card authorized",
      "Hold released",
      "not been charged",
      "Confirming with",
      "Booking details",
      order.orderNumber,
      order.customer.name,
      order.customer.email,
      order.customer.phone,
      "Budget",
      "$",
      ...order.details,
    ]) {
      expect(text, `an unmatched link shows "${phrase}"`).not.toContain(phrase);
    }
    expect(text.toLowerCase()).not.toContain("receipt");
    expect(text.toLowerCase()).not.toContain("hold");
    expect(findAutoRefresh(page)).toBeNull();
  }

  it.each(LINKS.flatMap((l) => ORDERS.map((o) => ({ ...l, ...o }))))(
    "$link, on $order: 'Payment status' / 'We couldn’t match this payment' in the order's brand, title 'Payment status • <brand>' — never 'Payment received', 'Payment confirmed' or a receipt, no order number or customer details, no spinner, and Stripe is never asked",
    async ({ query, brand, seed, details }) => {
      const order = await seeded(seed());
      const before = await stored(String(order._id));
      const lookups = stripeSessionLookups();

      const rendered = await renderPage(order.orderNumber, query);

      expectNeutralUnmatched(rendered, {
        brand,
        orderNumber: order.orderNumber,
        customer: order.customer,
        details,
      });
      expect(await tabTitle(order.orderNumber, query)).toBe(`Payment status • ${brand}`);
      expect(lookups).not.toHaveBeenCalled();
      const after = await stored(String(order._id));
      expect(after.status).toBe(before.status);
      expect(after.payment.capture?.status ?? null).toBe(before.payment.capture?.status ?? null);
    },
  );

  // Pairing needs the session the gateway returned. A link that names none
  // (no session_id, no token) used to pair with an order that has none
  // either: a draft, whose payment link was never generated. Its order
  // number alone then showed the customer, the booking and the amount under
  // "Payment received".
  const NO_SESSION_LINKS = [
    { link: "the order number alone", query: {} as Record<string, string> },
    { link: "a PayPal-style return without its token", query: { PayerID: "PAYERQ7Z2" } },
  ];
  const DRAFTS = [
    {
      draft: "a Rental Confirmation car draft",
      brand: RENTAL,
      make: () => draftOrder(rental),
      details: ["Toyota", "Camry", "LAX Airport", "San Diego"],
    },
    {
      draft: "a FlightBizz hotel draft",
      brand: FLIGHTBIZZ,
      make: () => draftOrder(flightBizz, validHotelOrderInput()),
      details: ["Paris", "Hilton"],
    },
  ];

  it.each(NO_SESSION_LINKS.flatMap((l) => DRAFTS.map((d) => ({ ...l, ...d }))))(
    "$link, on $draft (NOT_INITIATED, no payment session): the same neutral page in the order's brand and title 'Payment status • <brand>' — none of its details, no spinner — Stripe is never asked and the draft is left as it was",
    async ({ query, brand, make, details }) => {
      const order = await make();
      expect(order.status).toBe(OrderStatus.NOT_INITIATED);
      expect(order.payment.paymentSessionId).toBeNull();
      const lookups = stripeSessionLookups();

      const rendered = await renderPage(order.orderNumber, query);

      expectNeutralUnmatched(rendered, {
        brand,
        orderNumber: order.orderNumber,
        customer: order.customer,
        details,
      });
      expect(await tabTitle(order.orderNumber, query)).toBe(`Payment status • ${brand}`);
      expect(lookups).not.toHaveBeenCalled();
      const after = await stored(order.id);
      expect(after.status).toBe(OrderStatus.NOT_INITIATED);
      expect(after.payment.stripeSessionId ?? null).toBeNull();
    },
  );

  // An order WITH a session, whose reconcile would record a hold had the
  // link paired with it.
  it.each([
    {
      order: "a manual car order whose link is out, its hold authorized at Stripe but not yet recorded",
      status: OrderStatus.LINK_GENERATED,
      make: async () => {
        const order = await linkedOrder(rental);
        Object.assign(checkoutOf(order), { status: "complete", payment_status: "unpaid" });
        return order;
      },
    },
    {
      order: "an order a declined card drove to FAILED, its retry authorized at Stripe",
      status: OrderStatus.FAILED,
      make: async () => {
        const order = await linkedOrder(rental);
        const { checkout } = await declinedAtCheckout(order);
        Object.assign(checkout, { status: "complete", payment_status: "unpaid" });
        return order;
      },
    },
  ])(
    "the order number alone, on $order: the same neutral page and title — and Stripe is never asked, so nothing is recorded from a link that names no session",
    async ({ status, make }) => {
      const order = await make();
      const lookups = stripeSessionLookups();

      const rendered = await renderPage(order.orderNumber, {});

      expectNeutralUnmatched(rendered, {
        brand: RENTAL,
        orderNumber: order.orderNumber,
        customer: order.customer,
        details: ["Toyota", "Camry", "LAX Airport", "San Diego"],
      });
      expect(await tabTitle(order.orderNumber, {})).toBe(`Payment status • ${RENTAL}`);
      expect(lookups).not.toHaveBeenCalled();
      const after = await stored(order.id);
      expect(after.status).toBe(status);
      expect(after.payment.capture?.status).toBe(PaymentCaptureStatus.PENDING_AUTHORIZATION);
      expect(
        await PendingEmail.countDocuments({ orderId: order.id, kind: EmailKind.PAYMENT_AUTHORIZED }),
      ).toBe(0);
    },
  );
});

/* ------------------------------------------------------------------ *
 * Captured, and automatic: the receipts as they always were
 * ------------------------------------------------------------------ */

describe("a captured hold, and an automatic order, read as they always have", () => {
  // The operator's capture and Stripe's capture webhook both mark the order
  // PAID first (the shared applyCheckoutPaid). They mark the capture
  // CAPTURED in a separate write afterwards. A customer who reloads between
  // the two writes has already been charged, so they get the receipt.
  it.each([
    { order: "an automatic order (capture null)", capture: null },
    {
      order: "a captured hold (PAID, capture CAPTURED)",
      capture: heldCapture(PaymentCaptureStatus.CAPTURED, {
        capturedAt: PAID_AT,
        amountCaptured: 199.5,
      }),
    },
    // The operator's capture, before its CAPTURED write lands.
    {
      order: "PAID, capture still CAPTURE_PENDING",
      capture: heldCapture(PaymentCaptureStatus.CAPTURE_PENDING),
    },
    // Stripe's capture webhook, the same way round.
    {
      order: "PAID, capture still AUTHORIZED",
      capture: heldCapture(PaymentCaptureStatus.AUTHORIZED),
    },
    // A capture recorded as failed (timed out) that Stripe in fact made,
    // settled by that webhook.
    {
      order: "PAID, capture still CAPTURE_FAILED",
      capture: heldCapture(PaymentCaptureStatus.CAPTURE_FAILED),
    },
  ])(
    "$order: the ordinary paid receipt — 'Payment received', 'Amount paid', 'Paid online today' — and no word of a hold",
    async ({ capture }) => {
      const order = await seeded({
        status: OrderStatus.PAID,
        charges: COUNTER_BALANCE,
        payment: { capture } as unknown as OrderSeed["payment"],
      });
      const text = await receiptText(order.orderNumber);

      expect(text).toContain(
        `Payment confirmed Payment received Thank you. ${RENTAL} has confirmed your payment and a receipt is on its way to your inbox.`,
      );
      expect(text).toContain(`Amount paid $199.50 Order ${order.orderNumber} ${formatDateTime(PAID_AT)}`);
      expect(text).toContain(
        "Charge breakdown Paid online today $199.50 " +
          "Remaining balance due at rental counter $100.00 Total rental cost $299.50",
      );
      expect(text).toContain("Payment processed securely by Stripe — PCI-DSS Level 1 certified.");
      expect(text.toLowerCase()).not.toContain("hold");
      expect(text).not.toContain("Card authorized");
      expect(text).not.toContain("not been charged");
      expect(text).not.toContain("Authorization expires");
      expect(await tabTitle(order.orderNumber)).toBe(`Payment received • ${RENTAL}`);
    },
  );

  it("a captured itinerary flight: the Service Charge was paid — the hero, its label and the breakdown's last row say so, nothing is on hold", async () => {
    const order = await seeded({
      ...itineraryFlightSeed(),
      status: OrderStatus.PAID,
      payment: withHold(PaymentCaptureStatus.CAPTURED, {
        amountAuthorized: 100,
        capturedAt: PAID_AT,
        amountCaptured: 100,
      }),
    });
    const text = await receiptText(order.orderNumber);

    expect(text).toContain(
      `Thank you. ${FLIGHTBIZZ} has confirmed your ${DEFAULT_FLIGHT_CHARGE_NAME} payment and a receipt is on its way to your inbox.`,
    );
    expect(text).toContain(`${FLIGHT_AMOUNT_LABELS.paidNow} $100.00 Order ${order.orderNumber}`);
    expect(text).toContain(
      `${FLIGHT_AMOUNT_LABELS.bookingTotal} $500.00 ${FLIGHT_AMOUNT_LABELS.paidNow} $100.00`,
    );
    expect(text.toLowerCase()).not.toContain("hold");
  });

  it("an automatic link made BEFORE Rental Confirmation switched to MANUAL, still being confirmed: 'We’re confirming your payment' and 'finalise this charge' as before, and the give-up hint still says 'charge'", async () => {
    await setRentalCaptureMode(CaptureMode.AUTOMATIC);
    const order = await linkedOrder(rental);
    expect(order.payment.capture).toBeNull();
    await setRentalCaptureMode(CaptureMode.MANUAL);

    const { page, text } = await renderPage(order.orderNumber, {
      session_id: order.payment.paymentSessionId!,
    });

    expect(text).toContain(
      `Confirming with Stripe We’re confirming your payment ${RENTAL} is waiting for Stripe to finalise this charge. ` +
        "This page refreshes automatically. Confirming with Stripe…",
    );
    expect(text.toLowerCase()).not.toContain("hold");
    expect(text).not.toContain("won’t be charged");
    expect(hintAfterTheCap(page)).toBe(
      "Still confirming with Stripe. Try refreshing this page in a minute, or contact support if the charge appears on your card.",
    );
    expect((await stored(order.id)).payment.capture ?? null).toBeNull();
  });
});
