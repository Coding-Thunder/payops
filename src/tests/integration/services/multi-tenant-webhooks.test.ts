import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OrderStatus,
  PaymentGatewayKey,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { Order } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { createOrder as createOrderDoc } from "@/tests/factories/order.factory";
import { ensureMongo } from "@/tests/utils/db";
import {
  addMembership,
  seedSecondOrganization,
  seedTestOrganization,
} from "@/tests/utils/organization";

/**
 * WEBHOOK ISOLATION ACROSS TWO MERCHANT ACCOUNTS ON ONE DEPLOYMENT.
 *
 * Himanshu and RCR Cruise each have their own Stripe and PayPal accounts.
 * Both deliver to the same host. The failure this file exists to prevent is
 * the worst one in the codebase:
 *
 *   a customer's card is charged, the webhook is verified against the WRONG
 *   merchant's secret or applied to the WRONG tenant's order, and the
 *   booking sits in PAYMENT_PENDING forever while the money is gone.
 *
 * The design that prevents it: the TENANT IS IN THE URL. A gateway signature
 * can only be verified with the secret of the account that produced it, and
 * the payload must not be parsed before verification — so the tenant cannot
 * be derived from the event. `/api/webhooks/stripe` belongs to the
 * compatibility anchor; every other tenant gets
 * `/api/webhooks/stripe/<slug>`.
 *
 * Downstream, `findOrderForEndpoint` is a single chokepoint that refuses to
 * touch an order belonging to a different organization even when the
 * signature is perfectly valid.
 */

const { processGatewayEvent } = await import(
  "@/server/services/webhook.service"
);

const actor = actorFor(UserRole.ADMIN);
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
let himanshuId = "";
let rcrId = "";

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  himanshuId = await seedTestOrganization({
    serviceTypes: [ServiceType.CAR_RENTAL],
  });
  rcrId = await seedSecondOrganization({
    slug: "rcrwh",
    brandName: "RCR Cruise",
    serviceTypes: [ServiceType.FLIGHT, ServiceType.CRUISE],
  });
  await addMembership(himanshuId, actor.id);
  await addMembership(rcrId, actor.id);
  sessionMock = await mockSession(actor);
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  vi.unstubAllEnvs();
});

/** A PAID-able order owned by one organization. */
async function orderFor(organizationId: string | null, sessionId: string) {
  return createOrderDoc({
    organizationId: organizationId
      ? Order.base.Types.ObjectId.createFromHexString(organizationId)
      : null,
    status: OrderStatus.PAYMENT_PENDING,
    payment: {
      status: OrderStatus.PAYMENT_PENDING,
      gateway: PaymentGatewayKey.STRIPE,
      stripeSessionId: sessionId,
    },
  } as Parameters<typeof createOrderDoc>[0]);
}

/** A verified `checkout.completed`, matching `VerifiedPaymentEvent` exactly.
 *  `occurredAtMs` is fixed rather than `Date.now()` so a run is reproducible
 *  and `paidAt` can never be an Invalid Date. */
const OCCURRED_AT_MS = 1_788_000_000_000;

function paidEvent(sessionId: string, eventId: string) {
  return {
    eventId,
    type: "checkout.completed" as const,
    sessionId,
    orderId: null,
    paymentIntentId: `pi_${sessionId}`,
    amountTotalMinor: 19_950,
    occurredAtMs: OCCURRED_AT_MS,
    raw: {},
  };
}

/* ═════════════ one tenant's endpoint cannot settle another's order ═════════════ */

describe("a delivery may only settle its OWN organization's order", () => {
  it("REFUSES to mark a Himanshu order paid from the RCR endpoint", async () => {
    const order = await orderFor(himanshuId, "cs_himanshu_1");

    // A perfectly valid RCR-signed event that happens to reference a
    // Himanshu order. The money landed in RCR's merchant account; settling
    // Himanshu's booking with it would mismatch two legal entities' books.
    const result = await processGatewayEvent(
      paidEvent("cs_himanshu_1", "evt_rcr_1") as never,
      rcrId,
      false,
    );

    expect(result.handled).toBe(false);
    expect(result.reason).toBe("order_not_found");

    const after = await Order.findById(order._id).lean<{ status: string }>();
    // Completely untouched — not FAILED, not PAID, exactly as it was.
    expect(after?.status).toBe(OrderStatus.PAYMENT_PENDING);
  });

  it("REFUSES to mark an RCR order paid from the Himanshu endpoint", async () => {
    const order = await orderFor(rcrId, "cs_rcr_1");

    const result = await processGatewayEvent(
      paidEvent("cs_rcr_1", "evt_him_1") as never,
      himanshuId,
      true,
    );

    expect(result.handled).toBe(false);
    const after = await Order.findById(order._id).lean<{ status: string }>();
    expect(after?.status).toBe(OrderStatus.PAYMENT_PENDING);
  });

  it("SETTLES an order from its own organization's endpoint", async () => {
    const order = await orderFor(rcrId, "cs_rcr_ok");

    const result = await processGatewayEvent(
      paidEvent("cs_rcr_ok", "evt_rcr_ok") as never,
      rcrId,
      false,
    );

    expect(result.handled).toBe(true);
    const after = await Order.findById(order._id).lean<{ status: string }>();
    expect(after?.status).toBe(OrderStatus.PAID);
  });
});

/* ═════════════ unattributed history belongs to the anchor ═════════════ */

