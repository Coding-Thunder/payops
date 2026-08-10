import "server-only";

import { Types } from "mongoose";

import { ConflictError, NotFoundError } from "@/lib/errors";
import {
  OrderDraft,
  type OrderDraftDocument,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import {
  organizationStamp,
  withOrganizationScope,
} from "@/server/db/organization-filter";
import { getRequestOrganizationScope } from "@/server/auth/organization";
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
}

export async function listDrafts({
  actor,
}: ActorCtx): Promise<OrderDraftDTO[]> {
  await connectMongo();
  // Drafts were already owner-scoped, which is not the same as
  // organization-scoped: a user who belongs to two brands would otherwise
  // see the drafts they started in one while working in the other.
  const docs = await OrderDraft.find(
    withOrganizationScope(
      { ownerId: new Types.ObjectId(actor.id) },
      await getRequestOrganizationScope(),
    ),
  )
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
  const doc = await OrderDraft.findOne(
    withOrganizationScope(
      {
        _id: new Types.ObjectId(id),
        ownerId: new Types.ObjectId(actor.id),
      },
      await getRequestOrganizationScope(),
    ),
  ).exec();
  if (!doc) throw new NotFoundError("Draft not found");
  return toDTO(doc);
}

export interface CreateDraftInput {
  data?: Record<string, unknown>;
}

export async function createDraft(
  { data = {} }: CreateDraftInput,
  { actor }: ActorCtx,
): Promise<OrderDraftDTO> {
  await connectMongo();
  const summary = summarize(data);
  const doc = await OrderDraft.create({
    organizationId: organizationStamp(await getRequestOrganizationScope()),
    ownerId: new Types.ObjectId(actor.id),
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
  const scope = await getRequestOrganizationScope();
  const base: Record<string, unknown> = {
    _id: new Types.ObjectId(id),
    ownerId: new Types.ObjectId(actor.id),
  };
  if (expectedRevision !== null) base.revision = expectedRevision;
  const filter = withOrganizationScope(base, scope);
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
    const exists = await OrderDraft.exists(
      withOrganizationScope(
        {
          _id: new Types.ObjectId(id),
          ownerId: new Types.ObjectId(actor.id),
        },
        scope,
      ),
    );
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
  await OrderDraft.deleteOne(
    withOrganizationScope(
      {
        _id: new Types.ObjectId(id),
        ownerId: new Types.ObjectId(actor.id),
      },
      await getRequestOrganizationScope(),
    ),
  ).exec();
}
