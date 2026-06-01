import "server-only";

import { createHash } from "node:crypto";

import { type ClientSession, Types } from "mongoose";

import { sessionOpt } from "@/server/db/transaction";

import {
  AuditAction,
  AuditEntity,
  type ConsentMethod,
  OrderEvidenceActorType,
  type OrderEvidenceEventType,
  type UserRole,
} from "@/lib/constants/enums";
import { computeEvidenceHash } from "@/lib/crypto/hash-chain";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import { logger } from "@/lib/logger";
import {
  Order,
  OrderEvidence,
  type OrderEvidenceDoc,
  type OrderEvidenceRefs,
  type OrderDoc,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import type {
  OrderEvidenceChainDTO,
  OrderEvidenceEventDTO,
  OrderEvidenceSearchResultDTO,
  OrderEvidenceVerificationDTO,
} from "@/types";

import type { RequestContext } from "@/server/api/request-context";

import { recordAudit } from "./audit.service";

// Up to 12 concurrent writers can lose the race against the unique
// `{ orderId, sequence }` index before we surface a hard failure. In
// practice production rarely sees more than 1–2 concurrent writers per
// order (webhook + reconcile retry); the headroom is for in-test
// stress and rare admin storms.
const MAX_APPEND_RETRIES = 12;

export interface EvidenceActorInput {
  type: OrderEvidenceActorType;
  userId?: string | null;
  name?: string | null;
  email?: string | null;
  role?: UserRole | null;
}

export interface RecordEvidenceInput {
  orderId: string;
  orderNumber: string;
  eventType: OrderEvidenceEventType;
  /** Optional override for when the underlying real-world event happened
   *  (e.g. webhook timestamp). Defaults to now. */
  occurredAt?: Date;
  actor: EvidenceActorInput;
  request?: RequestContext | null;
  payload: Record<string, unknown>;
  refs?: Partial<OrderEvidenceRefs> | null;
}

/**
 * Append a single evidence event to an order's hash chain.
 *
 * The append protocol is:
 *   1. Look up the latest event for this order (by sequence desc).
 *   2. Compute snapshotHash and chained hash deterministically.
 *   3. Insert with the unique `{ orderId, sequence }` index, concurrent
 *      writers race on this index; the loser retries up to 3 times.
 *
 * Failures throw. Callers in the operational path MUST wrap this in a
 * try/catch and let primary operations succeed even if evidence write
 * fails (evidence is dispute-defense, not a transaction prerequisite).
 * `captureEvidenceSafe` does exactly that and is what hook sites use.
 */
export async function recordEvidence(
  input: RecordEvidenceInput,
  session: ClientSession | null = null,
): Promise<OrderEvidenceEventDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(input.orderId)) {
    throw new Error(`recordEvidence: invalid orderId ${input.orderId}`);
  }
  const orderObjectId = new Types.ObjectId(input.orderId);
  const occurredAt = input.occurredAt ?? new Date();

  // Resolve the parent Order's orgId so we can denormalise it onto
  // the evidence row. Single small projection; the lookup is cheap
  // and lets per-tenant evidence queries skip the JOIN.
  const orderLookupQuery = Order.findById(orderObjectId).select({ orgId: 1 });
  const parentOrder = await (session
    ? orderLookupQuery.session(session)
    : orderLookupQuery
  ).lean<{ orgId?: unknown }>();
  const evidenceOrgId =
    parentOrder?.orgId &&
    Types.ObjectId.isValid(String(parentOrder.orgId))
      ? new Types.ObjectId(String(parentOrder.orgId))
      : null;

  // Normalise the payload BEFORE hashing so the stored bytes and the
  // hashed bytes agree. Two steps:
  //   1. JSON round-trip, strips Mongoose subdoc parent-pointers
  //      / circular refs, serialises Dates + ObjectIds via toJSON.
  //   2. Strip empty objects / empty arrays, Mongoose's Schema.Types
  //      .Mixed silently drops empty subobjects when it persists, so
  //      a payload that hashes with `attributes: {}` would NOT match
  //      after Mongo round-trip (which yields no `attributes` key at
  //      all). Stripping them up-front means the hash matches what
  //      verifyChainFromDocs will recompute on re-read.
  const normalisedPayload = stripEmpty(
    JSON.parse(JSON.stringify(input.payload)),
  ) as Record<string, unknown>;

  for (let attempt = 1; attempt <= MAX_APPEND_RETRIES; attempt += 1) {
    const baseQuery = OrderEvidence.findOne({ orderId: orderObjectId })
      .sort({ sequence: -1 })
      .select({ sequence: 1, hash: 1 });
    const latest = await (session
      ? baseQuery.session(session)
      : baseQuery
    ).lean<Pick<OrderEvidenceDoc, "sequence" | "hash">>();

    const sequence = (latest?.sequence ?? 0) + 1;
    const previousHash = latest?.hash ?? null;
    const { snapshotHash, hash } = computeEvidenceHash({
      previousHash,
      orderId: input.orderId,
      sequence,
      eventType: input.eventType,
      occurredAt,
      payload: normalisedPayload,
    });

    try {
      const created = await OrderEvidence.create(
        [
          {
            orderId: orderObjectId,
            orgId: evidenceOrgId,
            orderNumber: input.orderNumber,
            sequence,
            eventType: input.eventType,
            occurredAt,
            actor: {
              type: input.actor.type,
              userId: input.actor.userId
                ? new Types.ObjectId(input.actor.userId)
                : null,
              name: input.actor.name ?? null,
              email: input.actor.email ?? null,
              role: input.actor.role ?? null,
            },
            request: input.request
              ? {
                  ip: input.request.ip ?? null,
                  userAgent: input.request.userAgent ?? null,
                  requestId: input.request.requestId ?? null,
                  geoCountry: null,
                }
              : null,
            payload: normalisedPayload,
            refs: normaliseRefs(input.refs),
            snapshotHash,
            previousHash,
            hash,
          },
        ],
        sessionOpt(session),
      );
      const doc = created[0];
      return evidenceToDTO(
        doc.toObject() as OrderEvidenceDoc & { _id: Types.ObjectId },
      );
    } catch (err) {
      if (isDuplicateKeyError(err) && attempt < MAX_APPEND_RETRIES) {
        // Another concurrent writer took our sequence, re-read latest
        // and try again. (Only meaningful for the non-tx path; a
        // serializable tx would have aborted earlier.)
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `recordEvidence: failed to append after ${MAX_APPEND_RETRIES} retries`,
  );
}

/**
 * Wrapper for capture hooks in operational services. Records evidence
 * out-of-band: never throws to the caller, logs failures, and emits an
 * EVIDENCE_RECORD_FAILED audit so the dispute team can spot gaps. This
 * is the function service-layer call sites use.
 */
export async function captureEvidenceSafe(
  input: RecordEvidenceInput,
  session: ClientSession | null = null,
): Promise<void> {
  // Transactional callers: the evidence write joins the caller's tx
  // and any failure aborts the operational write, that's the desired
  // contract for dispute-grade flows. Bubble the error.
  if (session) {
    await recordEvidence(input, session);
    return;
  }
  try {
    await recordEvidence(input, null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("evidence.record_failed", {
      orderId: input.orderId,
      eventType: input.eventType,
      err: message,
    });
    try {
      await recordAudit({
        action: AuditAction.EVIDENCE_RECORD_FAILED,
        entityType: AuditEntity.ORDER_EVIDENCE,
        entityId: input.orderId,
        actor: input.actor.userId
          ? {
              userId: input.actor.userId,
              name: input.actor.name ?? null,
              email: input.actor.email ?? null,
              role: input.actor.role ?? null,
            }
          : null,
        request: input.request ?? null,
        metadata: {
          eventType: input.eventType,
          orderNumber: input.orderNumber,
          error: message,
        },
      });
    } catch {
      // Audit fallback already swallows, nothing else to do.
    }
  }
}

function normaliseRefs(
  refs: Partial<OrderEvidenceRefs> | null | undefined,
): OrderEvidenceRefs | null {
  if (!refs) return null;
  const out: OrderEvidenceRefs = {
    paymentSessionId: refs.paymentSessionId ?? null,
    paymentIntentId: refs.paymentIntentId ?? null,
    transactionId: refs.transactionId ?? null,
    gatewayEventId: refs.gatewayEventId ?? null,
    consentId: refs.consentId ?? null,
    consentTokenHash: refs.consentTokenHash ?? null,
    customerEmail: refs.customerEmail
      ? refs.customerEmail.toLowerCase()
      : null,
    signatureName: refs.signatureName ?? null,
    messageId: refs.messageId ?? null,
  };
  const anyValue = Object.values(out).some((v) => v !== null);
  return anyValue ? out : null;
}

function isDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: number; name?: string };
  return e.code === 11000 || e.name === "MongoServerError";
}

