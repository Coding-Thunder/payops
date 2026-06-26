import "server-only";

import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  type BookingType,
  ConsentMethod,
  ConsentStatus,
  type Currency,
  OrderEvidenceActorType,
  OrderEvidenceEventType,
  type UserRole,
} from "@/lib/constants/enums";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import { DomainEventType } from "@/lib/constants/events";
import { publishEvent } from "@/server/events/bus";
import { Order, PaymentConsent } from "@/server/db/models";
import type { PaymentConsentDoc } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import type {
  PaymentConsentDTO,
  PaymentConsentSnapshot,
  PublicConsentView,
} from "@/types";

import type { RequestContext } from "@/server/api/request-context";

import { recordAudit } from "./audit.service";
import {
  captureEvidenceSafe,
  hashConsentToken,
} from "./evidence.service";
import {
  buildConsentUrl,
  generateConsentToken,
  parseConsentToken,
} from "./consent-token";

interface ConsentActor {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

function consentToDTO(doc: PaymentConsentDoc & { _id: Types.ObjectId | string }): PaymentConsentDTO {
  return {
    id: String(doc._id),
    orderId: String(doc.orderId),
    orderNumber: doc.orderNumber,
    status: doc.status as ConsentStatus,
    method: (doc.method as ConsentMethod | null | undefined) ?? null,
    customerEmail: doc.customerEmail,
    customerName: doc.customerName,
    consentMessage: doc.consentMessage,
    consentEmailSubject: doc.consentEmailSubject ?? null,
    signedName: doc.signedName ?? null,
    snapshot: {
      bookingType: doc.snapshot.bookingType as BookingType,
      provider: doc.snapshot.provider,
      vehicle: doc.snapshot.vehicle,
      pickupDate: doc.snapshot.pickupDate.toISOString(),
      dropoffDate: doc.snapshot.dropoffDate.toISOString(),
      pickupLocation: doc.snapshot.pickupLocation ?? null,
      dropoffLocation: doc.snapshot.dropoffLocation ?? null,
      amount: doc.snapshot.amount,
      currency: doc.snapshot.currency as Currency,
      charges: (doc.snapshot.charges ?? []).map((c) => ({
        name: c.name,
        amount: c.amount,
        timing: c.timing,
      })),
      dueAtCounter: doc.snapshot.dueAtCounter ?? 0,
      total: doc.snapshot.total ?? doc.snapshot.amount,
      paymentLinkRef: doc.snapshot.paymentLinkRef ?? null,
    },
    requestedAt: doc.requestedAt.toISOString(),
    receivedAt: doc.receivedAt ? doc.receivedAt.toISOString() : null,
    verifiedAt: doc.verifiedAt ? doc.verifiedAt.toISOString() : null,
    verifiedBy: doc.verifiedBy
      ? {
          userId: doc.verifiedBy.userId ? String(doc.verifiedBy.userId) : null,
          name: doc.verifiedBy.name ?? null,
        }
      : null,
    receiptIp: doc.receiptIp ?? null,
    receiptUserAgent: doc.receiptUserAgent ?? null,
    metadata: (doc.metadata as Record<string, unknown> | null | undefined) ?? null,
    createdAt: (doc.createdAt ?? new Date()).toISOString(),
    updatedAt: (doc.updatedAt ?? new Date()).toISOString(),
  };
}

export interface RequestConsentInput {
  orderId: string;
  customerEmail: string;
  customerName: string;
  consentMessage: string;
  consentEmailSubject: string | null;
  snapshot: PaymentConsentSnapshot;
}

export interface RequestConsentResult {
  consent: PaymentConsentDTO;
  token: string;
  consentUrl: string;
}

/**
 * Creates (or revives) a REQUESTED consent record against an order.
 *
 * Idempotent on re-send: if the order already has an outstanding REQUESTED
 * consent, we reuse its id so the existing /consent/:token link in the
 * customer's inbox keeps working. Once the customer has confirmed, a new
 * record is created — old confirmations are immutable.
 */
export async function requestConsent(
  input: RequestConsentInput,
  ctx: { actor: ConsentActor; appUrl: string; request?: RequestContext | null },
): Promise<RequestConsentResult> {
  await connectMongo();

  if (!Types.ObjectId.isValid(input.orderId)) {
    throw new ValidationError("Invalid order id");
  }
  const orderObjectId = new Types.ObjectId(input.orderId);

  const order = await Order.findById(orderObjectId);
  if (!order) throw new NotFoundError("Order not found");

  const existing =
    order.consent?.currentConsentId &&
    order.consent.status === ConsentStatus.REQUESTED
      ? await PaymentConsent.findById(order.consent.currentConsentId)
      : null;

  // Single persisted snapshot shape, reused by the create + refresh paths so
  // the frozen record always carries locations + the full charge breakdown.
  const persistedSnapshot = {
    bookingType: input.snapshot.bookingType,
    provider: input.snapshot.provider,
    vehicle: input.snapshot.vehicle,
    pickupDate: new Date(input.snapshot.pickupDate),
    dropoffDate: new Date(input.snapshot.dropoffDate),
    pickupLocation: input.snapshot.pickupLocation ?? null,
    dropoffLocation: input.snapshot.dropoffLocation ?? null,
    amount: input.snapshot.amount,
    currency: input.snapshot.currency,
    charges: input.snapshot.charges ?? [],
    dueAtCounter: input.snapshot.dueAtCounter ?? 0,
    total: input.snapshot.total ?? input.snapshot.amount,
    paymentLinkRef: input.snapshot.paymentLinkRef ?? null,
  };

  let doc: PaymentConsentDoc & { _id: Types.ObjectId };
  if (existing) {
    // Refresh the snapshot in case the agent edited the order between
    // sends — the customer should always see the latest details.
    existing.customerEmail = input.customerEmail;
    existing.customerName = input.customerName;
    existing.consentMessage = input.consentMessage;
    existing.consentEmailSubject = input.consentEmailSubject;
    existing.snapshot = persistedSnapshot;
    existing.requestedAt = new Date();
    await existing.save();
    doc = existing as unknown as PaymentConsentDoc & { _id: Types.ObjectId };
  } else {
    const created = await PaymentConsent.create({
      orderId: orderObjectId,
      orderNumber: order.orderNumber,
      status: ConsentStatus.REQUESTED,
      customerEmail: input.customerEmail,
      customerName: input.customerName,
      consentMessage: input.consentMessage,
      consentEmailSubject: input.consentEmailSubject,
      snapshot: persistedSnapshot,
      requestedAt: new Date(),
    });
    doc = created as unknown as PaymentConsentDoc & { _id: Types.ObjectId };
  }

  // Point the order at the fresh request, but DO NOT downgrade a previous
  // RECEIVED/VERIFIED status — a re-send shouldn't erase prior consent.
  const shouldPromote =
    order.consent?.status !== ConsentStatus.RECEIVED &&
    order.consent?.status !== ConsentStatus.VERIFIED;
  if (shouldPromote) {
    order.consent = {
      ...order.consent,
      status: ConsentStatus.REQUESTED,
      currentConsentId: doc._id,
      requestedAt: doc.requestedAt,
    };
    await order.save();
  } else {
    // Already received — still track that we re-requested in case ops needs
    // to see the resend history, but keep the dominant status.
    order.consent.requestedAt = doc.requestedAt;
    await order.save();
  }

  await recordAudit({
    action: AuditAction.CONSENT_REQUESTED,
    entityType: AuditEntity.CONSENT,
    entityId: String(doc._id),
    actor: {
      userId: ctx.actor.id,
      name: ctx.actor.name,
      email: ctx.actor.email,
      role: ctx.actor.role,
    },
    request: ctx.request ?? null,
    metadata: {
      orderId: String(orderObjectId),
      orderNumber: order.orderNumber,
      customerEmail: input.customerEmail,
      resend: Boolean(existing),
    },
  });

  const token = generateConsentToken(String(doc._id));
  const consentUrl = buildConsentUrl(ctx.appUrl, token);

  // Evidence chain: record what we asked the customer to acknowledge.
  // The raw token is sensitive (anyone with it can submit consent), so
  // we persist a SHA-256 hash of it for lookup, not the token itself.
  await captureEvidenceSafe({
    orderId: String(orderObjectId),
    orderNumber: order.orderNumber,
    eventType: OrderEvidenceEventType.CONSENT_REQUESTED,
    actor: {
      type: OrderEvidenceActorType.AGENT,
      userId: ctx.actor.id,
      name: ctx.actor.name,
      email: ctx.actor.email,
      role: ctx.actor.role,
    },
    request: ctx.request ?? null,
    payload: {
      consentId: String(doc._id),
      consentEmailSubject: input.consentEmailSubject,
      consentMessage: input.consentMessage,
      method: ConsentMethod.HOSTED_PAGE,
      resend: Boolean(existing),
      snapshot: {
        bookingType: input.snapshot.bookingType,
        provider: input.snapshot.provider,
        vehicle: input.snapshot.vehicle,
        pickupDate: new Date(input.snapshot.pickupDate).toISOString(),
        dropoffDate: new Date(input.snapshot.dropoffDate).toISOString(),
        amount: input.snapshot.amount,
        currency: input.snapshot.currency,
        paymentLinkRef: input.snapshot.paymentLinkRef ?? null,
      },
    },
    refs: {
      consentId: String(doc._id),
      consentTokenHash: hashConsentToken(token),
      customerEmail: input.customerEmail,
    },
  });

  return { consent: consentToDTO(doc), token, consentUrl };
}

async function loadConsentByTokenOrThrow(token: string) {
  await connectMongo();
  const { consentId } = parseConsentToken(token);
  if (!Types.ObjectId.isValid(consentId)) {
    throw new BadRequestError("Invalid consent token");
  }
  const doc = await PaymentConsent.findById(consentId);
  if (!doc) throw new NotFoundError("Consent record not found");
  return doc;
}

/**
 * Load a consent record for the public-facing hosted page. Returns the
 * trimmed view shape so we never leak audit metadata (IP, UA, verifier)
 * to the customer.
 */
export async function getPublicConsentView(
  token: string,
  branding: { brandName: string },
): Promise<PublicConsentView> {
  const doc = await loadConsentByTokenOrThrow(token);
  await connectMongo();
  const order = await Order.findById(doc.orderId).lean();
  return {
    status: doc.status as ConsentStatus,
    customerName: doc.customerName,
    customerEmail: doc.customerEmail,
    brandName: branding.brandName,
    consentMessage: doc.consentMessage,
    snapshot: {
      bookingType: doc.snapshot.bookingType as BookingType,
      provider: doc.snapshot.provider,
      vehicle: doc.snapshot.vehicle,
      pickupDate: doc.snapshot.pickupDate.toISOString(),
      dropoffDate: doc.snapshot.dropoffDate.toISOString(),
      pickupLocation: doc.snapshot.pickupLocation ?? null,
      dropoffLocation: doc.snapshot.dropoffLocation ?? null,
      amount: doc.snapshot.amount,
      currency: doc.snapshot.currency as Currency,
      charges: (doc.snapshot.charges ?? []).map((c) => ({
        name: c.name,
        amount: c.amount,
        timing: c.timing,
      })),
      dueAtCounter: doc.snapshot.dueAtCounter ?? 0,
      total: doc.snapshot.total ?? doc.snapshot.amount,
      paymentLinkRef: doc.snapshot.paymentLinkRef ?? null,
    },
    paymentUrl: order?.payment?.checkoutUrl ?? null,
    alreadyConfirmedAt: doc.receivedAt ? doc.receivedAt.toISOString() : null,
  };
}

export interface RecordConsentInput {
  token: string;
  signedName?: string | null;
  /** Verbatim acknowledgement statement the customer confirmed. Echo of
   *  what the page rendered — we re-verify it matches the stored message
   *  to guard against tampering. */
  acknowledgement: string;
  method?: ConsentMethod;
}

/**
 * Public endpoint: record the customer's confirmation on the hosted page.
 * Always returns the trimmed PublicConsentView so the page can transition
 * straight into the "thanks, proceed to payment" state.
 */
export async function recordConsentFromToken(
  input: RecordConsentInput,
  ctx: { request?: RequestContext | null; branding: { brandName: string } },
): Promise<PublicConsentView> {
  const doc = await loadConsentByTokenOrThrow(input.token);

  if (
    input.acknowledgement.trim().toLowerCase() !==
    doc.consentMessage.trim().toLowerCase()
  ) {
    // Echo mismatch — refuse rather than silently accepting tampered copy.
    throw new BadRequestError("Acknowledgement statement does not match");
  }

  // Idempotent: a refresh or rapid double-click after the customer
  // already confirmed just returns the existing state. The replay path
  // is intentionally tolerant of a missing signature.
  if (doc.status === ConsentStatus.RECEIVED || doc.status === ConsentStatus.VERIFIED) {
    return getPublicConsentView(input.token, ctx.branding);
  }

  // First-time transition: a signature IS required. The UI enforces this
  // client-side; the server re-checks so a hand-rolled curl can't slip
  // an empty signature past us.
  const trimmedSignature = input.signedName?.trim() ?? "";
  if (trimmedSignature.length < 2) {
    throw new BadRequestError("Please type your full name as a digital signature.");
  }

  // Customer submission IS the verification — there is no separate admin
  // verify step any more. The hosted page is the only path; the customer
  // typed their name as a digital signature against the same message we
  // displayed, captured server-side with IP + user-agent. That's the
  // dispute-grade record. Stamp `receivedAt` and `verifiedAt` to the
  // same moment so the timeline reads cleanly either way.
  const now = new Date();
  doc.status = ConsentStatus.VERIFIED;
  doc.method = input.method ?? ConsentMethod.HOSTED_PAGE;
  doc.receivedAt = now;
  doc.verifiedAt = now;
  doc.receiptIp = ctx.request?.ip ?? null;
  doc.receiptUserAgent = ctx.request?.userAgent ?? null;
  doc.signedName = trimmedSignature.slice(0, 120);
  await doc.save();

  await Order.updateOne(
    { _id: doc.orderId },
    {
      $set: {
        "consent.status": ConsentStatus.VERIFIED,
        "consent.currentConsentId": doc._id,
        "consent.receivedAt": doc.receivedAt,
        "consent.verifiedAt": doc.verifiedAt,
        "consent.method": doc.method,
      },
    },
  );

  await recordAudit({
    action: AuditAction.CONSENT_RECEIVED,
    entityType: AuditEntity.CONSENT,
    entityId: String(doc._id),
    actor: {
      // Customer-side action — actor.userId is intentionally null. We
      // attribute via the email on the consent record.
      userId: null,
      name: doc.customerName,
      email: doc.customerEmail,
      role: null,
    },
    request: ctx.request ?? null,
    metadata: {
      method: doc.method,
      signedName: doc.signedName,
      orderId: String(doc.orderId),
      orderNumber: doc.orderNumber,
    },
  });

  // Evidence chain: this is the strongest single piece of dispute
  // defense — the customer typed their name against the same statement
  // the page displayed, captured server-side with IP + UA at receipt
  // time. We persist all of it including the hashed token so a future
  // search by token lands on this event.
  await captureEvidenceSafe({
    orderId: String(doc.orderId),
    orderNumber: doc.orderNumber,
    eventType: OrderEvidenceEventType.CONSENT_RECEIVED,
    occurredAt: doc.receivedAt ?? now,
    actor: {
      type: OrderEvidenceActorType.CUSTOMER,
      name: doc.customerName,
      email: doc.customerEmail,
    },
    request: ctx.request ?? null,
    payload: {
      consentId: String(doc._id),
      method: doc.method,
      signedName: doc.signedName,
      acknowledgement: input.acknowledgement,
      consentMessage: doc.consentMessage,
      snapshot: {
        bookingType: doc.snapshot.bookingType,
        provider: doc.snapshot.provider,
        vehicle: doc.snapshot.vehicle,
        pickupDate: doc.snapshot.pickupDate.toISOString(),
        dropoffDate: doc.snapshot.dropoffDate.toISOString(),
        amount: doc.snapshot.amount,
        currency: doc.snapshot.currency,
        paymentLinkRef: doc.snapshot.paymentLinkRef ?? null,
      },
      receivedAt: (doc.receivedAt ?? now).toISOString(),
      verifiedAt: (doc.verifiedAt ?? now).toISOString(),
    },
    refs: {
      consentId: String(doc._id),
      consentTokenHash: hashConsentToken(input.token),
      customerEmail: doc.customerEmail,
      signatureName: doc.signedName ?? null,
    },
  });

  // Realtime push so the agent's order detail page flips the "Consent
  // received" timeline node instantly. Audience is the order creator —
  // the SSE filter widens it to admins.
  const owner = await Order.findById(doc.orderId)
    .select({ "createdBy.userId": 1, orderNumber: 1 })
    .lean<{ createdBy: { userId: Types.ObjectId } }>();
  if (owner?.createdBy?.userId) {
    logger.info("order.lifecycle.transition", {
      orderId: String(doc.orderId),
      orderNumber: doc.orderNumber,
      previousState: "REQUESTED",
      nextState: "VERIFIED",
      transition: "consent_received",
      source: "service.consent.hosted_page",
    });
    publishEvent({
      type: DomainEventType.ORDER_CONSENT_RECEIVED,
      audience: { kind: "creator", userId: String(owner.createdBy.userId) },
      payload: {
        orderId: String(doc.orderId),
        orderNumber: doc.orderNumber,
        customerName: doc.customerName,
        method: doc.method,
      },
    });
  }

  return getPublicConsentView(input.token, ctx.branding);
}

/**
 * Admin action: lock a RECEIVED consent record as dispute-grade evidence.
 * Only the consent itself moves to VERIFIED — we don't retroactively
 * mutate the customer-facing copy or timestamps.
 */
export async function verifyConsent(
  consentId: string,
  ctx: { actor: ConsentActor; request?: RequestContext | null },
): Promise<PaymentConsentDTO> {
  if (!roleHasPermission(ctx.actor.role, Permission.CONSENT_VERIFY)) {
    throw new ForbiddenError("You do not have permission to verify consent");
  }
  await connectMongo();
  if (!Types.ObjectId.isValid(consentId)) {
    throw new ValidationError("Invalid consent id");
  }
  const doc = await PaymentConsent.findById(consentId);
  if (!doc) throw new NotFoundError("Consent record not found");
  if (doc.status === ConsentStatus.NOT_REQUESTED) {
    throw new ConflictError("Cannot verify a consent that was never requested");
  }
  if (doc.status === ConsentStatus.REQUESTED) {
    throw new ConflictError(
      "Customer has not yet confirmed — wait for the hosted page click",
    );
  }
  if (doc.status === ConsentStatus.VERIFIED) {
    return consentToDTO(doc);
  }
  doc.status = ConsentStatus.VERIFIED;
  doc.verifiedAt = new Date();
  doc.verifiedBy = {
    userId: new Types.ObjectId(ctx.actor.id),
    name: ctx.actor.name,
  };
  await doc.save();

  await Order.updateOne(
    { _id: doc.orderId },
    {
      $set: {
        "consent.status": ConsentStatus.VERIFIED,
        "consent.verifiedAt": doc.verifiedAt,
      },
    },
  );

  await recordAudit({
    action: AuditAction.CONSENT_VERIFIED,
    entityType: AuditEntity.CONSENT,
    entityId: String(doc._id),
    actor: {
      userId: ctx.actor.id,
      name: ctx.actor.name,
      email: ctx.actor.email,
      role: ctx.actor.role,
    },
    request: ctx.request ?? null,
    metadata: {
      orderId: String(doc.orderId),
      orderNumber: doc.orderNumber,
    },
  });

  await captureEvidenceSafe({
    orderId: String(doc.orderId),
    orderNumber: doc.orderNumber,
    eventType: OrderEvidenceEventType.CONSENT_VERIFIED,
    occurredAt: doc.verifiedAt ?? new Date(),
    actor: {
      type: OrderEvidenceActorType.AGENT,
      userId: ctx.actor.id,
      name: ctx.actor.name,
      email: ctx.actor.email,
      role: ctx.actor.role,
    },
    request: ctx.request ?? null,
    payload: {
      consentId: String(doc._id),
      verifiedAt: (doc.verifiedAt ?? new Date()).toISOString(),
      signedName: doc.signedName,
    },
    refs: {
      consentId: String(doc._id),
      customerEmail: doc.customerEmail,
      signatureName: doc.signedName ?? null,
    },
  });

  return consentToDTO(doc);
}

/** List all consent records associated with an order (history view). */
export async function listConsentsForOrder(
  orderId: string,
  ctx: { actor: ConsentActor },
): Promise<PaymentConsentDTO[]> {
  if (!roleHasPermission(ctx.actor.role, Permission.CONSENT_VIEW)) {
    throw new ForbiddenError("You do not have permission to view consent records");
  }
  await connectMongo();
  if (!Types.ObjectId.isValid(orderId)) return [];
  const docs = await PaymentConsent.find({
    orderId: new Types.ObjectId(orderId),
  })
    .sort({ createdAt: -1 })
    .lean();
  return docs.map((d) =>
    consentToDTO(d as unknown as PaymentConsentDoc & { _id: Types.ObjectId }),
  );
}

export async function getConsentById(
  consentId: string,
  ctx: { actor: ConsentActor },
): Promise<PaymentConsentDTO> {
  if (!roleHasPermission(ctx.actor.role, Permission.CONSENT_VIEW)) {
    throw new ForbiddenError("You do not have permission to view consent records");
  }
  await connectMongo();
  if (!Types.ObjectId.isValid(consentId)) {
    throw new ValidationError("Invalid consent id");
  }
  const doc = await PaymentConsent.findById(consentId);
  if (!doc) throw new NotFoundError("Consent record not found");
  return consentToDTO(doc as unknown as PaymentConsentDoc & { _id: Types.ObjectId });
}

/** Best-effort audit row for "payment after consent" — fires from the
 *  Stripe webhook path when an order with a RECEIVED/VERIFIED consent
 *  finishes payment. Operational signal only; never throws. */
export async function recordPaymentAfterConsent(
  orderId: string,
  context: {
    consentStatus: ConsentStatus;
    consentId: string | null;
    orderNumber: string;
  },
): Promise<void> {
  try {
    await recordAudit({
      action: AuditAction.PAYMENT_SUCCEEDED,
      entityType: AuditEntity.CONSENT,
      entityId: context.consentId,
      metadata: {
        orderId,
        orderNumber: context.orderNumber,
        consentStatus: context.consentStatus,
        note: "payment_after_consent",
      },
    });
  } catch (err) {
    logger.warn("consent.audit_payment_after_consent_failed", {
      orderId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
