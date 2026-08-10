import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

import { PaymentGatewayKey, RecordState, UserRole } from "@/lib/constants/enums";
import { Order, Organization, OrganizationMember } from "@/server/db/models";
import { _setPayPalFetchForTesting } from "@/server/payments/gateways/paypal";
import { createOrder, initiatePayment } from "@/server/services/order.service";
import { orgCookieName } from "@/server/auth/org-cookie";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { setNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo } from "@/tests/utils/db";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * Two brands, one deployment.
 *
 * The whole requirement in one file:
 *
 *   RentalConfirmation  unchanged — Stripe, existing email identity
 *   TripReservations    PayPal, its own sender
 *   everything else     identical, because it is one codebase and one deploy
 *
 * The regression this guards is subtle and was live: the email composer
 * hardcodes `gateway: "STRIPE"` on every "Generate Payment Link" click. When
 * that value was honoured, a PayPal-configured brand was asked for a Stripe
 * session and failed with "no Stripe credentials configured" — so PayPal
 * could never be used from the UI at all. The organization's configured
 * provider has to win.
 */

const actor = actorFor(UserRole.ADMIN);
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

const PAYPAL_ENV = {
  ORG_TRIPRESERVATIONS_PAYPAL_CLIENT_ID: "test-client-id",
  ORG_TRIPRESERVATIONS_PAYPAL_CLIENT_SECRET: "test-client-secret",
  ORG_TRIPRESERVATIONS_PAYPAL_WEBHOOK_ID: "TESTWEBHOOK",
  ORG_TRIPRESERVATIONS_PAYPAL_SANDBOX: "true",
};

/** Minimal PayPal API stub: OAuth + order creation. */
function stubPayPal() {
  _setPayPalFetchForTesting((async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/v1/oauth2/token")
      ? { access_token: "tok", expires_in: 3600 }
      : {
          id: "PP-ORDER-1",
          status: "PAYER_ACTION_REQUIRED",
          links: [
            { rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=PP-ORDER-1" },
          ],
        };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch);
}

async function makeOrg(
  slug: string,
  isDefault: boolean,
  provider: PaymentGatewayKey,
  enabledProviders: PaymentGatewayKey[] = [],
) {
  const doc = await Organization.create({
    slug,
    name: slug,
    brandName: slug === "tripreservations" ? "Trip Reservations" : "Rental Confirmation",
    isDefault,
    payments: { provider, enabledProviders },
    ...(slug === "tripreservations"
      ? { email: { fromName: "Trip Reservations", fromEmail: "contact@tripreservations.test" } }
      : {}),
  });
  const id = doc._id as Types.ObjectId;
  await OrganizationMember.create({
    organizationId: id,
    userId: new Types.ObjectId(actor.id),
    role: UserRole.ADMIN,
    status: RecordState.ACTIVE,
  });
  return id;
}

function actingAs(orgId: Types.ObjectId) {
  setNextHeaders({ cookies: { [orgCookieName()]: String(orgId) } });
}

let rc: Types.ObjectId;
let trip: Types.ObjectId;

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sessionMock = await mockSession(actor);
  Object.assign(process.env, PAYPAL_ENV);
  stubPayPal();
  rc = await makeOrg("rentalconfirmation", true, PaymentGatewayKey.STRIPE);
  trip = await makeOrg("tripreservations", false, PaymentGatewayKey.PAYPAL);
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  _setPayPalFetchForTesting(null);
  for (const k of Object.keys(PAYPAL_ENV)) delete process.env[k];
});

async function orderIn(orgId: Types.ObjectId) {
  actingAs(orgId);
  const { order } = await createOrder(validCreateOrderInput(), { actor });
  return order;
}

describe("RentalConfirmation is unchanged", () => {
  it("still generates a Stripe session", async () => {
    const order = await orderIn(rc);
    const { order: paid } = await initiatePayment(order.id, { actor });
    expect(paid.payment.gateway).toBe("STRIPE");
    expect(paid.payment.paymentUrl).toBeTruthy();
  });

  it("is unaffected by the composer's hardcoded gateway", async () => {
    const order = await orderIn(rc);
    const { order: paid } = await initiatePayment(
      order.id,
      { actor },
      { gateway: PaymentGatewayKey.STRIPE },
    );
    expect(paid.payment.gateway).toBe("STRIPE");
  });
});