export function hashConsentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/* ──────────────────────────── Read paths ──────────────────────────── */

interface EvidenceContext {
  actor: {
    id: string;
    name: string;
    email: string;
    role: UserRole;
  };
  /** Active organization. Threaded through Pass 5a, every Order
   *  lookup pins this to prevent a Tenant A admin from reading the
   *  evidence chain of a Tenant B order by guessing the id. */
  orgId?: string | null;
}

/**
 * Fetch the full evidence chain for an order, including verification
 * status. Requires EVIDENCE_VIEW.
 */
export async function getEvidenceChain(
  orderId: string,
  ctx: EvidenceContext,
): Promise<OrderEvidenceChainDTO> {
  if (!roleHasPermission(ctx.actor.role, Permission.EVIDENCE_VIEW)) {
    throw new ForbiddenError(
      "You do not have permission to view evidence chains",
    );
  }
  await connectMongo();
  if (!Types.ObjectId.isValid(orderId)) {
    throw new NotFoundError("Order not found");
  }
  const orderFilter: Record<string, unknown> = { _id: orderId };
  if (ctx.orgId) orderFilter.orgId = new Types.ObjectId(ctx.orgId);
  const orderDoc = await Order.findOne(orderFilter).lean<
    OrderDoc & { _id: Types.ObjectId }
  >();
  if (!orderDoc) throw new NotFoundError("Order not found");

  const docs = await OrderEvidence.find({
    orderId: new Types.ObjectId(orderId),
  })
    .sort({ sequence: 1 })
    .lean<(OrderEvidenceDoc & { _id: Types.ObjectId })[]>();

  const events = docs.map(evidenceToDTO);
  const verification = verifyChainFromDocs(docs, orderId);

  return {
    events,
    verification,
    order: {
      id: String(orderDoc._id),
      orderNumber: orderDoc.orderNumber,
      customer: { ...orderDoc.customer },
      pricing: {
        amount: orderDoc.pricing.amount,
        currency: orderDoc.pricing.currency,
      },
      status: orderDoc.status,
      state: orderDoc.state,
      lineItems: (orderDoc.lineItems ?? []).map((li) => ({
        itemId: li.itemId ? String(li.itemId) : null,
        itemTypeKey: li.itemTypeKey,
        name: li.name,
        description: li.description ?? null,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        total: li.total,
        attributes: li.attributes ?? {},
        scheduling: li.scheduling
          ? {
              type: li.scheduling.type,
              startsAt: li.scheduling.startsAt.toISOString(),
              endsAt: li.scheduling.endsAt
                ? li.scheduling.endsAt.toISOString()
                : null,
            }
          : null,
      })),
      scheduling: orderDoc.scheduling
        ? {
            type: orderDoc.scheduling.type,
            startsAt: orderDoc.scheduling.startsAt.toISOString(),
            endsAt: orderDoc.scheduling.endsAt
              ? orderDoc.scheduling.endsAt.toISOString()
              : null,
          }
        : null,
      createdAt: orderDoc.createdAt.toISOString(),
      // Pointers the case-file outcome panel reads to decide its
      // variant (READY / OPEN / WON / LOST). All three already live
      // on the Order doc; we just thread them through the DTO.
      payment: {
        gateway: orderDoc.payment.gateway ?? null,
        paymentIntentId: orderDoc.payment.paymentIntentId ?? null,
        paidAt: orderDoc.payment.paidAt
          ? orderDoc.payment.paidAt.toISOString()
          : null,
        receiptUrl: orderDoc.payment.receiptUrl ?? null,
      },
      consent: {
        status: orderDoc.consent.status,
        currentConsentId: orderDoc.consent.currentConsentId
          ? String(orderDoc.consent.currentConsentId)
          : null,
        requestedAt: orderDoc.consent.requestedAt
          ? orderDoc.consent.requestedAt.toISOString()
          : null,
        receivedAt: orderDoc.consent.receivedAt
          ? orderDoc.consent.receivedAt.toISOString()
          : null,
        verifiedAt: orderDoc.consent.verifiedAt
          ? orderDoc.consent.verifiedAt.toISOString()
          : null,
        method: (orderDoc.consent.method as ConsentMethod | null) ?? null,
      },
      dispute: orderDoc.dispute
        ? {
            status: orderDoc.dispute.status ?? null,
            currentDisputeId: orderDoc.dispute.currentDisputeId
              ? String(orderDoc.dispute.currentDisputeId)
              : null,
            openedAt: orderDoc.dispute.openedAt
              ? orderDoc.dispute.openedAt.toISOString()
              : null,
            closedAt: orderDoc.dispute.closedAt
              ? orderDoc.dispute.closedAt.toISOString()
              : null,
            outcome: orderDoc.dispute.outcome ?? null,
            reason: orderDoc.dispute.reason ?? null,
            amount: orderDoc.dispute.amount ?? null,
            currency: orderDoc.dispute.currency ?? null,
          }
        : null,
    },
  };
}

