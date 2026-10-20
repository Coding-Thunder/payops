import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Types } from "mongoose";

import { POST as createOrderRoute } from "@/app/api/orders/route";
import { POST as generateLinkRoute } from "@/app/api/orders/[id]/generate-payment-link/route";
import { POST as previewRoute } from "@/app/api/orders/[id]/payment-request-preview/route";
import { POST as sendRequestRoute } from "@/app/api/orders/[id]/send-payment-request/route";
import { POST as stripeWebhookRoute } from "@/app/api/webhooks/stripe/[orgSlug]/route";
import ConsentPage from "@/app/consent/[token]/page";
import PaymentSuccessPage from "@/app/pay/success/page";
import {
  BOOKING_TYPES,
  BookingType,
  CaptureMode,
  EmailKind,
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
import { createProvider } from "@/server/services/provider.service";
import { createSettings } from "@/tests/factories/settings.factory";
import {
  buildCheckoutCompleted,
  signWebhook,
} from "@/tests/factories/stripe-event.factory";
import {
  oneWayConnectingFlightInput,
  validCreateOrderInput,
} from "@/tests/fixtures/order-input.fixture";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";
import type { OrderDTO } from "@/types";

/**
 * WHEN A CARD HOLD IS COLLECTED, BY BOOKING TYPE — every sentence that
 * promises when a manual-capture hold becomes a charge names the condition
 * the capture actually waits for:
 *
 *   NEW_BOOKING           "your <noun> is confirmed[ with <supplier>]"
 *   MODIFICATION          "the change to your <noun> is confirmed[ with <supplier>]"
 *   CANCELLATION_CHARGE   "your cancellation is processed"
 *
 * A change is collected once the CHANGE is confirmed, and a cancellation
 * charge has no booking left to confirm: "we charge it only once your rental
 * is confirmed" on either is a promise the operator's capture contradicts —
 * and a cancellation charge must not promise to release the hold "if it
 * can't be confirmed" either. Nor does its hold lapse "if we haven't
 * confirmed by" its deadline, as a new booking's and a change's do: it
 * lapses "if it hasn't been processed by" then.
 *
 * For a car and an itinerary flight, each booked as all three types, read as
 * the customer reads it:
 *
 *   1. request      the payment request on a MANUAL Stripe brand — the
 *                   composer preview, the email as it left (HTML and plain
 *                   text): its intro ("You won't be charged until …") and
 *                   the line under the held amount ("…only once …")
 *   2. consent      the hosted consent page's footnote ("…collected only
 *                   once …")
 *   3. authorized   the PAYMENT_AUTHORIZED email a real Stripe authorization
 *                   queues: its banner and "What happens next", every step
 *                   down to the hold's deadline, the last of them ("If we
 *                   haven't confirmed by <date>, the hold expires on its
 *                   own …"; on a cancellation charge, "If it hasn't been
 *                   processed by <date>, …")
 *   4. previews     the template editor's samples (renderEmailPreview): a
 *                   change's and a cancellation charge's request, and the
 *                   car's and the flight's authorization for every booking
 *                   type, read as in 3
 *   5. automatic    an AUTOMATIC brand's request and consent page, every
 *                   booking type: no hold sentence at all
 *   6. return page  /pay/success for the flight while its hold lands and
 *                   once the authorization stands
 *
 * A NEW BOOKING reads exactly as it did before booking types had their own
 * conditions. Elsewhere: the NEW BOOKING request's full hold wording in
 * payment-request-hold-wording, the consent page's other hold copy in
 * consent-form-hold, the car's return page per booking type in
 * pay-success-hold-states.
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

const { drainPendingEmails } = await import("@/server/services/email-outbox.service");

/* ------------------------------------------------------------------ *
 * Two Stripe brands: one authorizes, one charges
 * ------------------------------------------------------------------ */

type BrandKey = "hold" | "pay";

const BRAND: Record<BrandKey, { slug: string; brandName: string; captureMode: CaptureMode }> = {
  /** Manual capture: its checkouts only authorize the card. */
  hold: { slug: "holdco", brandName: "HoldCo Travel", captureMode: CaptureMode.MANUAL },
  /** Automatic capture: charged at checkout, like every incumbent brand. */
  pay: { slug: "payco", brandName: "PayCo Travel", captureMode: CaptureMode.AUTOMATIC },
};

/** Each brand's own test credentials. */
const ORG_ENV: Record<string, string> = {
  ORG_HOLDCO_STRIPE_SECRET_KEY: "sk_test_holdco_only",
  ORG_HOLDCO_STRIPE_WEBHOOK_SECRET: "whsec_holdco_only",
  ORG_PAYCO_STRIPE_SECRET_KEY: "sk_test_payco_only",
  ORG_PAYCO_STRIPE_WEBHOOK_SECRET: "whsec_payco_only",
};

const AIRLINE = "Air India";

const operator = actorFor(UserRole.ADMIN, { name: "Olivia Operator" });

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
const orgIds = {} as Record<BrandKey, Types.ObjectId>;

async function makeOrg(key: BrandKey): Promise<Types.ObjectId> {
  const spec = BRAND[key];
  const doc = await Organization.create({
    slug: spec.slug,
    name: spec.slug,
    brandName: spec.brandName,
    isDefault: false,
    payments: { provider: PaymentGatewayKey.STRIPE, captureMode: spec.captureMode },
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT],
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

/** The operator, signed in, working in `key`'s brand. */
async function actingAs(key: BrandKey) {
  sessionMock?.restore();
  sessionMock = await mockSession(operator);
  setNextHeaders({ cookies: { [orgCookieName()]: String(orgIds[key]) } });
}

/** A customer's browser or Stripe: no session, no organization. */
function anonymous() {
  sessionMock?.restore();
  sessionMock = null;
  setNextHeaders({});
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  Object.assign(process.env, ORG_ENV);
  sentMail.length = 0;
  orgIds.hold = await makeOrg("hold");
  orgIds.pay = await makeOrg("pay");
  await actingAs("hold");
  // A global airline: both brands may book it. The car supplier (Budget) is
  // a seeded one.
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
  setNextHeaders({});
});

/* ------------------------------------------------------------------ *
 * What each booking type's hold must say — in the customer's words
 * ------------------------------------------------------------------ */

type Kind = "car" | "flight";

/** The one charge each order collects, named as an operator names it. */
const CHARGE_NAME: Record<Kind, Record<BookingType, string>> = {
  car: {
    [BookingType.NEW_BOOKING]: "Rental cost",
    [BookingType.MODIFICATION]: "Date change fee",
    [BookingType.CANCELLATION_CHARGE]: "Late cancellation fee",
  },
  flight: {
    [BookingType.NEW_BOOKING]: "Processing Fee",
    [BookingType.MODIFICATION]: "Date Change Fee",
    [BookingType.CANCELLATION_CHARGE]: "Cancellation Fee",
  },
};

/** One order: the car holds $249.99, the flight its $100.00 charge. */
interface Case {
  /** Who is booking what — the it() subject. */
  name: string;
  kind: Kind;
  bookingType: BookingType;
  /** The condition, as the request's line under the amount states it. */
  once: string;
  /** The request's default intro on a hold, from "Thanks for booking". */
  holdIntro: string;
  /** The line under the held amount. */
  holdLine: string;
  /** What the consent page's footnote says the hold waits for. */
  consentCondition: string;
  /** The PAYMENT_AUTHORIZED banner either side of its bold "no money has
   *  been taken yet" — which closes BEFORE the full stop, so the two halves
   *  are pinned apart. */
  banner: [string, string];
  /** Its "What happens next" bullets, in order, up to the hold-expiry one. */
  nextSteps: string[];
  /** …and what that last one waits on: "If <this> by <the deadline>, the
   *  hold expires on its own …" (`expiryStep`). */
  expiresIf: string;
  /** What that email must never say: another type's release promise — and,
   *  for a cancellation, any promise about a booking that "can't be
   *  confirmed", or a deadline "we haven't confirmed" by. */
  authorizedNeverSays: string[];
  /** The same order's intro on an AUTOMATIC brand: the request as it always read. */
  payIntro: string;
}

const RELEASE_IN_FULL_STEP =
  "If it can't be confirmed, the hold is released in full and nothing is ever taken from your account.";

/** The hold-expiry bullet that closes `c`'s "What happens next", `on` the
 *  deadline the authorization set — the same sentence for every booking
 *  type but for what the hold waits on. */
function expiryStep(c: Case, on: string): string {
  return `If ${c.expiresIf} by ${on}, the hold expires on its own and the funds return to your available balance.`;
}

/** The authorization's "What happens next" as `steps` exactly: those
 *  bullets, in that order, and none after the last — the line under the
 *  list ("Your bank may show …") follows it. */
function whatHappensNext(steps: string[]): string {
  return `What happens next • ${steps.join(" • ")} Your bank may show`;
}

const CASES: Case[] = [
  {
    name: "a car NEW BOOKING",
    kind: "car",
    bookingType: BookingType.NEW_BOOKING,
    once: "your rental is confirmed with Budget",
    holdIntro:
      "Thanks for booking with Budget. Your new booking is reserved — please authorize your card using the secure link below to confirm it. You won't be charged until your rental is confirmed.",
    holdLine: "A hold on your card, not a charge — we charge it only once your rental is confirmed with Budget.",
    consentCondition: "your booking is confirmed",
    banner: [
      "Your card has been authorized for $249.99 — this is a hold, and no money has been taken yet",
      "We'll charge it only once your rental is confirmed with Budget. If we can't confirm it, we release the hold in full and you are never charged.",
    ],
    nextSteps: [
      "We're confirming your rental with Budget.",
      "Once it's confirmed we charge exactly $249.99 — not a penny more — and email you the confirmation.",
      RELEASE_IN_FULL_STEP,
    ],
    expiresIf: "we haven't confirmed",
    authorizedNeverSays: ["If it can't be confirmed, we release"],
    payIntro:
      "Thanks for booking with Budget. Your new booking is reserved — please complete payment using the secure link below to confirm it.",
  },
  {
    name: "a car MODIFICATION",
    kind: "car",
    bookingType: BookingType.MODIFICATION,
    once: "the change to your rental is confirmed with Budget",
    holdIntro:
      "Thanks for booking with Budget. Your modification is reserved — please authorize your card using the secure link below to confirm it. You won't be charged until the change to your rental is confirmed.",
    holdLine:
      "A hold on your card, not a charge — we charge it only once the change to your rental is confirmed with Budget.",
    consentCondition: "the change to your booking is confirmed",
    banner: [
      "Your card has been authorized for $249.99 — this is a hold, and no money has been taken yet",
      "We'll charge it only once the change to your rental is confirmed with Budget. If it can't be confirmed, we release the hold in full and you are never charged.",
    ],
    nextSteps: [
      "We're confirming the change to your rental with Budget.",
      "Once it's confirmed we charge exactly $249.99 — not a penny more — and email you the confirmation.",
      RELEASE_IN_FULL_STEP,
    ],
    expiresIf: "we haven't confirmed",
    authorizedNeverSays: ["If we can't confirm it"],
    payIntro:
      "Thanks for booking with Budget. Your modification is reserved — please complete payment using the secure link below to confirm it.",
  },
  {
    name: "a car CANCELLATION CHARGE",
    kind: "car",
    bookingType: BookingType.CANCELLATION_CHARGE,
    once: "your cancellation is processed",
    holdIntro:
      "Thanks for booking with Budget. Your cancellation charge is reserved — please authorize your card using the secure link below to confirm it. You won't be charged until your cancellation is processed.",
    holdLine: "A hold on your card, not a charge — we charge it only once your cancellation is processed.",
    consentCondition: "your cancellation is processed",
    banner: [
      "Your card has been authorized for $249.99 — this is a hold, and no money has been taken yet",
      "We'll charge it only once your cancellation is processed.",
    ],
    nextSteps: [
      "We're processing your cancellation.",
      "Once it's processed we charge exactly $249.99 — not a penny more — and email you the confirmation.",
    ],
    expiresIf: "it hasn't been processed",
    authorizedNeverSays: ["can't be confirmed", "can't confirm", "haven't confirmed"],
    payIntro:
      "Thanks for booking with Budget. Your cancellation charge is reserved — please complete payment using the secure link below to confirm it.",
  },
  {
    name: "an itinerary flight NEW BOOKING",
    kind: "flight",
    bookingType: BookingType.NEW_BOOKING,
    once: "your flight is confirmed with Air India",
    holdIntro:
      "Thanks for booking with Air India. Your new booking is reserved — please authorize the Processing Fee using the secure link below to confirm it. You won't be charged until your flight is confirmed.",
    holdLine: "A hold on your card, not a charge — we charge it only once your flight is confirmed with Air India.",
    consentCondition: "your booking is confirmed",
    banner: [
      "Your card has been authorized for the $100.00 Processing Fee — this is a hold, and no money has been taken yet",
      "We'll charge it only once your flight is confirmed with Air India. If we can't confirm it, we release the hold in full and you are never charged.",
    ],
    nextSteps: [
      "We're confirming your flight with Air India.",
      "Once it's confirmed we charge exactly the $100.00 Processing Fee — not a penny more — and email you the confirmation. The Airline Charge is not part of it.",
      RELEASE_IN_FULL_STEP,
    ],
    expiresIf: "we haven't confirmed",
    authorizedNeverSays: ["If it can't be confirmed, we release"],
    payIntro:
      "Thanks for booking with Air India. Your new booking is reserved — please pay the Processing Fee using the secure link below to confirm it.",
  },
  {
    name: "an itinerary flight MODIFICATION",
    kind: "flight",
    bookingType: BookingType.MODIFICATION,
    once: "the change to your flight is confirmed with Air India",
    holdIntro:
      "Thanks for booking with Air India. Your modification is reserved — please authorize your card using the secure link below to confirm it. You won't be charged until the change to your flight is confirmed.",
    holdLine:
      "A hold on your card, not a charge — we charge it only once the change to your flight is confirmed with Air India.",
    consentCondition: "the change to your booking is confirmed",
    banner: [
      "Your card has been authorized for $100.00 — this is a hold, and no money has been taken yet",
      "We'll charge it only once the change to your flight is confirmed with Air India. If it can't be confirmed, we release the hold in full and you are never charged.",
    ],
    nextSteps: [
      "We're confirming the change to your flight with Air India.",
      "Once it's confirmed we charge exactly $100.00 — not a penny more — and email you the confirmation.",
      RELEASE_IN_FULL_STEP,
    ],
    expiresIf: "we haven't confirmed",
    authorizedNeverSays: ["If we can't confirm it"],
    payIntro:
      "Thanks for booking with Air India. Your modification is reserved — please complete payment using the secure link below to confirm it.",
  },
  {
    name: "an itinerary flight CANCELLATION CHARGE",
    kind: "flight",
    bookingType: BookingType.CANCELLATION_CHARGE,
    once: "your cancellation is processed",
    holdIntro:
      "Thanks for booking with Air India. Your cancellation charge is reserved — please authorize your card using the secure link below to confirm it. You won't be charged until your cancellation is processed.",
    holdLine: "A hold on your card, not a charge — we charge it only once your cancellation is processed.",
    consentCondition: "your cancellation is processed",
    banner: [
      "Your card has been authorized for $100.00 — this is a hold, and no money has been taken yet",
      "We'll charge it only once your cancellation is processed.",
    ],
    nextSteps: [
      "We're processing your cancellation.",
      "Once it's processed we charge exactly $100.00 — not a penny more — and email you the confirmation.",
    ],
    expiresIf: "it hasn't been processed",
    authorizedNeverSays: ["can't be confirmed", "can't confirm", "haven't confirmed"],
    payIntro:
      "Thanks for booking with Air India. Your cancellation charge is reserved — please complete payment using the secure link below to confirm it.",
  },
];

/** Phrases only a hold of THIS booking type may say — so each one, read on
 *  an order of another type, means that order states the wrong condition.
 *  (A modification's "the change to your rental is confirmed" contains
 *  "your rental is confirmed", hence the new booking's longer phrases.) */
const OWN_WORDS: Record<Kind, Record<BookingType, string[]>> = {
  car: {
    [BookingType.NEW_BOOKING]: [
      "until your rental is confirmed",
      "only once your rental is confirmed",
      "confirming your rental",
    ],
    [BookingType.MODIFICATION]: ["the change to your rental"],
    [BookingType.CANCELLATION_CHARGE]: [
      "your cancellation is processed",
      "processing your cancellation",
      "Once it's processed",
      "hasn't been processed",
    ],
  },
  flight: {
    [BookingType.NEW_BOOKING]: [
      "until your flight is confirmed",
      "only once your flight is confirmed",
      "confirming your flight",
    ],
    [BookingType.MODIFICATION]: ["the change to your flight"],
    [BookingType.CANCELLATION_CHARGE]: [
      "your cancellation is processed",
      "processing your cancellation",
      "Once it's processed",
      "hasn't been processed",
    ],
  },
};

/** The consent page speaks of the "booking" whatever is booked. */
const OWN_CONSENT_WORDS: Record<BookingType, string> = {
  [BookingType.NEW_BOOKING]: "only once your booking is confirmed",
  [BookingType.MODIFICATION]: "the change to your booking",
  [BookingType.CANCELLATION_CHARGE]: "your cancellation is processed",
};

/** Every other booking type's phrases. */
function othersWords(kind: Kind, own: BookingType): string[] {
  return BOOKING_TYPES.filter((t) => t !== own).flatMap((t) => OWN_WORDS[kind][t]);
}

/** Hold sentences a request charged at checkout never carries. (The
 *  built-in flight terms mention a card "authorized (held)" — legal text,
 *  the same under either mode — so "collected only once" is not among
 *  them for an email.) */
const REQUEST_HOLD_WORDS = [
  "You won't be charged",
  "A hold on your card",
  "charge it only once",
  "authorize your card",
  "a hold, not a charge",
  "the change to your",
  "your cancellation is processed",
];

/** …and hold sentences a consent page for such an order never carries. */
const CONSENT_HOLD_WORDS = [
  "authorize your card",
  "places a hold",
  "collected only once",
  "the change to your",
  "your cancellation is processed",
];

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

/** The text a reader sees in rendered HTML: no head, no tags, entities and
 *  React's text-node separators resolved, whitespace collapsed. A tag is
 *  read as a space, so "<strong>…yet</strong>." reads "…yet ." — never pin
 *  a sentence across that boundary. */
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

/* ------------------------------------------------------------------ *
 * What the operator, the customer and Stripe do — the real routes
 * ------------------------------------------------------------------ */

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

async function ok<T>(res: Response, status = 200): Promise<T> {
  const { status: got, body } = await jsonBody<{ ok: boolean; data: T }>(res);
  expect(got, JSON.stringify(body)).toBe(status);
  return body.data;
}

interface SentEmail {
  html: string;
  text: string;
}

interface AuthorizedEmail extends SentEmail {
  /** The deadline the authorization set on the hold, as the email prints it. */
  holdExpiresOn: string;
}

function onlySentSince(mark: number, kind: EmailKind): SentEmail {
  const found = sentMail
    .slice(mark)
    .filter((m) => (m.headers as Record<string, string>)["X-Entity-Kind"] === kind);
  expect(found, `expected exactly one ${kind} email`).toHaveLength(1);
  return { html: String(found[0]!.html), text: String(found[0]!.text) };
}

/** The create form's body: `kind`, booked as `bookingType`, its one prepaid
 *  charge named for that type. The flight is Delhi → Varanasi → Mumbai with
 *  a $400.00 Airline Charge the link never collects. */
function orderBody(kind: Kind, bookingType: BookingType) {
  const name = CHARGE_NAME[kind][bookingType];
  return kind === "car"
    ? validCreateOrderInput({
        bookingType,
        charges: [{ name, amount: 249.99, timing: PaymentTiming.PREPAID }],
      })
    : oneWayConnectingFlightInput(
        {
          provider: "AIRINDIA",
          bookingType,
          charges: [{ name, amount: 100, timing: PaymentTiming.PREPAID }],
        },
        { airlineFare: 400, pnr: null },
      );
}

/** POST /api/orders — the create form's submit. */
async function submitOrder(key: BrandKey, body: unknown): Promise<OrderDTO> {
  await actingAs(key);
  const { order } = await ok<{ order: OrderDTO }>(
    await createOrderRoute(buildRequest("/api/orders", { method: "POST", body })),
    201,
  );
  return order;
}

/** POST /api/orders/[id]/generate-payment-link — the composer's first step. */
async function generateLink(key: BrandKey, orderId: string): Promise<OrderDTO> {
  await actingAs(key);
  const { order } = await ok<{ order: OrderDTO }>(
    await generateLinkRoute(
      buildRequest(`/api/orders/${orderId}/generate-payment-link`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
  return order;
}

/** POST /api/orders/[id]/payment-request-preview — the composer's preview. */
async function composerPreview(key: BrandKey, orderId: string): Promise<string> {
  await actingAs(key);
  const { html } = await ok<{ html: string }>(
    await previewRoute(
      buildRequest(`/api/orders/${orderId}/payment-request-preview`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
  return html;
}

/** POST /api/orders/[id]/send-payment-request — the email as it left. */
async function sendRequest(key: BrandKey, orderId: string) {
  await actingAs(key);
  const mark = sentMail.length;
  const data = await ok<{ order: OrderDTO; sent: { consentToken: string | null } }>(
    await sendRequestRoute(
      buildRequest(`/api/orders/${orderId}/send-payment-request`, { method: "POST", body: {} }),
      idParams(orderId),
    ),
  );
  expect(data.sent.consentToken, "the send recorded no consent request").toBeTruthy();
  return { email: onlySentSince(mark, EmailKind.PAYMENT_LINK), consentToken: data.sent.consentToken! };
}

/**
 * Booked as `bookingType`, linked, previewed and sent in `key`'s brand. On
 * the MANUAL brand the link is the authorize-only checkout; on the
 * AUTOMATIC one it charges. As in production, the order carries no
 * PaymentIntent until the customer pays (the Stripe stub mints one with the
 * session): it is kept as `intentId` for the authorization to bring.
 */
async function requested(key: BrandKey, kind: Kind, bookingType: BookingType) {
  const created = await submitOrder(key, orderBody(kind, bookingType));
  expect(created.bookingType).toBe(bookingType);
  const order = await generateLink(key, created.id);
  if (BRAND[key].captureMode === CaptureMode.MANUAL) {
    expect(order.payment.capture).toMatchObject({
      method: CaptureMode.MANUAL,
      status: PaymentCaptureStatus.PENDING_AUTHORIZATION,
    });
  } else {
    expect(order.payment.capture).toBeNull();
  }
  const intentId = order.payment.paymentIntentId;
  expect(intentId, "the Stripe stub minted no PaymentIntent").toBeTruthy();
  await Order.updateOne({ _id: order.id }, { $set: { "payment.paymentIntentId": null } });

  const preview = await composerPreview(key, order.id);
  const { email, consentToken } = await sendRequest(key, order.id);
  return { order, intentId: intentId!, preview, email, consentToken };
}

/** /consent/[token] — the hosted page the email's button opens. */
async function consentPage(token: string): Promise<string> {
  anonymous();
  return renderToStaticMarkup(await ConsentPage({ params: Promise.resolve({ token }) }));
}

/**
 * The customer authorizes the hold: Stripe's checkout.session.completed
 * with payment_status "unpaid" (manual capture — an AUTHORIZATION), signed
 * with the MANUAL brand's own secret, to its own endpoint; then the outbox
 * run that delivers the email it queued.
 */
async function authorize(order: OrderDTO, intentId: string): Promise<AuthorizedEmail> {
  const slug = BRAND.hold.slug;
  anonymous();
  const payload = JSON.stringify(
    buildCheckoutCompleted({
      orderId: order.id,
      orderNumber: order.orderNumber,
      sessionId: order.payment.paymentSessionId!,
      paymentIntentId: intentId,
      amountTotal: Math.round(order.pricing.amount * 100),
      paymentStatus: "unpaid",
    }),
  );
  const delivery = new Request(`http://localhost/api/webhooks/stripe/${slug}`, {
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      "stripe-signature": signWebhook(payload, ORG_ENV.ORG_HOLDCO_STRIPE_WEBHOOK_SECRET!),
    }),
    body: payload,
  });
  const { status, body } = await jsonBody<{ ok: boolean; data: Record<string, unknown> }>(
    await stripeWebhookRoute(delivery as never, { params: Promise.resolve({ orgSlug: slug }) }),
  );
  expect(status, JSON.stringify(body)).toBe(200);
  expect(body.data).toMatchObject({ handled: true, duplicate: false });

  // Held, not charged — and the authorization brought the intent.
  const held = await Order.findById(order.id).lean<{
    payment: {
      paymentIntentId: string | null;
      capture: { status: string; amountAuthorized: number; captureExpiresAt: Date | null } | null;
    };
  } | null>();
  expect(held!.payment.capture).toMatchObject({
    status: PaymentCaptureStatus.AUTHORIZED,
    amountAuthorized: order.pricing.amount,
  });
  expect(held!.payment.paymentIntentId).toBe(intentId);
  const expiresAt = held!.payment.capture!.captureExpiresAt;
  expect(expiresAt, "the authorization set no deadline on the hold").toBeInstanceOf(Date);

  const mark = sentMail.length;
  const drained = await drainPendingEmails(10);
  expect(drained.sent, JSON.stringify(drained)).toBe(1);
  return {
    ...onlySentSince(mark, EmailKind.PAYMENT_AUTHORIZED),
    holdExpiresOn: formatEmailDate(expiresAt!),
  };
}

/**
 * /pay/success as Stripe's return URL opens it: the order number and the
 * Checkout Session the customer comes back from, in the customer's browser.
 * While the hold is still landing the render asks Stripe, whose stubbed
 * session is still open, so the order stays PENDING_AUTHORIZATION.
 */
async function returnPage(order: OrderDTO): Promise<string> {
  anonymous();
  const page = await PaymentSuccessPage({
    searchParams: Promise.resolve({
      order: order.orderNumber,
      session_id: order.payment.paymentSessionId!,
    }),
  } as Parameters<typeof PaymentSuccessPage>[0]);
  return visibleText(renderToStaticMarkup(page));
}

/** The deadline the template editor's authorization sample prints for its
 *  hold, whatever is booked. */
const SAMPLE_HOLD_EXPIRES_ON = "24 May 2026 • 15:42 UTC";

/** Admin → Email templates, the MANUAL brand selected: the `kind`'s sample
 *  booking, booked as `bookingType`. */
async function templatePreview(
  templateKey: "payment-request" | "payment-authorized",
  kind: Kind,
  bookingType: BookingType,
): Promise<string> {
  const { html } = await renderEmailPreview({
    organizationId: String(orgIds.hold),
    serviceType: kind === "car" ? ServiceType.CAR_RENTAL : ServiceType.FLIGHT,
    templateKey,
    providerKey: kind === "car" ? "BUDGET" : "AIRINDIA",
    bookingType,
  });
  expect(html, `the ${kind} ${templateKey} preview rendered nothing`).not.toBe("");
  return html;
}

/* ------------------------------------------------------------------ *
 * 1. The payment request
 * ------------------------------------------------------------------ */

describe("1. the payment request on a MANUAL Stripe brand: its intro and the line under the held amount name the booking type's own condition", () => {
  it.each(CASES.map((c) => [c.name, c.once, c] as const))(
    "%s is charged only once %s — the composer preview, the sent HTML and its plain text",
    async (_name, _once, c) => {
      const { preview, email } = await requested("hold", c.kind, c.bookingType);

      for (const [where, read] of Object.entries({
        "composer preview": visibleText(preview),
        "sent email (html)": visibleText(email.html),
        "sent email (text)": plainText(email.text),
      })) {
        expect(read, `${where}: the intro`).toContain(c.holdIntro);
        expect(read, `${where}: the line under the held amount`).toContain(c.holdLine);
        for (const word of othersWords(c.kind, c.bookingType)) {
          expect(read, `${where} says "${word}"`).not.toContain(word);
        }
      }
    },
  );
});

/* ------------------------------------------------------------------ *
 * 2. The consent page
 * ------------------------------------------------------------------ */

describe("2. the hosted consent page on a MANUAL Stripe brand: its footnote says when the hold is collected", () => {
  it.each(CASES.map((c) => [c.name, c.consentCondition, c] as const))(
    "%s: 'This places a hold, not a charge — the amount is collected only once %s'",
    async (_name, _condition, c) => {
      const { consentToken } = await requested("hold", c.kind, c.bookingType);
      const page = visibleText(await consentPage(consentToken));

      expect(page).toContain(
        "You'll be taken directly to Stripe Checkout to authorize your card. " +
          `This places a hold, not a charge — the amount is collected only once ${c.consentCondition}. ` +
          "Your timestamp and IP are recorded against this booking as evidence of consent. " +
          `Email support@${BRAND.hold.slug}.test if you need help.`,
      );
      for (const type of BOOKING_TYPES.filter((t) => t !== c.bookingType)) {
        expect(page, `the page says "${OWN_CONSENT_WORDS[type]}"`).not.toContain(OWN_CONSENT_WORDS[type]);
      }
    },
  );
});

/* ------------------------------------------------------------------ *
 * 3. The authorization email
 * ------------------------------------------------------------------ */

describe("3. the PAYMENT_AUTHORIZED email a real Stripe authorization queues: its banner and 'What happens next'", () => {
  it.each(CASES.map((c) => [c.name, c.once, c.expiresIf, c] as const))(
    "%s: 'We'll charge it only once %s', and next steps of its own down to 'If %s by <the hold's deadline>', the last of them — HTML and plain text",
    async (_name, _once, _expiresIf, c) => {
      const { order, intentId } = await requested("hold", c.kind, c.bookingType);
      const email = await authorize(order, intentId);
      // Every type's steps run straight on to the deadline the authorization
      // set, and the deadline closes the list, so nothing is added, dropped
      // or tacked on after it — and a cancellation's hold lapses if it
      // "hasn't been processed" by then, never if "we haven't confirmed":
      // its whole email speaks of processing.
      const steps = [...c.nextSteps, expiryStep(c, email.holdExpiresOn)];

      for (const [where, read] of Object.entries({
        html: visibleText(email.html),
        text: plainText(email.text),
      })) {
        expect(read, `${where}: the banner`).toContain(c.banner[0]);
        expect(read, `${where}: the banner`).toContain(c.banner[1]);
        expect(read, `${where}: what happens next`).toContain(whatHappensNext(steps));
        for (const said of [...othersWords(c.kind, c.bookingType), ...c.authorizedNeverSays]) {
          expect(read, `${where} says "${said}"`).not.toContain(said);
        }
      }
    },
  );
});

/* ------------------------------------------------------------------ *
 * 4. The template editor
 * ------------------------------------------------------------------ */

describe("4. the template editor's samples for a MANUAL Stripe brand, by booking type (renderEmailPreview)", () => {
  // The car and flight NEW BOOKING request samples are pinned in
  // payment-request-hold-wording.
  it.each(
    CASES.filter((c) => c.bookingType !== BookingType.NEW_BOOKING).map((c) => [c.name, c.once, c] as const),
  )(
    "the payment request sample for %s: 'we charge it only once %s', and an intro that agrees",
    async (_name, _once, c) => {
      const read = visibleText(await templatePreview("payment-request", c.kind, c.bookingType));

      expect(read, "the intro").toContain(c.holdIntro);
      expect(read, "the line under the held amount").toContain(c.holdLine);
      for (const word of othersWords(c.kind, c.bookingType)) {
        expect(read, `the sample says "${word}"`).not.toContain(word);
      }
    },
  );

  // The sample holds $150.00 where the booked car holds $249.99, and $95.00
  // — named the Service Charge on a new booking — where the booked flight
  // holds its $100.00 Processing Fee.
  const AS_SAMPLED: Record<Kind, (s: string) => string> = {
    car: (s) => s.replace("$249.99", "$150.00"),
    flight: (s) => s.replace("$100.00 Processing Fee", "$95.00 Service Charge").replace("$100.00", "$95.00"),
  };

  it.each(CASES.map((c) => [c.name, c.once, c.expiresIf, c] as const))(
    "the authorization sample for %s: 'We'll charge it only once %s', and next steps of its own down to 'If %s by <its deadline>', the last of them",
    async (_name, _once, _expiresIf, c) => {
      const read = visibleText(await templatePreview("payment-authorized", c.kind, c.bookingType));
      const sample = AS_SAMPLED[c.kind];
      const steps = [...c.nextSteps.map(sample), expiryStep(c, SAMPLE_HOLD_EXPIRES_ON)];

      expect(read, "the banner").toContain(sample(c.banner[0]));
      expect(read, "the banner").toContain(sample(c.banner[1]));
      expect(read, "what happens next").toContain(whatHappensNext(steps));
      for (const said of [...othersWords(c.kind, c.bookingType), ...c.authorizedNeverSays]) {
        expect(read, `the sample says "${said}"`).not.toContain(said);
      }
    },
  );
});

/* ------------------------------------------------------------------ *
 * 5. Automatic capture
 * ------------------------------------------------------------------ */

describe("5. an AUTOMATIC brand, every booking type: the request and the consent page read as they always have — no hold sentence", () => {
  it.each(CASES.map((c) => [c.name, c] as const))(
    "%s: the intro asks for payment, and neither the request nor the consent page speaks of a hold or its condition",
    async (_name, c) => {
      const { preview, email, consentToken } = await requested("pay", c.kind, c.bookingType);

      for (const [where, read] of Object.entries({
        "composer preview": visibleText(preview),
        "sent email (html)": visibleText(email.html),
        "sent email (text)": plainText(email.text),
      })) {
        expect(read, `${where}: the intro`).toContain(c.payIntro);
        for (const word of REQUEST_HOLD_WORDS) {
          expect(read, `${where} says "${word}"`).not.toContain(word);
        }
      }

      const page = visibleText(await consentPage(consentToken));
      expect(page).toContain(
        "You'll be taken directly to Stripe Checkout to complete payment. " +
          "Your timestamp and IP are recorded against this booking as evidence of consent. " +
          `Email support@${BRAND.pay.slug}.test if you need help.`,
      );
      for (const word of CONSENT_HOLD_WORDS) {
        expect(page, `the consent page says "${word}"`).not.toContain(word);
      }
    },
  );
});

/* ------------------------------------------------------------------ *
 * 6. The return page
 * ------------------------------------------------------------------ */

describe("6. /pay/success for the itinerary flight, by booking type: while the hold lands and once it stands, the page waits on the same condition as the emails", () => {
  // The car's three booking types are pinned in pay-success-hold-states. A
  // flight's new booking names its Processing Fee; a change or a
  // cancellation charge reads the generic hold sentences — each on its own
  // condition.
  const RETURN_PAGE: Record<BookingType, { landing: string; standing: string }> = {
    [BookingType.NEW_BOOKING]: {
      landing:
        "We’re confirming your card HoldCo Travel is waiting for Stripe to confirm the hold on your card for the Processing Fee. You won’t be charged until your flight is confirmed. This page refreshes automatically.",
      standing:
        "Your card has been authorized HoldCo Travel has placed a hold on your card for the Processing Fee of $100.00. You have not been charged yet — the amount is collected only once your flight is confirmed, and you’ll get a receipt then.",
    },
    [BookingType.MODIFICATION]: {
      landing:
        "We’re confirming your card HoldCo Travel is waiting for Stripe to confirm the hold on your card. You won’t be charged until the change to your flight is confirmed. This page refreshes automatically.",
      standing:
        "Your card has been authorized HoldCo Travel has placed a hold on your card for $100.00. You have not been charged yet — the amount is collected only once the change to your flight is confirmed, and you’ll get a receipt then.",
    },
    [BookingType.CANCELLATION_CHARGE]: {
      landing:
        "We’re confirming your card HoldCo Travel is waiting for Stripe to confirm the hold on your card. You won’t be charged until your cancellation is processed. This page refreshes automatically.",
      standing:
        "Your card has been authorized HoldCo Travel has placed a hold on your card for $100.00. You have not been charged yet — the amount is collected only once your cancellation is processed, and you’ll get a receipt then.",
    },
  };

  it.each(CASES.filter((c) => c.kind === "flight").map((c) => [c.name, c] as const))(
    "%s: 'You won’t be charged until …' while Stripe confirms the hold, then 'collected only once …' — its own condition both times",
    async (_name, c) => {
      const { order, intentId } = await requested("hold", c.kind, c.bookingType);
      const landing = await returnPage(order);
      await authorize(order, intentId);
      const standing = await returnPage(order);

      expect(landing, "while the hold lands").toContain(RETURN_PAGE[c.bookingType].landing);
      expect(standing, "once the hold stands").toContain(RETURN_PAGE[c.bookingType].standing);
      for (const [when, read] of Object.entries({
        "while the hold lands": landing,
        "once the hold stands": standing,
      })) {
        // The page sets its apostrophes (’) where the phrases are typed
        // straight: read as typed, "hasn’t been processed" is caught too.
        const typed = read.replace(/’/g, "'");
        for (const word of othersWords(c.kind, c.bookingType)) {
          expect(typed, `${when}, the page says "${word}"`).not.toContain(word);
        }
      }
    },
  );
});
