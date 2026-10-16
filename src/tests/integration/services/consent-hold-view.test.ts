import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import { GET as consentViewRoute } from "@/app/api/consent/[token]/route";
import {
  CaptureMode,
  ConsentStatus,
  PaymentCaptureStatus,
  PaymentGatewayKey,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { orgCookieName } from "@/server/auth/org-cookie";
import { Order, Organization, OrganizationMember } from "@/server/db/models";
import {
  getPublicConsentView,
  recordConsentFromToken,
  requestConsent,
} from "@/server/services/consent.service";
import {
  createOrder as factoryCreateOrder,
  type OrderSeed,
} from "@/tests/factories/order.factory";
import { createSettings } from "@/tests/factories/settings.factory";
import { buildRequest, jsonBody, type ApiOk } from "@/tests/utils/api";
import { actorFor, mockSession, type MockSessionHandle } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";
import type { PublicConsentView } from "@/types";

/**
 * `authorizationHold` on the public consent view: the one field that tells
 * the hosted consent page its checkout only places a HOLD on the card (the
 * order runs on manual capture, so an operator captures the money later).
 *
 *   1. It is `true` exactly when the ORDER's own capture record says MANUAL,
 *      the record pinned when its link was generated. That holds before the
 *      customer signs, in the view returned once they sign (the one the
 *      redirect screen reads), and on a replay.
 *   2. On an automatic order (capture null) the key is ABSENT, not `false`.
 *      The view, and the JSON that GET /api/consent/[token] serves, keep
 *      exactly the keys they had before holds existed.
 *   3. It is read live from the order, beside the link it describes. The
 *      organization's capture mode alone never sets it: a Stripe link
 *      generated before the switch to MANUAL, and a PayPal link (PayPal
 *      never authorizes), both charge at checkout. And it follows a
 *      regenerated link either way.
 *
 * Setup is consent.service.test.ts's: a factory order with a checkout link
 * and a consent request on record.
 */

const BRANDING = { brandName: "Test Brand" } as const;
const actor = actorFor(UserRole.ADMIN);

/** The public view's keys before `authorizationHold` existed. */
const PUBLIC_VIEW_KEYS = [
  "status",
  "customerName",
  "customerEmail",
  "brandName",
  "organizationId",
  "consentMessage",
  "snapshot",
  "paymentUrl",
  "gatewayLabel",
  "alreadyConfirmedAt",
].sort();

/** …and on a manual-capture order: those plus the flag, nothing else. */
const HOLD_VIEW_KEYS = [...PUBLIC_VIEW_KEYS, "authorizationHold"].sort();

/** Which keys a view carries, sorted: the set is pinned, not its order. */
function keysOf(view: object): string[] {
  return Object.keys(view).sort();
}

/** What link generation pins on a manual-capture order. */
const MANUAL_LINK = {
  method: CaptureMode.MANUAL,
  status: PaymentCaptureStatus.PENDING_AUTHORIZATION,
};

let seq = 0;

/**
 * A car order with a checkout link and a REQUESTED consent record.
 * `capture` is the order's capture record: null (the default) is an
 * automatic order, as on every order an automatic organization creates.
 * `gateway` is the processor the link opens: Stripe unless given.
 */
async function requestedConsent(
  opts: {
    capture?: NonNullable<OrderSeed["payment"]>["capture"];
    organizationId?: Types.ObjectId;
    gateway?: PaymentGatewayKey;
  } = {},
) {
  seq += 1;
  const gateway = opts.gateway ?? PaymentGatewayKey.STRIPE;
  // The session id field holds whichever processor's id the link has.
  const sessionId =
    gateway === PaymentGatewayKey.PAYPAL ? `5OHOLDVIEW${seq}` : `cs_test_hold_view_${seq}`;
  const order = await factoryCreateOrder({
    organizationId: opts.organizationId,
    payment: {
      status: "PAYMENT_PENDING",
      checkoutUrl:
        gateway === PaymentGatewayKey.PAYPAL
          ? `https://www.sandbox.paypal.com/checkoutnow?token=${sessionId}`
          : `https://checkout.stripe.com/c/pay/${sessionId}`,
      stripeSessionId: sessionId,
      processedWebhookEventIds: [],
      capture: opts.capture ?? null,
    },
  });
  // The factory builds no `payment.gateway`; a real link pins the processor
  // that holds its session.
  await Order.updateOne({ _id: order._id }, { $set: { "payment.gateway": gateway } });
  const { token, consent } = await requestConsent(
    {
      orderId: String(order._id),
      customerEmail: order.customer.email,
      customerName: order.customer.name,
      consentMessage:
        "I confirm that I understand and agree to proceed with this payment and booking.",
      consentEmailSubject: "Test subject",
      snapshot: {
        bookingType: order.bookingType,
        provider: order.provider.name,
        // A CAR_RENTAL seed: `vehicle` and `trip` are always built.
        vehicle: `${order.vehicle!.company} • ${order.vehicle!.type}`,
        pickupDate: order.trip!.pickupDate.toISOString(),
        dropoffDate: order.trip!.dropoffDate.toISOString(),
        amount: order.pricing.amount,
        currency: order.pricing.currency,
        paymentLinkRef: order.payment.checkoutUrl ?? null,
      },
    },
    { actor, appUrl: "http://127.0.0.1:3100" },
  );
  return { order, token, acknowledgement: consent.consentMessage };
}

/** The view as the public endpoint serves it: parsed JSON, not the object. */
async function servedView(token: string): Promise<Record<string, unknown>> {
  const res = await consentViewRoute(buildRequest(`/api/consent/${token}`), {
    params: Promise.resolve({ token }),
  });
  const { status, body } = await jsonBody<ApiOk<Record<string, unknown>>>(res);
  expect(status, JSON.stringify(body)).toBe(200);
  return body.data;
}

let sessionMock: MockSessionHandle | null = null;

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  setNextHeaders({});
});