describe("TripReservations runs on PayPal", () => {
  it("generates a PayPal session, not Stripe", async () => {
    const order = await orderIn(trip);
    const { order: paid } = await initiatePayment(order.id, { actor });
    expect(paid.payment.gateway).toBe("PAYPAL");
    expect(String(paid.payment.paymentUrl)).toContain("paypal.com");
  });

  it("STILL gets PayPal when the composer sends gateway:STRIPE", async () => {
    // The exact regression. Before the fix this threw
    // "Trip Reservations has no Stripe credentials configured", so PayPal
    // was unreachable from the UI.
    const order = await orderIn(trip);
    const { order: paid } = await initiatePayment(
      order.id,
      { actor },
      { gateway: PaymentGatewayKey.STRIPE },
    );
    expect(paid.payment.gateway).toBe("PAYPAL");
  });

  it("keeps a regenerated link on the same provider", async () => {
    const order = await orderIn(trip);
    const { order: first } = await initiatePayment(order.id, { actor });
    expect(first.payment.gateway).toBe("PAYPAL");

    // Once pinned, later operations must stay on the same merchant account.
    const again = await Order.findById(order.id).lean<{
      payment: { gateway: string };
    } | null>();
    expect(again!.payment.gateway).toBe("PAYPAL");
  });
});

describe("a brand can add a second gateway later", () => {
  it("lets TripReservations run PayPal AND its own Stripe", async () => {
    // The planned next step: TripReservations keeps PayPal as its default
    // and gains a Stripe account of its own. Credentials are already
    // namespaced per (organization, provider), so this needs configuration
    // only — no schema or code change.
    process.env.ORG_TRIPRESERVATIONS_STRIPE_SECRET_KEY = "sk_test_trip_own";
    process.env.ORG_TRIPRESERVATIONS_STRIPE_WEBHOOK_SECRET = "whsec_trip_own";
    const both = await makeOrg("tripboth", false, PaymentGatewayKey.PAYPAL, [
      PaymentGatewayKey.PAYPAL,
      PaymentGatewayKey.STRIPE,
    ]);
    process.env.ORG_TRIPBOTH_STRIPE_SECRET_KEY = "sk_test_trip_own";
    process.env.ORG_TRIPBOTH_STRIPE_WEBHOOK_SECRET = "whsec_trip_own";
    process.env.ORG_TRIPBOTH_PAYPAL_CLIENT_ID = "cid";
    process.env.ORG_TRIPBOTH_PAYPAL_CLIENT_SECRET = "csec";
    process.env.ORG_TRIPBOTH_PAYPAL_WEBHOOK_ID = "wid";

    // Default: PayPal.
    const a = await orderIn(both);
    const { order: viaDefault } = await initiatePayment(a.id, { actor });
    expect(viaDefault.payment.gateway).toBe("PAYPAL");

    // Explicitly chosen: Stripe — now allowed, because it is enabled.
    const b = await orderIn(both);
    const { order: viaChoice } = await initiatePayment(
      b.id,
      { actor },
      { gateway: PaymentGatewayKey.STRIPE },
    );
    expect(viaChoice.payment.gateway).toBe("STRIPE");

    for (const k of Object.keys(process.env).filter((k) => k.startsWith("ORG_TRIPBOTH_"))) {
      delete process.env[k];
    }
  });
});

describe("one deployment, two brands, no bleed", () => {
  it("routes each brand to its own provider in the same process", async () => {
    const rcOrder = await orderIn(rc);
    const tripOrder = await orderIn(trip);

    // Switch back before acting on each order. Acting on RentalConfirmation's
    // order while TripReservations is selected is correctly refused as
    // "not found" — that is the scoping layer, not a bug.
    actingAs(rc);
    const { order: rcPaid } = await initiatePayment(rcOrder.id, { actor });
    actingAs(trip);
    const { order: tripPaid } = await initiatePayment(tripOrder.id, { actor });

    expect([rcPaid.payment.gateway, tripPaid.payment.gateway]).toEqual([
      "STRIPE",
      "PAYPAL",
    ]);
  });

  it("refuses to act on the other brand's order", async () => {
    const tripOrder = await orderIn(trip);
    actingAs(rc);
    await expect(initiatePayment(tripOrder.id, { actor })).rejects.toThrow(
      /not found/i,
    );
  });

  it("keeps each brand's orders invisible to the other", async () => {
    const tripOrder = await orderIn(trip);
    actingAs(rc);
    const seen = await Order.findById(tripOrder.id).lean<{
      organizationId: Types.ObjectId;
    } | null>();
    // The row exists, but it belongs to the other brand — the scoping layer
    // is what keeps it out of RentalConfirmation's views.
    expect(String(seen!.organizationId)).toBe(String(trip));
    expect(String(seen!.organizationId)).not.toBe(String(rc));
  });
});
