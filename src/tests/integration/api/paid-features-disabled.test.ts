import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { OrderStatus, UserRole } from "@/lib/constants/enums";
import { PAID_FEATURES_ENABLED } from "@/lib/paid-features";
import { POST as exportRoute } from "@/app/api/orders/export/route";
import { POST as manualPaymentRoute } from "@/app/api/orders/[id]/manual-payment/route";
import { POST as switchGatewayRoute } from "@/app/api/orders/[id]/switch-gateway/route";
import { GET as gatewayOptionsRoute } from "@/app/api/orders/[id]/gateway-options/route";
import { POST as modifyRoute } from "@/app/api/orders/[id]/modify/route";
import { POST as repriceRoute } from "@/app/api/orders/[id]/reprice/route";
import { POST as sendRequestRoute } from "@/app/api/orders/[id]/send-payment-request/route";
import { POST as previewRoute } from "@/app/api/orders/[id]/payment-request-preview/route";
import { Order } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { mockNextHeaders } from "@/tests/utils/next-headers";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { seedTestOrganization } from "@/tests/utils/organization";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * The paid features are switched off until they are paid for. Their code is
 * all still here — these pin that an operator cannot reach them by calling
 * the API directly, and that the product that existed before them is not
 * affected.
 *
 * NB: no `vi.mock` of `@/lib/paid-features` in this file — it deliberately
 * runs against the real flag, exactly as the deployed app does.
 */

const { createOrder } = await import("@/server/services/order.service");

const admin = actorFor(UserRole.ADMIN);
const ctx = { actor: admin, request: null };
const params = (id: string) => ({ params: Promise.resolve({ id }) });

let headersMock: Awaited<ReturnType<typeof mockNextHeaders>>;
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await seedTestOrganization();
  headersMock = await mockNextHeaders();
  sessionMock = await mockSession(admin);
});
afterEach(async () => {
  await headersMock.restore();
  sessionMock?.restore();
  sessionMock = null;
});

async function makeOrder() {
  const { order } = await createOrder(validCreateOrderInput(), ctx);
  return order;
}
const email = {
  subject: "Your booking",
  greeting: "Hi Ada,",
  intro: "Please review the booking below.",
  note: "",
};

describe("the paid features are off", () => {
  it("the flag is the single switch, and it is off", () => {
    expect(PAID_FEATURES_ENABLED).toBe(false);
  });

  it("refuses every paid route with 403 and changes nothing", async () => {
    const order = await makeOrder();
    const before = await Order.findById(order.id).lean();

    const calls: Array<[string, Promise<Response>]> = [
      ["export", exportRoute(buildRequest("/api/orders/export", { method: "POST", body: { ids: [order.id] } }))],
      ["manual-payment", manualPaymentRoute(
        buildRequest(`/api/orders/${order.id}/manual-payment`, { method: "POST", body: { method: "Card terminal", reference: "AUTH-1" } }),
        params(order.id) as never,
      )],
      ["switch-gateway", switchGatewayRoute(
        buildRequest(`/api/orders/${order.id}/switch-gateway`, { method: "POST", body: { gateway: "PAYPAL" } }),
        params(order.id) as never,
      )],
      ["gateway-options", gatewayOptionsRoute(
        buildRequest(`/api/orders/${order.id}/gateway-options`, { method: "GET" }),
        params(order.id) as never,
      )],
      ["modify", modifyRoute(
        buildRequest(`/api/orders/${order.id}/modify`, { method: "POST", body: { charges: [{ name: "Rental cost", amount: 999, timing: "PREPAID" }], expectedUpdatedAt: new Date().toISOString() } }),
        params(order.id) as never,
      )],
      ["reprice", repriceRoute(
        buildRequest(`/api/orders/${order.id}/reprice`, { method: "POST", body: { charges: [{ name: "Rental cost", amount: 999, timing: "PREPAID" }] } }),
        params(order.id) as never,
      )],
      ["manual send", sendRequestRoute(
        buildRequest(`/api/orders/${order.id}/send-payment-request`, { method: "POST", body: { ...email, collection: "MANUAL" } }),
        params(order.id) as never,
      )],
      ["manual preview", previewRoute(
        buildRequest(`/api/orders/${order.id}/payment-request-preview`, { method: "POST", body: { ...email, collection: "MANUAL" } }),
        params(order.id) as never,
      )],
    ];

    for (const [name, call] of calls) {
      const { status, body } = await jsonBody(await call);
      expect(`${name}:${status}`).toBe(`${name}:403`);
      expect((body as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    }

    // Nothing was written by any of them: same amount, same status, same
    // payment, and no manual payment recorded.
    const after = await Order.findById(order.id).lean();
    expect(after).toEqual(before);
  });

  it("still refuses them for an order that does not exist, without leaking that", async () => {
    const { status } = await jsonBody(
      await manualPaymentRoute(
        buildRequest("/api/orders/ffffffffffffffffffffffff/manual-payment", { method: "POST", body: { method: "Card terminal", reference: "AUTH-1" } }),
        params("ffffffffffffffffffffffff") as never,
      ),
    );
    expect(status).toBe(403);
  });

  it("leaves the gateway payment request — the original product — working", async () => {
    const order = await makeOrder();
    // A gateway send needs a link, exactly as before.
    const { status } = await jsonBody(
      await sendRequestRoute(
        buildRequest(`/api/orders/${order.id}/send-payment-request`, { method: "POST", body: { ...email, collection: "GATEWAY" } }),
        params(order.id) as never,
      ),
    );
    // Refused for the pre-existing reason (no link yet), NOT by the flag.
    expect(status).toBe(409);

    const preview = await jsonBody(
      await previewRoute(
        buildRequest(`/api/orders/${order.id}/payment-request-preview`, { method: "POST", body: { ...email, collection: "GATEWAY" } }),
        params(order.id) as never,
      ),
    );
    expect(preview.status).toBe(200);
    expect(JSON.stringify(preview.body)).toMatch(/html/i);
  });

  it("leaves order creation, listing and detail untouched", async () => {
    const order = await makeOrder();
    const doc = await Order.findById(order.id).lean<{ status: string; pricing: { amount: number } }>();
    expect(doc?.status).toBe(OrderStatus.NOT_INITIATED);
    expect(doc?.pricing.amount).toBe(249.99);
  });
});
