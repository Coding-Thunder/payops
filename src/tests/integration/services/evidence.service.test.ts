import { Types } from "mongoose";
import { beforeEach, describe, expect, it } from "vitest";

import {
  OrderEvidenceActorType,
  OrderEvidenceEventType,
  UserRole,
} from "@/lib/constants/enums";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { OrderEvidence } from "@/server/db/models";
import {
  captureEvidenceSafe,
  getEvidenceChain,
  getEvidenceChainSummary,
  hashConsentToken,
  recordEvidence,
  searchEvidence,
  verifyChainFromDocs,
} from "@/server/services/evidence.service";
import { actorFor } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { createOrder as factoryCreateOrder } from "@/tests/factories/order.factory";

/**
 * Evidence service — the dispute-defense backbone. Tests cover the
 * append protocol, the hash-chain integrity guarantees, and the
 * cross-order search.
 */

beforeEach(async () => {
  await ensureMongo();
});

async function makeOrder() {
  return factoryCreateOrder();
}

describe("recordEvidence", () => {
  it("appends the genesis event with previousHash null and sequence 1", async () => {
    const order = await makeOrder();
    const event = await recordEvidence({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      eventType: OrderEvidenceEventType.ORDER_CREATED,
      actor: {
        type: OrderEvidenceActorType.AGENT,
        userId: new Types.ObjectId().toString(),
        name: "Agent",
        role: UserRole.ADMIN,
      },
      payload: { hello: "world" },
    });
    expect(event.sequence).toBe(1);
    expect(event.previousHash).toBeNull();
    expect(event.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(event.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(event.orderId).toBe(String(order._id));
  });

  it("chains the next event's previousHash to the prior event's hash", async () => {
    const order = await makeOrder();
    const a = await recordEvidence({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      eventType: OrderEvidenceEventType.ORDER_CREATED,
      actor: { type: OrderEvidenceActorType.AGENT },
      payload: { kind: "create" },
    });
    const b = await recordEvidence({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      eventType: OrderEvidenceEventType.PAYMENT_LINK_GENERATED,
      actor: { type: OrderEvidenceActorType.AGENT },
      payload: { kind: "link" },
    });
    expect(b.sequence).toBe(2);
    expect(b.previousHash).toBe(a.hash);
  });

  it("produces a strictly monotonic sequence under concurrent appends", async () => {
    // Force the unique `{ orderId, sequence }` index to be built before
    // we race writes — mongoose's autoIndex is async and the first
    // batch of inserts can otherwise outrun it.
    await OrderEvidence.syncIndexes();
    const order = await makeOrder();
    const events = await Promise.all(
      Array.from({ length: 5 }).map((_, i) =>
        recordEvidence({
          orderId: String(order._id),
          orderNumber: order.orderNumber,
          eventType: OrderEvidenceEventType.PAYMENT_LINK_GENERATED,
          actor: { type: OrderEvidenceActorType.SYSTEM, name: `parallel-${i}` },
          payload: { index: i },
        }),
      ),
    );
    const sequences = events.map((e) => e.sequence).sort((x, y) => x - y);
    expect(sequences).toEqual([1, 2, 3, 4, 5]);
    // And the chain still verifies — each event's previousHash matches
    // its predecessor's hash.
    const docs = await OrderEvidence.find({ orderId: order._id })
      .sort({ sequence: 1 })
      .lean();
    const v = verifyChainFromDocs(
      docs as Parameters<typeof verifyChainFromDocs>[0],
      String(order._id),
    );
    expect(v.valid).toBe(true);
    expect(v.eventCount).toBe(5);
  });

  it("rejects in-place updates (append-only model)", async () => {
    const order = await makeOrder();
    await recordEvidence({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      eventType: OrderEvidenceEventType.ORDER_CREATED,
      actor: { type: OrderEvidenceActorType.AGENT },
      payload: { hi: "there" },
    });
    const doc = await OrderEvidence.findOne({ orderId: order._id });
    expect(doc).not.toBeNull();
    if (!doc) throw new Error("doc not found");
    doc.payload = { tampered: true };
    await expect(doc.save()).rejects.toThrow(/append-only/);
  });
});

describe("captureEvidenceSafe", () => {
  it("swallows errors and never throws to the caller", async () => {
    // Pass an invalid orderId — recordEvidence would throw — and verify
    // captureEvidenceSafe returns void without surfacing the error.
    await expect(
      captureEvidenceSafe({
        orderId: "not-a-valid-objectid",
        orderNumber: "X-1",
        eventType: OrderEvidenceEventType.ORDER_CREATED,
        actor: { type: OrderEvidenceActorType.SYSTEM, name: "test" },
        payload: {},
      }),
    ).resolves.toBeUndefined();
  });
});

describe("verifyChainFromDocs", () => {
  it("flags an in-place payload edit as payload_tampered", async () => {
    const order = await makeOrder();
    await recordEvidence({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      eventType: OrderEvidenceEventType.ORDER_CREATED,
      actor: { type: OrderEvidenceActorType.AGENT },
      payload: { original: true },
    });
    // Bypass the append-only guard with a raw mongo update — exactly
    // what a malicious DB admin would do.
    await OrderEvidence.collection.updateOne(
      { orderId: order._id },
      { $set: { payload: { tampered: true } } },
    );
    const docs = await OrderEvidence.find({ orderId: order._id })
      .sort({ sequence: 1 })
      .lean();
    const v = verifyChainFromDocs(
      docs as Parameters<typeof verifyChainFromDocs>[0],
      String(order._id),
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toBe("payload_tampered");
    expect(v.brokenAtSequence).toBe(1);
  });

  it("flags a previousHash mutation as previous_hash_mismatch", async () => {
    const order = await makeOrder();
    const a = await recordEvidence({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      eventType: OrderEvidenceEventType.ORDER_CREATED,
      actor: { type: OrderEvidenceActorType.AGENT },
      payload: { i: 1 },
    });
    await recordEvidence({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      eventType: OrderEvidenceEventType.PAYMENT_LINK_GENERATED,
      actor: { type: OrderEvidenceActorType.AGENT },
      payload: { i: 2 },
    });
    void a;
    await OrderEvidence.collection.updateOne(
      { orderId: order._id, sequence: 2 },
      { $set: { previousHash: "0".repeat(64) } },
    );
    const docs = await OrderEvidence.find({ orderId: order._id })
      .sort({ sequence: 1 })
      .lean();
    const v = verifyChainFromDocs(
      docs as Parameters<typeof verifyChainFromDocs>[0],
      String(order._id),
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toBe("previous_hash_mismatch");
    expect(v.brokenAtSequence).toBe(2);
  });

  it("returns valid + headHash for a clean chain", async () => {
    const order = await makeOrder();
    const a = await recordEvidence({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      eventType: OrderEvidenceEventType.ORDER_CREATED,
      actor: { type: OrderEvidenceActorType.AGENT },
      payload: { i: 1 },
    });
    const b = await recordEvidence({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      eventType: OrderEvidenceEventType.PAYMENT_LINK_GENERATED,
      actor: { type: OrderEvidenceActorType.AGENT },
      payload: { i: 2 },
    });
    const docs = await OrderEvidence.find({ orderId: order._id })
      .sort({ sequence: 1 })
      .lean();
    const v = verifyChainFromDocs(
      docs as Parameters<typeof verifyChainFromDocs>[0],
      String(order._id),
    );
    expect(v.valid).toBe(true);
    expect(v.eventCount).toBe(2);
    expect(v.headHash).toBe(b.hash);
    void a;
  });
});

describe("getEvidenceChain", () => {
  it("returns chain + verification for an admin", async () => {
    const order = await makeOrder();
    await recordEvidence({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      eventType: OrderEvidenceEventType.ORDER_CREATED,
      actor: { type: OrderEvidenceActorType.AGENT, name: "Admin" },
      payload: { hi: "there" },
    });
    const chain = await getEvidenceChain(String(order._id), {
      actor: actorFor(UserRole.ADMIN),
    });
    expect(chain.events).toHaveLength(1);
    expect(chain.verification.valid).toBe(true);
    expect(chain.order.orderNumber).toBe(order.orderNumber);
  });

  it("forbids staff", async () => {
    const order = await makeOrder();
    await expect(
      getEvidenceChain(String(order._id), {
        actor: actorFor(UserRole.STAFF),
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("404s on unknown order", async () => {
    await expect(
      getEvidenceChain(new Types.ObjectId().toString(), {
        actor: actorFor(UserRole.ADMIN),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("getEvidenceChainSummary", () => {
  it("returns 0 events for a fresh order and a valid (empty) chain", async () => {
    const order = await makeOrder();
    const s = await getEvidenceChainSummary(String(order._id), {
      actor: actorFor(UserRole.ADMIN),
    });
    expect(s.eventCount).toBe(0);
    expect(s.verification.valid).toBe(true);
    expect(s.lastEventType).toBeNull();
  });
});

describe("searchEvidence", () => {
  it("finds an order by customer email and by session id", async () => {
    const order = await makeOrder();
    await recordEvidence({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      eventType: OrderEvidenceEventType.PAYMENT_LINK_GENERATED,
      actor: { type: OrderEvidenceActorType.AGENT },
      payload: { i: 1 },
      refs: {
        customerEmail: "hit@example.com",
        paymentSessionId: "cs_test_match",
      },
    });
    const byEmail = await searchEvidence(
      { q: "hit@example.com" },
      { actor: actorFor(UserRole.ADMIN) },
    );
    expect(byEmail.length).toBeGreaterThanOrEqual(1);
    expect(byEmail[0].orderId).toBe(String(order._id));

    const bySession = await searchEvidence(
      { q: "cs_test_match" },
      { actor: actorFor(UserRole.ADMIN) },
    );
    expect(bySession.length).toBeGreaterThanOrEqual(1);
    expect(bySession[0].matchedField).toBe("paymentSessionId");
  });

  it("hashes a raw consent token before lookup", async () => {
    const order = await makeOrder();
    const rawToken = "tok-secret-xyz";
    await recordEvidence({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      eventType: OrderEvidenceEventType.CONSENT_RECEIVED,
      actor: { type: OrderEvidenceActorType.CUSTOMER, name: "Customer" },
      payload: { signedName: "Customer" },
      refs: {
        consentTokenHash: hashConsentToken(rawToken),
        customerEmail: "customer@example.com",
      },
    });
    const results = await searchEvidence(
      { q: rawToken },
      { actor: actorFor(UserRole.ADMIN) },
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].matchedField).toBe("consentTokenHash");
  });

  it("forbids staff", async () => {
    await expect(
      searchEvidence({ q: "x" }, { actor: actorFor(UserRole.STAFF) }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
