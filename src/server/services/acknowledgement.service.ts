import "server-only";

import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  OrderEvidenceActorType,
  OrderEvidenceEventType,
} from "@/lib/constants/enums";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { Order } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import type { RequestContext } from "@/server/api/request-context";

import { recordAudit } from "./audit.service";
import { captureEvidenceSafe } from "./evidence.service";
import { getBranding } from "./branding.service";
import { parseAckToken } from "./ack-token";

/** Trimmed view rendered by the public /acknowledge/[token] page. Never leaks
 *  audit metadata (IP / UA) back to the customer. */
export interface PublicAcknowledgementView {
  orderNumber: string;
  customerName: string;
  brandName: string;
  supportEmail: string;
  termsText: string;
  termsVersion: string;
  acknowledgedAt: string | null;
}

async function loadOrderByAckToken(token: string) {
  await connectMongo();
  const { orderId } = parseAckToken(token);
  if (!Types.ObjectId.isValid(orderId)) {
    throw new BadRequestError("Invalid acknowledgement token");
  }
  const doc = await Order.findById(orderId);
  if (!doc) throw new NotFoundError("Booking not found");
  return doc;
}

export async function getPublicAcknowledgementView(
  token: string,
): Promise<PublicAcknowledgementView> {
  const doc = await loadOrderByAckToken(token);
  const branding = await getBranding();
  return {
    orderNumber: doc.orderNumber,
    customerName: doc.customer.name,
    brandName: branding.brandName,
    supportEmail: branding.supportEmail,
    termsText: doc.terms?.text ?? "",
    termsVersion: doc.terms?.version ?? "v1",
    acknowledgedAt: doc.termsAcknowledgement?.acknowledgedAt
      ? doc.termsAcknowledgement.acknowledgedAt.toISOString()
      : null,
  };
}

/**
 * Record the customer's post-payment "I Agree" acknowledgement of the T&C
 * shown in the confirmation email. Idempotent — a re-click returns the
 * existing state without re-stamping. Captures IP + UA server-side and writes
 * an append-only evidence event for dispute defense.
 */
export async function recordTermsAcknowledgement(
  token: string,
  ctx: { request?: RequestContext | null },
): Promise<PublicAcknowledgementView> {
  const doc = await loadOrderByAckToken(token);

  if (doc.termsAcknowledgement?.acknowledgedAt) {
    return getPublicAcknowledgementView(token);
  }

  const now = new Date();
  doc.termsAcknowledgement = {
    acknowledgedAt: now,
    ip: ctx.request?.ip ?? null,
    userAgent: ctx.request?.userAgent ?? null,
  };
  await doc.save();

  await recordAudit({
    action: AuditAction.ORDER_UPDATED,
    entityType: AuditEntity.ORDER,
    entityId: String(doc._id),
    actor: {
      userId: null,
      name: doc.customer.name,
      email: doc.customer.email,
      role: null,
    },
    request: ctx.request ?? null,
    metadata: {
      action: "terms_acknowledged",
      orderNumber: doc.orderNumber,
      termsVersion: doc.terms?.version ?? "v1",
    },
  });

  await captureEvidenceSafe({
    orderId: String(doc._id),
    orderNumber: doc.orderNumber,
    eventType: OrderEvidenceEventType.TERMS_ACKNOWLEDGED,
    occurredAt: now,
    actor: {
      type: OrderEvidenceActorType.CUSTOMER,
      name: doc.customer.name,
      email: doc.customer.email,
    },
    request: ctx.request ?? null,
    payload: {
      termsVersion: doc.terms?.version ?? "v1",
      termsText: doc.terms?.text ?? "",
      acknowledgedAt: now.toISOString(),
    },
    refs: { customerEmail: doc.customer.email },
  });

  return getPublicAcknowledgementView(token);
}
