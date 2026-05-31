import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AuditAction,
  AuditEntity,
  OrderEvidenceActorType,
  OrderEvidenceEventType,
  UserRole,
} from "@/lib/constants/enums";
import {
  Order,
  OrderEvidence,
  Organization,
  User,
} from "@/server/db/models";
import {
  getEvidenceEvent,
  recordEvidence,
} from "@/server/services/evidence.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * Cross-tenant isolation invariants for the previously-orphan models.
 *
 * These tests assert the security property the tenancy-hardening pass
 * was supposed to establish: holding a valid id for a row in Tenant
 * B's data MUST NOT let a Tenant A actor read it via the lookup-by-id
 * path. Every test creates two orgs + a row owned by org B, then
 * tries to read it as org A.
 *
 * Coverage today: OrderEvidence (most-exposed surface, has a
 * findById API used by the dispute evidence export page). Other
 * models follow the same pattern (orgId denormalised on write,
 * lookup-by-id pins both _id and orgId at read time).
 */

describe("tenancy isolation — OrderEvidence", () => {
  beforeEach(async () => {
    await ensureMongo();
  });
  afterEach(async () => {
    await resetDatabase();
  });

  async function persistOrgWithOrder(label: string): Promise<{
    orgId: string;
    orderId: string;
  }> {
    const ownerId = new Types.ObjectId();
    await User.create({
      _id: ownerId,
      name: `${label} owner`,
      email: `o-${ownerId.toString().slice(-8)}@x.test`,
      passwordHash: "x".repeat(60),
      role: UserRole.SUPER_ADMIN,
      status: "ACTIVE",
    });
    const org = await Organization.create({
      slug: `t-${ownerId.toString().slice(-8)}`,
      name: `${label} Org`,
      ownerUserId: ownerId,
      status: "ACTIVE",
    });
    const orderId = new Types.ObjectId();
    await Order.create({
      _id: orderId,
      orgId: org._id,
      orderNumber: `${label.toUpperCase()}-001`,
      status: "NOT_INITIATED",
      state: "ACTIVE",
      customer: { name: "C", email: "c@x.test", phone: "+1-555-0000" },
      lineItems: [],
      pricing: { amount: 100, currency: "USD" },
      payment: { status: "NOT_INITIATED", processedWebhookEventIds: [] },
      createdBy: {
        userId: ownerId,
        name: `${label} owner`,
        email: `o-${ownerId.toString().slice(-8)}@x.test`,
      },
      policy: { acceptedAt: new Date(), version: "v1", text: "" },
      risk: { flagged: false },
      consent: { status: "NOT_REQUESTED" },
    });
    return { orgId: String(org._id), orderId: String(orderId) };
  }

  it("recordEvidence denormalises the parent Order's orgId onto every new event", async () => {
    const { orgId, orderId } = await persistOrgWithOrder("alpha");
    await recordEvidence({
      orderId,
      orderNumber: "ALPHA-001",
      eventType: OrderEvidenceEventType.ORDER_CREATED,
      actor: { type: OrderEvidenceActorType.SYSTEM, name: "test" },
      payload: { kind: AuditAction.ORDER_CREATED, entity: AuditEntity.ORDER },
    });

    const docs = await OrderEvidence.find({
      orderId: new Types.ObjectId(orderId),
    }).lean<{ orgId?: Types.ObjectId }[]>();
    expect(docs).toHaveLength(1);
    expect(String(docs[0]!.orgId)).toBe(orgId);
  });

  it("getEvidenceEvent REFUSES to return a row belonging to a different tenant", async () => {
    // Tenant B owns the evidence row.
    const b = await persistOrgWithOrder("bravo");
    await recordEvidence({
      orderId: b.orderId,
      orderNumber: "BRAVO-001",
      eventType: OrderEvidenceEventType.ORDER_CREATED,
      actor: { type: OrderEvidenceActorType.SYSTEM, name: "test" },
      payload: { kind: AuditAction.ORDER_CREATED, entity: AuditEntity.ORDER },
    });
    const evidenceDoc = await OrderEvidence.findOne({
      orderId: new Types.ObjectId(b.orderId),
    }).lean<{ _id: Types.ObjectId }>();
    expect(evidenceDoc).toBeTruthy();

    // Tenant A actor with EVIDENCE_VIEW asks for that exact event id.
    const a = await persistOrgWithOrder("alpha");
    const attackerActor = {
      id: new Types.ObjectId().toString(),
      name: "Attacker",
      email: "a@x.test",
      role: UserRole.SUPER_ADMIN,
    };
    const result = await getEvidenceEvent(
      String(evidenceDoc!._id),
      { actor: attackerActor, orgId: a.orgId },
    );
    expect(result).toBeNull();
  });

  it("getEvidenceEvent returns the row for the owning tenant", async () => {
    const a = await persistOrgWithOrder("alpha");
    await recordEvidence({
      orderId: a.orderId,
      orderNumber: "ALPHA-001",
      eventType: OrderEvidenceEventType.ORDER_CREATED,
      actor: { type: OrderEvidenceActorType.SYSTEM, name: "test" },
      payload: { kind: AuditAction.ORDER_CREATED, entity: AuditEntity.ORDER },
    });
    const evidenceDoc = await OrderEvidence.findOne({
      orderId: new Types.ObjectId(a.orderId),
    }).lean<{ _id: Types.ObjectId }>();
    expect(evidenceDoc).toBeTruthy();

    const ownerActor = {
      id: new Types.ObjectId().toString(),
      name: "Owner",
      email: "owner@x.test",
      role: UserRole.SUPER_ADMIN,
    };
    const result = await getEvidenceEvent(
      String(evidenceDoc!._id),
      { actor: ownerActor, orgId: a.orgId },
    );
    expect(result).not.toBeNull();
    expect(result?.id).toBe(String(evidenceDoc!._id));
  });

  it("legacy rows without orgId fall back to a parent-Order check (still tenant-safe)", async () => {
    const a = await persistOrgWithOrder("alpha");
    // Simulate a pre-hardening row by bypassing the Mongoose model
    // (which is append-only and would refuse a no-orgId insert via
    // hooks). Goes straight to the collection driver.
    const legacyId = new Types.ObjectId();
    await OrderEvidence.collection.insertOne({
      _id: legacyId,
      orderId: new Types.ObjectId(a.orderId),
      orderNumber: "ALPHA-001",
      sequence: 1,
      eventType: OrderEvidenceEventType.ORDER_CREATED,
      occurredAt: new Date(),
      actor: { type: OrderEvidenceActorType.SYSTEM, name: "legacy" },
      payload: {},
      snapshotHash: "x".repeat(64),
      previousHash: null,
      hash: "x".repeat(64),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const legacyEvent = { _id: legacyId };

    // Owner tenant CAN read via parent-Order fallback.
    const ownerActor = {
      id: new Types.ObjectId().toString(),
      name: "Owner",
      email: "o@x.test",
      role: UserRole.SUPER_ADMIN,
    };
    const ownerRead = await getEvidenceEvent(String(legacyEvent._id), {
      actor: ownerActor,
      orgId: a.orgId,
    });
    expect(ownerRead).not.toBeNull();

    // Attacker tenant CANNOT.
    const b = await persistOrgWithOrder("bravo");
    const attackerActor = {
      id: new Types.ObjectId().toString(),
      name: "Attacker",
      email: "a@x.test",
      role: UserRole.SUPER_ADMIN,
    };
    const attackerRead = await getEvidenceEvent(String(legacyEvent._id), {
      actor: attackerActor,
      orgId: b.orgId,
    });
    expect(attackerRead).toBeNull();
  });
});
