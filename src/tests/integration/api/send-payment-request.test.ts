import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OrderStatus, UserRole } from "@/lib/constants/enums";
import { POST as sendRoute } from "@/app/api/orders/[id]/send-payment-request/route";
import { POST as modifyRoute } from "@/app/api/orders/[id]/modify/route";
import { Order } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { mockNextHeaders } from "@/tests/utils/next-headers";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { seedTestOrganization } from "@/tests/utils/organization";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";
import { NextRequest } from "next/server";

/**
 * Route-boundary regressions from the operator QA pass.
 */

const { createOrder } = await import("@/server/services/order.service");

const admin = actorFor(UserRole.ADMIN);
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

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("POST /api/orders/[id]/send-payment-request", () => {
  it("a refused send does not rewrite the customer", async () => {
    const { order } = await createOrder(validCreateOrderInput(), {
      actor: admin,
      request: null,
    });
    await Order.updateOne(
      { _id: order.id },
      { $set: { status: OrderStatus.PAID, "payment.status": OrderStatus.PAID } },
    );

    const res = await sendRoute(
      buildRequest(`/api/orders/${order.id}/send-payment-request`, {
        method: "POST",
        body: {
          collection: "GATEWAY",
          customer: { name: "Someone Else", email: "someone@else.test" },
        },
      }),
      params(order.id) as never,
    );
    expect(res.status).toBe(409);

    const now = await Order.findById(order.id).lean<{
      customer: { name: string; email: string };
    }>();
    // Before the fix the patch ran first: the send was refused, but the
    // order's customer had already been replaced.
    expect(now!.customer.name).toBe(order.customer.name);
    expect(now!.customer.email).toBe(order.customer.email);
  });
});

describe("malformed request bodies", () => {
  it("returns 400, not 500, for a body that is not JSON", async () => {
    const { order } = await createOrder(validCreateOrderInput(), {
      actor: admin,
      request: null,
    });
    const req = new NextRequest(
      new URL(`/api/orders/${order.id}/modify`, "http://localhost"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      },
    );
    const res = await modifyRoute(req, params(order.id) as never);
    const { status, body } = await jsonBody(res);
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toMatch(/not valid JSON/);
  });
});