describe("getPublicConsentView on a manual-capture order", () => {
  it.each([
    ["the link is out, not yet authorized", PaymentCaptureStatus.PENDING_AUTHORIZATION],
    ["the customer reopens the link after authorizing", PaymentCaptureStatus.AUTHORIZED],
  ])("says authorizationHold: true when %s", async (_case, status) => {
    const { token } = await requestedConsent({
      capture: { method: CaptureMode.MANUAL, status },
    });
    const view = await getPublicConsentView(token, BRANDING);
    expect(view.authorizationHold).toBe(true);
    // One key added; the rest of the view is the same view.
    expect(keysOf(view)).toEqual(HOLD_VIEW_KEYS);
    expect(view.gatewayLabel).toBe("Stripe");
    expect(view.paymentUrl).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_hold_view_/);
  });

  it("says it in the view returned once the customer signs (the one the redirect screen reads) and on a replay", async () => {
    const { token, acknowledgement } = await requestedConsent({ capture: MANUAL_LINK });
    const signed = await recordConsentFromToken(
      { token, acknowledgement, signedName: "Ada Lovelace" },
      { branding: BRANDING },
    );
    expect(signed.status).toBe(ConsentStatus.VERIFIED);
    expect(signed.authorizationHold).toBe(true);

    // A refresh or double-submit after signing.
    const replay = await recordConsentFromToken({ token, acknowledgement }, { branding: BRANDING });
    expect(replay.alreadyConfirmedAt).toBe(signed.alreadyConfirmedAt);
    expect(replay.authorizationHold).toBe(true);
  });
});

describe("getPublicConsentView on an automatic order", () => {
  it("leaves authorizationHold out entirely, not false, so the view keeps its exact shape", async () => {
    const { token } = await requestedConsent();
    const view = await getPublicConsentView(token, BRANDING);
    expect(view).not.toHaveProperty("authorizationHold");
    expect(keysOf(view)).toEqual(PUBLIC_VIEW_KEYS);
  });

  it("leaves it out of the view returned once the customer signs, and of a replay", async () => {
    const { token, acknowledgement } = await requestedConsent();
    const signed = await recordConsentFromToken(
      { token, acknowledgement, signedName: "Ada Lovelace" },
      { branding: BRANDING },
    );
    expect(signed.status).toBe(ConsentStatus.VERIFIED);
    expect(keysOf(signed)).toEqual(PUBLIC_VIEW_KEYS);

    const replay = await recordConsentFromToken({ token, acknowledgement }, { branding: BRANDING });
    expect(keysOf(replay)).toEqual(PUBLIC_VIEW_KEYS);
  });
});