/**
 * Look up a single evidence event by id. Used by the email-snapshot
 * route. Requires EVIDENCE_VIEW.
 */
export async function getEvidenceEvent(
  eventId: string,
  ctx: EvidenceContext,
): Promise<OrderEvidenceEventDTO | null> {
  if (!roleHasPermission(ctx.actor.role, Permission.EVIDENCE_VIEW)) {
    throw new ForbiddenError(
      "You do not have permission to view evidence events",
    );
  }
  await connectMongo();
  if (!Types.ObjectId.isValid(eventId)) return null;
  // Pin BOTH _id AND orgId so a Tenant-A admin guessing an event id
  // from Tenant B gets a clean "not found" instead of a real event.
  // Backfilled rows without orgId fall back to a parent-Order check
  // (verifyOrgViaParent) so we don't regress on legacy data.
  const filter: Record<string, unknown> = { _id: eventId };
  if (ctx.orgId) filter.orgId = new Types.ObjectId(ctx.orgId);
  const doc = await OrderEvidence.findOne(filter).lean<
    OrderEvidenceDoc & { _id: Types.ObjectId }
  >();
  if (doc) return evidenceToDTO(doc);
  // Fallback for not-yet-backfilled legacy rows: an evidence row
  // without orgId is reachable only if its parent Order belongs to
  // ctx.orgId. One extra read on the cold-data path.
  if (ctx.orgId) {
    const legacy = await OrderEvidence.findOne({
      _id: eventId,
      orgId: { $exists: false },
    }).lean<OrderEvidenceDoc & { _id: Types.ObjectId }>();
    if (legacy) {
      const parent = await Order.findById(legacy.orderId)
        .select({ orgId: 1 })
        .lean<{ orgId?: unknown }>();
      if (parent?.orgId && String(parent.orgId) === ctx.orgId) {
        return evidenceToDTO(legacy);
      }
    }
  }
  return null;
}

