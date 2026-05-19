import "server-only";

import { createHash } from "node:crypto";

import { type ClientSession, Types } from "mongoose";

import { sessionOpt } from "@/server/db/transaction";

import {
  AuditAction,
  AuditEntity,
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
import { resolveProvider } from "@/lib/constants/providers";
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
 *   3. Insert with the unique `{ orderId, sequence }` index — concurrent
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

  // Normalise the payload through a JSON round-trip BEFORE hashing.
  // This:
  //   - strips Mongoose subdoc parent-pointers / circular refs
  //   - serialises Date instances + ObjectIds via their toJSON
  //   - makes the persisted payload identical to what we hashed, so
  //     verifyChain can recompute deterministically on re-read
  const normalisedPayload = JSON.parse(
    JSON.stringify(input.payload),
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
        // Another concurrent writer took our sequence — re-read latest
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
  // and any failure aborts the operational write — that's the desired
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
      // Audit fallback already swallows — nothing else to do.
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
  const orderDoc = await Order.findById(orderId).lean<
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
  const provider = orderDoc.provider
    ? {
        id: orderDoc.provider.id,
        name: orderDoc.provider.name,
        logo: orderDoc.provider.logo,
        primaryColor: orderDoc.provider.primaryColor ?? undefined,
        onPrimaryColor: orderDoc.provider.onPrimaryColor ?? undefined,
      }
    : (() => {
        const fb = resolveProvider(undefined);
        return {
          id: fb.id,
          name: fb.name,
          logo: fb.logo,
          primaryColor: fb.primaryColor,
          onPrimaryColor: fb.onPrimaryColor,
        };
      })();

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
      provider,
      vehicle: {
        company: orderDoc.vehicle.company,
        type: orderDoc.vehicle.type,
        imageUrl: orderDoc.vehicle.imageUrl ?? null,
      },
      createdAt: orderDoc.createdAt.toISOString(),
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
  const doc = await OrderEvidence.findById(eventId).lean<
    OrderEvidenceDoc & { _id: Types.ObjectId }
  >();
  return doc ? evidenceToDTO(doc) : null;
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