describe("unattributed pre-migration orders", () => {
  it("are settleable by the DEFAULT endpoint, as they always were", async () => {
    const order = await orderFor(null, "cs_legacy_1");

    const result = await processGatewayEvent(
      paidEvent("cs_legacy_1", "evt_legacy_1") as never,
      himanshuId,
      true, // the anchor
    );

    expect(result.handled).toBe(true);
    const after = await Order.findById(order._id).lean<{ status: string }>();
    expect(after?.status).toBe(OrderStatus.PAID);
  });

  it("are REFUSED by a non-default tenant's endpoint", async () => {
    // Otherwise the newer tenant could mark the incumbent's entire
    // pre-migration back catalogue paid from its own merchant account.
    const order = await orderFor(null, "cs_legacy_2");

    const result = await processGatewayEvent(
      paidEvent("cs_legacy_2", "evt_legacy_2") as never,
      rcrId,
      false, // NOT the anchor
    );

    expect(result.handled).toBe(false);
    const after = await Order.findById(order._id).lean<{ status: string }>();
    expect(after?.status).toBe(OrderStatus.PAYMENT_PENDING);
  });
});

/* ═════════════ idempotency survives the tenancy change ═════════════ */

describe("idempotency is unaffected by tenancy", () => {
  it("settles once when the same event is delivered twice", async () => {
    const order = await orderFor(rcrId, "cs_dupe");

    const first = await processGatewayEvent(
      paidEvent("cs_dupe", "evt_dupe") as never,
      rcrId,
      false,
    );
    const second = await processGatewayEvent(
      paidEvent("cs_dupe", "evt_dupe") as never,
      rcrId,
      false,
    );

    expect(first.handled).toBe(true);
    expect(second.duplicate).toBe(true);

    const after = await Order.findById(order._id).lean<{
      status: string;
      payment: { processedWebhookEventIds: string[] };
    }>();
    expect(after?.status).toBe(OrderStatus.PAID);
    expect(
      after?.payment.processedWebhookEventIds.filter((e) => e === "evt_dupe"),
    ).toHaveLength(1);
  });
});

/* ═════════════ credential resolution is per tenant ═════════════ */

describe("each tenant's webhook resolves its OWN credentials", () => {
  it("namespaces Stripe credentials by organization slug", async () => {
    vi.stubEnv("ORG_RCRWH_STRIPE_SECRET_KEY", "sk_live_rcr_only");
    vi.stubEnv("ORG_RCRWH_STRIPE_WEBHOOK_SECRET", "whsec_rcr_only");

    const { getGatewayForOrganization } = await import(
      "@/server/payments/resolve-gateway"
    );
    // Resolving RCR's gateway must not reach the deployment env credentials
    // that belong to the anchor.
    const gw = await getGatewayForOrganization(rcrId, {
      kind: "pinned",
      provider: PaymentGatewayKey.STRIPE,
    });
    expect(gw.key).toBe(PaymentGatewayKey.STRIPE);
  });

  it("refuses a non-anchor tenant with NO credentials instead of falling back", async () => {
    // The single most dangerous silent failure: charging one brand's
    // customers through another brand's merchant account.
    const bare = await seedSecondOrganization({
      slug: "barewh",
      brandName: "Bare",
    });
    const { getGatewayForOrganization } = await import(
      "@/server/payments/resolve-gateway"
    );
    await expect(
      getGatewayForOrganization(bare, {
        kind: "pinned",
        provider: PaymentGatewayKey.STRIPE,
      }),
    ).rejects.toThrow(/credentials/i);
  });

  it("keeps the anchor on its deployment env credentials, unchanged", async () => {
    // The incumbent's live Stripe configuration must not need migrating for
    // a second tenant to exist.
    const { getGatewayForOrganization } = await import(
      "@/server/payments/resolve-gateway"
    );
    const gw = await getGatewayForOrganization(himanshuId, {
      kind: "pinned",
      provider: PaymentGatewayKey.STRIPE,
    });
    expect(gw.key).toBe(PaymentGatewayKey.STRIPE);
  });

  it("refuses PayPal for a tenant that has not enabled it", async () => {
    const { getGatewayForOrganization } = await import(
      "@/server/payments/resolve-gateway"
    );
    await expect(
      getGatewayForOrganization(rcrId, {
        kind: "pinned",
        provider: PaymentGatewayKey.PAYPAL,
      }),
    ).rejects.toThrow(/not enabled/i);
  });
});

/* ═════════════ the per-tenant endpoints exist and are not oracles ═════════════ */

describe("per-organization webhook endpoints", () => {
  it("returns a flat 404 for an unknown slug", async () => {
    const { POST } = await import("@/app/api/webhooks/stripe/[orgSlug]/route");
    const res = await POST(
      new Request("http://localhost/api/webhooks/stripe/nope", {
        method: "POST",
        body: "{}",
      }) as never,
      { params: Promise.resolve({ orgSlug: "nope" }) },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    // Deliberately indistinguishable from "configured but no credentials" —
    // otherwise the endpoint enumerates which brands live here.
    expect(body.error.message).toBe("Unknown endpoint");
  });

  it("does not reveal that a known organization lacks credentials", async () => {
    await seedSecondOrganization({ slug: "silent", brandName: "Silent" });
    const { POST } = await import("@/app/api/webhooks/stripe/[orgSlug]/route");
    const res = await POST(
      new Request("http://localhost/api/webhooks/stripe/silent", {
        method: "POST",
        body: "{}",
      }) as never,
      { params: Promise.resolve({ orgSlug: "silent" }) },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toBe("Unknown endpoint");
  });
});