/**
 * Recompute every event's hash and verify the chain links match.
 * Returns the index where the chain breaks if any.
 */
export function verifyChainFromDocs(
  docs: (OrderEvidenceDoc & { _id: Types.ObjectId })[],
  orderId: string,
): OrderEvidenceVerificationDTO {
  if (docs.length === 0) {
    return {
      valid: true,
      eventCount: 0,
      brokenAtSequence: null,
      reason: null,
      headHash: null,
    };
  }
  let priorHash: string | null = null;
  for (let i = 0; i < docs.length; i += 1) {
    const e = docs[i];
    if (e.sequence !== i + 1) {
      return {
        valid: false,
        eventCount: docs.length,
        brokenAtSequence: e.sequence,
        reason: "sequence_gap",
        headHash: null,
      };
    }
    if (e.previousHash !== priorHash) {
      return {
        valid: false,
        eventCount: docs.length,
        brokenAtSequence: e.sequence,
        reason: "previous_hash_mismatch",
        headHash: null,
      };
    }
    const { snapshotHash, hash } = computeEvidenceHash({
      previousHash: priorHash,
      orderId,
      sequence: e.sequence,
      eventType: e.eventType,
      occurredAt: e.occurredAt,
      payload: e.payload,
    });
    if (snapshotHash !== e.snapshotHash) {
      return {
        valid: false,
        eventCount: docs.length,
        brokenAtSequence: e.sequence,
        reason: "payload_tampered",
        headHash: null,
      };
    }
    if (hash !== e.hash) {
      return {
        valid: false,
        eventCount: docs.length,
        brokenAtSequence: e.sequence,
        reason: "hash_mismatch",
        headHash: null,
      };
    }
    priorHash = e.hash;
  }
  return {
    valid: true,
    eventCount: docs.length,
    brokenAtSequence: null,
    reason: null,
    headHash: priorHash,
  };
}

