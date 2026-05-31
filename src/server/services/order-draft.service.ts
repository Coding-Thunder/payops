import "server-only";

import { Types } from "mongoose";

import { ConflictError, NotFoundError } from "@/lib/errors";
import {
  OrderDraft,
  type OrderDraftDocument,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import type { SessionUser } from "@/types";

export interface OrderDraftDTO {
  id: string;
  ownerId: string;
  data: Record<string, unknown>;
  summary: {
    customerName: string | null;
    orderAmount: number | null;
    currency: string | null;
  };
  revision: number;
  lastEditedAt: string;
  createdAt: string;
  updatedAt: string;
}

function toDTO(doc: OrderDraftDocument): OrderDraftDTO {
  return {
    id: String(doc._id),
    ownerId: String(doc.ownerId),
    data: doc.data ?? {},
    summary: {
      customerName: doc.summary?.customerName ?? null,
      orderAmount: doc.summary?.orderAmount ?? null,
      currency: doc.summary?.currency ?? null,
    },
    revision: doc.revision,
    lastEditedAt: doc.lastEditedAt.toISOString(),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/**
 * Derive the tiny summary we render in tab labels and the drafts picker
 * without storing a full snapshot twice. Tolerant of partial form state.
 */
function summarize(
  data: Record<string, unknown>,
): { customerName: string | null; orderAmount: number | null; currency: string | null } {
  const customer = (data.customer ?? null) as { name?: string } | null;
  const pricing = (data.pricing ?? null) as
    | { amount?: number; currency?: string }
    | null;
  const customerName =
    typeof customer?.name === "string" && customer.name.trim().length > 0
      ? customer.name.trim().slice(0, 120)
      : null;
  const orderAmount =
    typeof pricing?.amount === "number" && Number.isFinite(pricing.amount)
      ? pricing.amount
      : null;
  const currency =
    typeof pricing?.currency === "string" && pricing.currency.length <= 8
      ? pricing.currency
      : null;
  return { customerName, orderAmount, currency };
}

interface ActorCtx {
  actor: SessionUser;
  /** Tenant boundary — required for new drafts so they pin to the
   *  org the operator is currently in. Optional in the type for
   *  legacy callers; the service falls back to null (which means
   *  the draft can't be cross-tenant since reads filter by ownerId
   *  too, but per-tenant draft lists won't include it). */
  orgId?: string | null;
}

export async function listDrafts({
  actor,
}: ActorCtx): Promise<OrderDraftDTO[]> {
  await connectMongo();
  const docs = await OrderDraft.find({ ownerId: new Types.ObjectId(actor.id) })
    .sort({ lastEditedAt: -1 })
    .limit(50)
    .exec();
  return docs.map(toDTO);
}

export async function getDraftById(
  id: string,
  { actor }: ActorCtx,
): Promise<OrderDraftDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Draft not found");
  const doc = await OrderDraft.findOne({
    _id: new Types.ObjectId(id),
    ownerId: new Types.ObjectId(actor.id),
  }).exec();
  if (!doc) throw new NotFoundError("Draft not found");
  return toDTO(doc);
}

export interface CreateDraftInput {
  data?: Record<string, unknown>;
}

export async function createDraft(
  { data = {} }: CreateDraftInput,
  { actor, orgId }: ActorCtx,
): Promise<OrderDraftDTO> {
  await connectMongo();
  const summary = summarize(data);
  const doc = await OrderDraft.create({
    ownerId: new Types.ObjectId(actor.id),
    orgId: orgId ? new Types.ObjectId(orgId) : null,
    data,
    summary,
    revision: 1,
    lastEditedAt: new Date(),
  });
  return toDTO(doc);
}

export interface UpdateDraftInput {
  data: Record<string, unknown>;
  /**
   * Last revision the client observed. Server rejects with 409 if the doc
   * has moved on (e.g. another tab on the same account autosaved meanwhile).
   * Pass `null` to force-overwrite.
   */
  expectedRevision: number | null;
}

export async function updateDraft(
  id: string,
  { data, expectedRevision }: UpdateDraftInput,
  { actor }: ActorCtx,
): Promise<OrderDraftDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Draft not found");
  const filter: Record<string, unknown> = {
    _id: new Types.ObjectId(id),
    ownerId: new Types.ObjectId(actor.id),
  };
  if (expectedRevision !== null) filter.revision = expectedRevision;
  const summary = summarize(data);
  const updated = await OrderDraft.findOneAndUpdate(
    filter,
    {
      $set: { data, summary, lastEditedAt: new Date() },
      $inc: { revision: 1 },
    },
    { new: true },
  ).exec();
  if (!updated) {
    // Either the draft doesn't exist OR a concurrent write moved the
    // revision pointer. Distinguish so the client UX is correct.
    const exists = await OrderDraft.exists({
      _id: new Types.ObjectId(id),
      ownerId: new Types.ObjectId(actor.id),
    });
    if (!exists) throw new NotFoundError("Draft not found");
    throw new ConflictError(
      "Draft was modified elsewhere — refresh to pick up the latest changes",
    );
  }
  return toDTO(updated);
}

export async function deleteDraft(
  id: string,
  { actor }: ActorCtx,
): Promise<void> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Draft not found");
  await OrderDraft.deleteOne({
    _id: new Types.ObjectId(id),
    ownerId: new Types.ObjectId(actor.id),
  }).exec();
}