describe("GET /api/consent/[token]: the public payload", () => {
  it("serves authorizationHold: true for a manual-capture order, and no such key at all for an automatic one", async () => {
    const manual = await requestedConsent({ capture: MANUAL_LINK });
    const automatic = await requestedConsent();

    const held = await servedView(manual.token);
    expect(held.authorizationHold).toBe(true);
    expect(keysOf(held)).toEqual(HOLD_VIEW_KEYS);

    const charged = await servedView(automatic.token);
    expect(keysOf(charged)).toEqual(PUBLIC_VIEW_KEYS);
    expect(JSON.stringify(charged)).not.toContain("authorizationHold");
  });
});

describe("authorizationHold follows the order's own link, read live", () => {
  /** An organization on MANUAL capture through Stripe, with the operator a
   *  member and selected, so the operator can request consent in it. */
  async function selectManualCaptureOrganization(): Promise<Types.ObjectId> {
    const org = await Organization.create({
      slug: "holdfast",
      name: "holdfast",
      brandName: "Holdfast Rentals",
      isDefault: false,
      payments: { provider: PaymentGatewayKey.STRIPE, captureMode: CaptureMode.MANUAL },
      serviceTypes: [ServiceType.CAR_RENTAL],
      email: { fromName: "Holdfast Rentals", fromEmail: "no-reply@holdfast.test" },
    });
    const id = org._id as Types.ObjectId;
    await OrganizationMember.create({
      organizationId: id,
      userId: new Types.ObjectId(actor.id),
      role: UserRole.ADMIN,
      status: RecordState.ACTIVE,
    });
    sessionMock = await mockSession(actor);
    setNextHeaders({ cookies: { [orgCookieName()]: String(id) } });
    return id;
  }

  // Link generation writes no capture record for either link (PayPal is
  // never manual capture), so the order says "automatic" and so must the
  // page, whatever the organization is set to now.
  it.each([
    [
      "a Stripe link generated before the switch to MANUAL",
      PaymentGatewayKey.STRIPE,
      "Stripe",
    ],
    ["a PayPal link the operator picked in the composer", PaymentGatewayKey.PAYPAL, "PayPal"],
  ])(
    "stays absent in a MANUAL organization for %s: that link charges at checkout",
    async (_case, gateway, label) => {
      const orgId = await selectManualCaptureOrganization();
      const { token } = await requestedConsent({ organizationId: orgId, gateway });

      const view = await getPublicConsentView(token, BRANDING);
      expect(view.organizationId).toBe(String(orgId));
      expect(view.brandName).toBe("Holdfast Rentals");
      expect(view.gatewayLabel).toBe(label);
      expect(view).not.toHaveProperty("authorizationHold");
    },
  );

  it("turns on when the link is regenerated on manual capture, and off again when it is regenerated on automatic", async () => {
    const { order, token } = await requestedConsent();
    expect(await getPublicConsentView(token, BRANDING)).not.toHaveProperty("authorizationHold");

    // What a regeneration on a MANUAL organization writes beside the new link.
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          "payment.checkoutUrl": "https://checkout.stripe.com/c/pay/cs_test_regenerated_manual",
          "payment.capture": MANUAL_LINK,
        },
      },
    );
    const held: PublicConsentView = await getPublicConsentView(token, BRANDING);
    expect(held.paymentUrl).toBe("https://checkout.stripe.com/c/pay/cs_test_regenerated_manual");
    expect(held.authorizationHold).toBe(true);

    // And one on an organization switched back to AUTOMATIC: the manual
    // record goes with the old link.
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          "payment.checkoutUrl": "https://checkout.stripe.com/c/pay/cs_test_regenerated_automatic",
          "payment.capture": null,
        },
      },
    );
    const charged = await getPublicConsentView(token, BRANDING);
    expect(charged.paymentUrl).toBe("https://checkout.stripe.com/c/pay/cs_test_regenerated_automatic");
    expect(keysOf(charged)).toEqual(PUBLIC_VIEW_KEYS);
  });
});