/**
 * Cross-order search. Used by the admin disputes page to find a chain
 * starting from any one of the indexed reference fields the dispute
 * letter might quote (customer email, transaction id, session id,
 * gateway event id, consent token, signature name, message id).
 */
export interface EvidenceSearchQuery {
  q: string;
  field?:
    | "auto"
    | "customerEmail"
    | "paymentSessionId"
    | "paymentIntentId"
    | "transactionId"
    | "gatewayEventId"
    | "consentTokenHash"
    | "signatureName"
    | "messageId"
    | "orderNumber";
  limit?: number;
}

export async function searchEvidence(
  query: EvidenceSearchQuery,
  ctx: EvidenceContext,
): Promise<OrderEvidenceSearchResultDTO[]> {
  if (!roleHasPermission(ctx.actor.role, Permission.EVIDENCE_VIEW)) {
    throw new ForbiddenError(
      "You do not have permission to search evidence",
    );
  }
  await connectMongo();
  const limit = Math.min(50, Math.max(1, query.limit ?? 20));
  const q = query.q.trim();
  if (!q) return [];
  const field = query.field ?? "auto";

  const conditions: Record<string, unknown>[] = [];
  if (field === "orderNumber" || field === "auto") {
    conditions.push({ orderNumber: q });
  }
  if (field === "customerEmail" || field === "auto") {
    conditions.push({ "refs.customerEmail": q.toLowerCase() });
  }
  if (field === "paymentSessionId" || field === "auto") {
    conditions.push({ "refs.paymentSessionId": q });
  }
  if (field === "paymentIntentId" || field === "auto") {
    conditions.push({ "refs.paymentIntentId": q });
  }
  if (field === "transactionId" || field === "auto") {
    conditions.push({ "refs.transactionId": q });
  }
  if (field === "gatewayEventId" || field === "auto") {
    conditions.push({ "refs.gatewayEventId": q });
  }
  if (field === "consentTokenHash" || field === "auto") {
    // Either the caller passed an already-hashed value (paste from
    // another evidence doc), or a raw consent token they want us to
    // hash. Try both.
    conditions.push({ "refs.consentTokenHash": q });
    conditions.push({ "refs.consentTokenHash": hashConsentToken(q) });
  }
  if (field === "signatureName" || field === "auto") {
    conditions.push({ "refs.signatureName": q });
  }
  if (field === "messageId" || field === "auto") {
    conditions.push({ "refs.messageId": q });
  }

  const docs = await OrderEvidence.find({ $or: conditions })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<(OrderEvidenceDoc & { _id: Types.ObjectId })[]>();

  return docs.map((d) => ({
    orderId: String(d.orderId),
    orderNumber: d.orderNumber,
    customerEmail: d.refs?.customerEmail ?? null,
    eventType: d.eventType,
    matchedField: detectMatchedField(d.refs ?? null, q),
    matchedValue: q,
    occurredAt: d.occurredAt.toISOString(),
    eventId: String(d._id),
  }));
}

function detectMatchedField(
  refs: OrderEvidenceRefs | null,
  q: string,
): string {
  if (!refs) return "orderNumber";
  const lc = q.toLowerCase();
  if (refs.customerEmail === lc) return "customerEmail";
  if (refs.paymentSessionId === q) return "paymentSessionId";
  if (refs.paymentIntentId === q) return "paymentIntentId";
  if (refs.transactionId === q) return "transactionId";
  if (refs.gatewayEventId === q) return "gatewayEventId";
  if (refs.consentTokenHash === q) return "consentTokenHash";
  if (refs.consentTokenHash === hashConsentToken(q)) return "consentTokenHash";
  if (refs.signatureName === q) return "signatureName";
  if (refs.messageId === q) return "messageId";
  return "orderNumber";
}

/**
 * Lightweight summary used by the order detail card. Avoids streaming
 * the full chain into the client when all the card needs is integrity +
 * event count + last event type.
 */
export interface EvidenceChainSummaryDTO {
  eventCount: number;
  lastEventType: OrderEvidenceEventType | null;
  lastEventAt: string | null;
  verification: OrderEvidenceVerificationDTO;
}

