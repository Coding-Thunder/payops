import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

import {
  PaymentGatewayKey,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import {
  Organization,
  OrganizationMember,
} from "@/server/db/models";
import { organizationScopeClause, belongsToScope } from "@/server/db/organization-filter";
import { orgCookieName } from "@/server/auth/org-cookie";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { setNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo } from "@/tests/utils/db";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * Regressions for two defects an adversarial review found after the
 * multi-organization work had already shipped and passed its own suite.
 *
 * Both are live-production bugs and neither is cosmetic: one served both
 * brands' data to a caller who had selected no organization, the other
 * created a Trip Reservations checkout on Rental Confirmation's Stripe
 * account. The tests below encode the specific wrong behaviour so it cannot
 * come back quietly the next time someone refactors nearby.
 */

const { sentMail } = vi.hoisted(() => ({
  sentMail: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/server/email/smtp", () => ({
  getMailer: () => ({
    sendMail: async (m: Record<string, unknown>) => {
      sentMail.push(m);
      return { messageId: "<t>", response: "250" };
    },
  }),
  getMailerFor: () => ({
    sendMail: async (m: Record<string, unknown>) => {
      sentMail.push(m);
      return { messageId: "<t>", response: "250" };
    },
  }),
  verifyMailer: async () => {},
  _resetOrgMailersForTests: () => {},
}));

const { listOrders, getOrderById, createOrder, initiatePayment, regeneratePaymentLink } =
  await import("@/server/services/order.service");
const { getRequestOrganizationScope } = await import(
  "@/server/auth/organization"
);
const { _setPayPalFetchForTesting } = await import(
  "@/server/payments/gateways/paypal"
);

const actor = actorFor(UserRole.ADMIN);
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

async function makeOrg(
  slug: string,
  isDefault: boolean,
  // Annotated, not inferred: a bare default narrows the parameter to the
  // literal "STRIPE" and every other provider stops type-checking.
  provider: PaymentGatewayKey = PaymentGatewayKey.STRIPE,
) {
  const doc = await Organization.create({
    slug,
    name: slug,
    brandName: slug,
    isDefault,
    payments: { provider },
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

function actingAs(orgId: Types.ObjectId | null) {
  setNextHeaders(orgId ? { cookies: { [orgCookieName()]: String(orgId) } } : {});
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sessionMock = await mockSession(actor);
  sentMail.length = 0;
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  _setPayPalFetchForTesting(null);
  vi.useRealTimers();
});

/* ───────────────────────────────────────────────────────────────────────── */

describe("P0-A · scoping fails CLOSED when no organization is selected", () => {
  it("a request with no selection sees NOTHING, not everything", async () => {
    // The defect: getRequestOrganizationScope returned {organizationId: null}
    // for a request with no cookie, and organizationScopeClause read null as
    // "no scoping applies". Invisible in the browser because the UI forces a
    // selection; a direct API call with only a session cookie read both
    // brands.
    const rc = await makeOrg("rentalconfirmation", true);
    const trip = await makeOrg("tripreservations", false);

    actingAs(rc);
    await createOrder(validCreateOrderInput(), { actor });
    actingAs(trip);
    await createOrder(validCreateOrderInput(), { actor });

    actingAs(null);
    const scope = await getRequestOrganizationScope();
    expect(scope.denyAll).toBe(true);

    const seen = await listOrders({ page: 1, pageSize: 50 } as never, { actor });
    expect(seen.total).toBe(0);
    expect(seen.items).toEqual([]);
  });

  it("hides a known order id from an unselected caller", async () => {
    const rc = await makeOrg("rentalconfirmation", true);
    actingAs(rc);
    const { order } = await createOrder(validCreateOrderInput(), { actor });

    actingAs(null);
    await expect(getOrderById(order.id, { actor })).rejects.toThrow(/not found/i);
  });

  it("still runs UNSCOPED on a deployment with no organizations", async () => {
    // The pre-migration world must be untouched — this is the compatibility
    // half of the fix, and getting it wrong would break every install that
    // has never seeded an organization.
    actingAs(null);
    const scope = await getRequestOrganizationScope();
    expect(scope.denyAll).toBeFalsy();
    expect(organizationScopeClause(scope)).toBeNull();
  });

  it("the primitive matches nothing and owns nothing when denied", () => {
    const denied = { organizationId: null, isDefault: false, denyAll: true };
    expect(organizationScopeClause(denied)).toEqual({ _id: { $in: [] } });
    expect(belongsToScope(null, denied)).toBe(false);
    expect(belongsToScope(new Types.ObjectId(), denied)).toBe(false);
  });
});

/* ───────────────────────────────────────────────────────────────────────── */

describe("P0-B · regenerating a link never reaches another brand's merchant account", () => {
  const PAYPAL_ENV = {
    ORG_TRIPRESERVATIONS_PAYPAL_CLIENT_ID: "cid",
    ORG_TRIPRESERVATIONS_PAYPAL_CLIENT_SECRET: "csec",
    ORG_TRIPRESERVATIONS_PAYPAL_WEBHOOK_ID: "wid",
    ORG_TRIPRESERVATIONS_PAYPAL_SANDBOX: "true",
  };

  function stubPayPal(created: Record<string, unknown>[]) {
    _setPayPalFetchForTesting((async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes("/v1/oauth2/token")) {
        return new Response(
          JSON.stringify({ access_token: "tok", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (init?.body) created.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          id: `PP-${created.length}`,
          status: "PAYER_ACTION_REQUIRED",
          links: [
            {
              rel: "payer-action",
              href: `https://www.paypal.com/checkoutnow?token=PP-${created.length}`,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch);
  }

  it("regenerates a PayPal order on PAYPAL, not the deployment's Stripe", async () => {
    // The defect: regeneratePaymentLink used a direct Stripe builder. Its
    // guard called getGatewayForOrganization(orgId, STRIPE), which for a
    // PayPal-only brand correctly IGNORES the override and returns the PayPal
    // gateway — so nothing threw. The Stripe credential lookup then found
    // nothing for that brand and fell back to the deployment's client, and
    // the operator got a Rental Confirmation checkout for a Trip Reservations
    // booking.
    Object.assign(process.env, PAYPAL_ENV);
    const created: Record<string, unknown>[] = [];
    stubPayPal(created);
    try {
      const trip = await makeOrg(
        "tripreservations",
        false,
        PaymentGatewayKey.PAYPAL,
      );
      actingAs(trip);
      const { order } = await createOrder(validCreateOrderInput(), { actor });
      await initiatePayment(order.id, { actor });

      const { order: regenerated } = await regeneratePaymentLink(order.id, {
        actor,
      });

      expect(regenerated.payment.gateway).toBe("PAYPAL");
      expect(String(regenerated.payment.paymentUrl)).toContain("paypal.com");
      expect(String(regenerated.payment.paymentUrl)).not.toContain("stripe");
      // Two PayPal orders created: the original and the regenerated one.
      expect(created).toHaveLength(2);
    } finally {
      for (const k of Object.keys(PAYPAL_ENV)) delete process.env[k];
    }
  });

  it("still regenerates a Stripe order on Stripe", async () => {
    const rc = await makeOrg("rentalconfirmation", true);
    actingAs(rc);
    const { order } = await createOrder(validCreateOrderInput(), { actor });
    await initiatePayment(order.id, { actor });

    const { order: regenerated } = await regeneratePaymentLink(order.id, {
      actor,
    });
    expect(regenerated.payment.gateway).toBe("STRIPE");
    expect(regenerated.payment.paymentUrl).toBeTruthy();
  });
});
