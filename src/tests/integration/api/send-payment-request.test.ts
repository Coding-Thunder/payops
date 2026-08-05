import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OrderStatus, UserRole } from "@/lib/constants/enums";
import { POST as sendRoute } from "@/app/api/orders/[id]/send-payment-request/route";
import { IdempotencyKey, Order } from "@/server/db/models";
import { sendPaymentRequestEmail } from "@/server/services/email.service";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { mockNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";
import { buildOrder } from "@/tests/factories/order.factory";

// Stub the actual email dispatch — this test covers the ROUTE (state guards +
// idempotency + status transition), not delivery (that's the failure-contract
// suite). The stub also lets us count how many times a send fired.
vi.mock("@/server/services/email.service", async (importActual) => {
  const actual =
    await importActual<typeof import("@/server/services/email.service")>();
  return {
    ...actual,
    sendPaymentRequestEmail: vi
      .fn()
      .mockResolvedValue({ id: "msg_1", consentToken: "tok_1" }),
  };
});
const mockSend = vi.mocked(sendPaymentRequestEmail);

let headers: Awaited<ReturnType<typeof mockNextHeaders>>;
let session: Awaited<ReturnType<typeof mockSession>> | null = null;

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
  // Dedup relies on the unique `key` index (11000 collision). autoIndex timing
  // is unreliable in the harness, so build it explicitly — this is exactly the
  // prod index that must exist for send-dedup to work.
  await IdempotencyKey.syncIndexes();
  mockSend.mockReset();
  mockSend.mockResolvedValue({ id: "msg_1", consentToken: "tok_1" });
  headers = await mockNextHeaders();
});
afterEach(async () => {
  await headers.restore();
  if (session) {
    session.restore();
    session = null;
  }
});

async function seedOrder(orgId: string, actorId: string, status: OrderStatus) {
  // The route's guards key off `status`, and the send is mocked, so the
  // factory's default payment (status mirrors the order) is enough.
  const doc = buildOrder({ status, createdBy: { userId: actorId } });
  return Order.create({ ...doc, orgId: new Types.ObjectId(orgId) });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function post(id: string, key?: string) {
  return sendRoute(
    buildRequest(`/api/orders/${id}/send-payment-request`, {
      method: "POST",
      body: {},
      headers: key ? { "Idempotency-Key": key } : {},
    }),
    params(id),
  );
}

describe("POST /api/orders/[id]/send-payment-request", () => {
  it("409s when the order has no payment link yet (NOT_INITIATED)", async () => {
    const actor = actorFor(UserRole.SUPER_ADMIN);
    session = await mockSession(actor);
    const order = await seedOrder(actor.orgId!, actor.id, OrderStatus.NOT_INITIATED);

    const { status, body } = await jsonBody(await post(String(order._id)));
    expect(status).toBe(409);
    expect((body as { error: { code: string } }).error.code).toBe("CONFLICT");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("409s when the order is already PAID", async () => {
    const actor = actorFor(UserRole.SUPER_ADMIN);
    session = await mockSession(actor);
    const order = await seedOrder(actor.orgId!, actor.id, OrderStatus.PAID);

    const { status } = await jsonBody(await post(String(order._id)));
    expect(status).toBe(409);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends and flips LINK_GENERATED → PAYMENT_PENDING", async () => {
    const actor = actorFor(UserRole.SUPER_ADMIN);
    session = await mockSession(actor);
    const order = await seedOrder(
      actor.orgId!,
      actor.id,
      OrderStatus.LINK_GENERATED,
    );

    const { status, body } = await jsonBody<{
      data: { sent: { messageId: string | null; deduplicated: boolean } };
    }>(await post(String(order._id), "key-send-1"));

    expect(status).toBe(200);
    expect(body.data.sent.messageId).toBe("msg_1");
    expect(body.data.sent.deduplicated).toBe(false);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const fresh = await Order.findById(order._id);
    expect(fresh?.status).toBe(OrderStatus.PAYMENT_PENDING);
  });

  it("dedups a repeat with the same Idempotency-Key — email fires once", async () => {
    const actor = actorFor(UserRole.SUPER_ADMIN);
    session = await mockSession(actor);
    const order = await seedOrder(
      actor.orgId!,
      actor.id,
      OrderStatus.LINK_GENERATED,
    );

    const first = await jsonBody<{
      data: { sent: { deduplicated: boolean } };
    }>(await post(String(order._id), "dedup-key-01"));
    const second = await jsonBody<{
      data: { sent: { deduplicated: boolean } };
    }>(await post(String(order._id), "dedup-key-01"));

    expect(first.body.data.sent.deduplicated).toBe(false);
    expect(second.body.data.sent.deduplicated).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1); // NOT re-sent
  });
});