export async function getEvidenceChainSummary(
  orderId: string,
  ctx: EvidenceContext,
): Promise<EvidenceChainSummaryDTO> {
  if (!roleHasPermission(ctx.actor.role, Permission.EVIDENCE_VIEW)) {
    throw new ForbiddenError(
      "You do not have permission to view evidence chain",
    );
  }
  await connectMongo();
  if (!Types.ObjectId.isValid(orderId)) {
    return {
      eventCount: 0,
      lastEventType: null,
      lastEventAt: null,
      verification: {
        valid: true,
        eventCount: 0,
        brokenAtSequence: null,
        reason: null,
        headHash: null,
      },
    };
  }
  // Pass 5a tenant gate: verify the orderId belongs to the actor's
  // org BEFORE we surface its evidence-chain summary. OrderEvidence
  // doesn't carry orgId on its own schema (yet), we trust the
  // transitive scope via the order it points at. Returns the empty
  // summary on a miss rather than throwing, matching the existing
  // behaviour for invalid ObjectIds above.
  if (ctx.orgId) {
    const owner = await Order.findOne({
      _id: new Types.ObjectId(orderId),
      orgId: new Types.ObjectId(ctx.orgId),
    })
      .select({ _id: 1 })
      .lean<{ _id: unknown } | null>();
    if (!owner) {
      return {
        eventCount: 0,
        lastEventType: null,
        lastEventAt: null,
        verification: {
          valid: true,
          eventCount: 0,
          brokenAtSequence: null,
          reason: null,
          headHash: null,
        },
      };
    }
  }
  const docs = await OrderEvidence.find({
    orderId: new Types.ObjectId(orderId),
  })
    .sort({ sequence: 1 })
    .lean<(OrderEvidenceDoc & { _id: Types.ObjectId })[]>();
  const verification = verifyChainFromDocs(docs, orderId);
  const last = docs[docs.length - 1] ?? null;
  return {
    eventCount: docs.length,
    lastEventType: last?.eventType ?? null,
    lastEventAt: last?.occurredAt.toISOString() ?? null,
    verification,
  };
}

/* ──────────────────────────── DTO helper ──────────────────────────── */

function evidenceToDTO(
  doc: OrderEvidenceDoc & { _id: Types.ObjectId },
): OrderEvidenceEventDTO {
  return {
    id: String(doc._id),
    orderId: String(doc.orderId),
    orderNumber: doc.orderNumber,
    sequence: doc.sequence,
    eventType: doc.eventType,
    occurredAt: doc.occurredAt.toISOString(),
    actor: {
      type: doc.actor.type,
      userId: doc.actor.userId ? String(doc.actor.userId) : null,
      name: doc.actor.name ?? null,
      email: doc.actor.email ?? null,
      role: doc.actor.role ?? null,
    },
    request: doc.request
      ? {
          ip: doc.request.ip ?? null,
          userAgent: doc.request.userAgent ?? null,
          requestId: doc.request.requestId ?? null,
          geoCountry: doc.request.geoCountry ?? null,
        }
      : null,
    payload: (doc.payload ?? {}) as Record<string, unknown>,
    refs: doc.refs
      ? {
          paymentSessionId: doc.refs.paymentSessionId ?? null,
          paymentIntentId: doc.refs.paymentIntentId ?? null,
          transactionId: doc.refs.transactionId ?? null,
          gatewayEventId: doc.refs.gatewayEventId ?? null,
          consentId: doc.refs.consentId ?? null,
          consentTokenHash: doc.refs.consentTokenHash ?? null,
          customerEmail: doc.refs.customerEmail ?? null,
          signatureName: doc.refs.signatureName ?? null,
          messageId: doc.refs.messageId ?? null,
        }
      : null,
    snapshotHash: doc.snapshotHash,
    previousHash: doc.previousHash,
    hash: doc.hash,
    createdAt: (doc.createdAt ?? new Date()).toISOString(),
  };
}

/**
 * Strip empty objects + empty arrays from a JSON-safe value. Mongoose's
 * Schema.Types.Mixed silently drops empty subobjects on persist; the
 * evidence-chain hash must match what's actually stored, so we strip
 * them up-front. Applied to the normalised payload before hashing in
 * `recordEvidence`.
 */
function stripEmpty(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripEmpty);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const stripped = stripEmpty(v);
      // Drop empty objects entirely. Empty arrays + primitives stay.
      if (
        stripped !== null &&
        typeof stripped === "object" &&
        !Array.isArray(stripped) &&
        Object.keys(stripped as Record<string, unknown>).length === 0
      ) {
        continue;
      }
      out[k] = stripped;
    }
    return out;
  }
  return value;
}
