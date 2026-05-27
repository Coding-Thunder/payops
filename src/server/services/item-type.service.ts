import "server-only";

import { Types } from "mongoose";

import { RecordState } from "@/lib/constants/enums";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import {
  EmailBlockKey,
  DEFAULT_CONFIRMATION_BLOCKS,
  ItemAttributeType,
  ItemPricingModel,
  type SchedulingType,
} from "@/lib/constants/items";
import {
  ItemType,
  type ItemAttributeSpec,
  type ItemTypeDoc,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { orgIdFilter, requireOrgId } from "@/server/db/org/org-context";

/**
 * Pass 5e — ItemType admin + read service.
 *
 * The dynamic create-order form lists ACTIVE ItemTypes for the caller's
 * org; admins manage the catalog (create / update attributes / archive).
 * All writes are org-scoped — a Tenant B admin cannot mutate a Tenant A
 * ItemType even by guessing its id (same boundary discipline as Pass 5a).
 */

/* ─────────────────────────────── DTOs ────────────────────────────────── */

export interface ItemTypeAttributeDTO {
  key: string;
  label: string;
  type: ItemAttributeType;
  required: boolean;
  options?: string[];
  helpText?: string | null;
  displayOrder: number;
}

export interface ItemTypeDTO {
  id: string;
  key: string;
  name: string;
  description: string | null;
  pricingModel: ItemPricingModel;
  requiresScheduling: boolean;
  inventoryTracked: boolean;
  attributeSchema: ItemTypeAttributeDTO[];
  confirmationEmailBlocks: EmailBlockKey[];
  status: RecordState;
  createdAt: string;
  updatedAt: string;
}

function toDTO(
  doc: ItemTypeDoc & { _id: Types.ObjectId },
): ItemTypeDTO {
  return {
    id: String(doc._id),
    key: doc.key,
    name: doc.name,
    description: doc.description ?? null,
    pricingModel: doc.pricingModel,
    requiresScheduling: doc.requiresScheduling,
    inventoryTracked: doc.inventoryTracked,
    attributeSchema: (doc.attributeSchema ?? []).map((s) => ({
      key: s.key,
      label: s.label,
      type: s.type,
      required: s.required,
      options: s.options ?? undefined,
      helpText: s.helpText ?? null,
      displayOrder: s.displayOrder,
    })),
    confirmationEmailBlocks: doc.confirmationEmailBlocks ?? [],
    status: doc.status,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/* ─────────────────────────── Read helpers ────────────────────────────── */

export interface ItemTypeContext {
  orgId: string;
  actorId: string;
}

/** Per-tenant active list — what the create-order form picks from. */
export async function listActiveItemTypes(
  orgId: string | null,
): Promise<ItemTypeDTO[]> {
  const scopedOrgId = requireOrgId(orgId);
  await connectMongo();
  const docs = await ItemType.find({
    orgId: orgIdFilter(scopedOrgId),
    status: RecordState.ACTIVE,
  })
    .sort({ name: 1 })
    .lean<(ItemTypeDoc & { _id: Types.ObjectId })[]>();
  return docs.map(toDTO);
}

/** Admin list — includes archived rows so admins can see what's gone. */
export async function listAllItemTypes(
  ctx: ItemTypeContext,
): Promise<ItemTypeDTO[]> {
  await connectMongo();
  const docs = await ItemType.find({ orgId: orgIdFilter(ctx.orgId) })
    .sort({ status: 1, name: 1 })
    .lean<(ItemTypeDoc & { _id: Types.ObjectId })[]>();
  return docs.map(toDTO);
}

export async function getItemTypeById(
  id: string,
  ctx: ItemTypeContext,
): Promise<ItemTypeDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) {
    throw new NotFoundError("Item type not found");
  }
  // Pin BOTH id AND orgId — cross-tenant id-guess refusal.
  const doc = await ItemType.findOne({
    _id: id,
    orgId: orgIdFilter(ctx.orgId),
  }).lean<ItemTypeDoc & { _id: Types.ObjectId }>();
  if (!doc) throw new NotFoundError("Item type not found");
  return toDTO(doc);
}

export async function getItemTypeByKey(
  key: string,
  orgId: string,
): Promise<ItemTypeDTO | null> {
  await connectMongo();
  const doc = await ItemType.findOne({
    orgId: orgIdFilter(orgId),
    key,
  }).lean<ItemTypeDoc & { _id: Types.ObjectId }>();
  return doc ? toDTO(doc) : null;
}

/* ──────────────────────────── Write paths ────────────────────────────── */

export interface CreateItemTypeInput {
  key: string;
  name: string;
  description?: string | null;
  pricingModel: ItemPricingModel;
  requiresScheduling: boolean;
  inventoryTracked: boolean;
  attributeSchema: ItemTypeAttributeDTO[];
  /** Optional — defaults to DEFAULT_CONFIRMATION_BLOCKS. */
  confirmationEmailBlocks?: EmailBlockKey[];
}

export type UpdateItemTypeInput = Partial<
  Omit<CreateItemTypeInput, "key">
> & {
  /** Editing the key would invalidate every persisted line's
   *  `itemTypeKey` pointer. Explicitly refused. */
  key?: never;
};

/** Shared attribute-spec sanity check — Mongo's pre-validate hook on the
 *  model also runs, but we surface ValidationError here for nicer API
 *  responses (Mongo errors lose stack context). */
function sanitizeAttributeSchema(
  specs: ItemTypeAttributeDTO[],
): ItemAttributeSpec[] {
  const seen = new Set<string>();
  for (const s of specs) {
    if (seen.has(s.key)) {
      throw new ValidationError(`Duplicate attribute key "${s.key}".`);
    }
    seen.add(s.key);
    if (s.type === ItemAttributeType.SELECT) {
      if (!s.options || s.options.length === 0) {
        throw new ValidationError(
          `Attribute "${s.key}" is SELECT but has no options.`,
        );
      }
    }
  }
  return specs.map((s) => ({
    key: s.key,
    label: s.label,
    type: s.type,
    required: s.required,
    options: s.type === ItemAttributeType.SELECT ? s.options : undefined,
    helpText: s.helpText ?? undefined,
    displayOrder: s.displayOrder,
  }));
}

export async function createItemType(
  input: CreateItemTypeInput,
  ctx: ItemTypeContext,
): Promise<ItemTypeDTO> {
  await connectMongo();
  const attributeSchema = sanitizeAttributeSchema(input.attributeSchema);
  try {
    const created = await ItemType.create({
      orgId: orgIdFilter(ctx.orgId),
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      pricingModel: input.pricingModel,
      requiresScheduling: input.requiresScheduling,
      inventoryTracked: input.inventoryTracked,
      attributeSchema,
      confirmationEmailBlocks:
        input.confirmationEmailBlocks ?? [...DEFAULT_CONFIRMATION_BLOCKS],
      status: RecordState.ACTIVE,
      createdBy: new Types.ObjectId(ctx.actorId),
      updatedBy: new Types.ObjectId(ctx.actorId),
    });
    return toDTO(created.toObject() as ItemTypeDoc & { _id: Types.ObjectId });
  } catch (err) {
    // Compound unique index (orgId, key)
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000
    ) {
      throw new ConflictError(
        `An item type with key "${input.key}" already exists.`,
      );
    }
    throw err;
  }
}

export async function updateItemType(
  id: string,
  input: UpdateItemTypeInput,
  ctx: ItemTypeContext,
): Promise<ItemTypeDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) {
    throw new NotFoundError("Item type not found");
  }
  const update: Record<string, unknown> = {
    updatedBy: new Types.ObjectId(ctx.actorId),
  };
  if (input.name !== undefined) update.name = input.name;
  if (input.description !== undefined)
    update.description = input.description ?? null;
  if (input.pricingModel !== undefined) update.pricingModel = input.pricingModel;
  if (input.requiresScheduling !== undefined)
    update.requiresScheduling = input.requiresScheduling;
  if (input.inventoryTracked !== undefined)
    update.inventoryTracked = input.inventoryTracked;
  if (input.attributeSchema !== undefined) {
    update.attributeSchema = sanitizeAttributeSchema(input.attributeSchema);
  }
  if (input.confirmationEmailBlocks !== undefined) {
    update.confirmationEmailBlocks = input.confirmationEmailBlocks;
  }
  const updated = await ItemType.findOneAndUpdate(
    { _id: id, orgId: orgIdFilter(ctx.orgId) },
    { $set: update },
    { new: true, runValidators: true },
  ).lean<ItemTypeDoc & { _id: Types.ObjectId }>();
  if (!updated) throw new NotFoundError("Item type not found");
  return toDTO(updated);
}

/** Soft delete — sets `status = ARCHIVED`. Historical orders keep their
 *  `lineItems[i].itemTypeKey` pointer intact (the snapshot is on the
 *  order; the catalog row only drives the create-order form). */
export async function archiveItemType(
  id: string,
  ctx: ItemTypeContext,
): Promise<ItemTypeDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) {
    throw new NotFoundError("Item type not found");
  }
  const updated = await ItemType.findOneAndUpdate(
    { _id: id, orgId: orgIdFilter(ctx.orgId) },
    {
      $set: {
        status: RecordState.ARCHIVED,
        updatedBy: new Types.ObjectId(ctx.actorId),
      },
    },
    { new: true },
  ).lean<ItemTypeDoc & { _id: Types.ObjectId }>();
  if (!updated) throw new NotFoundError("Item type not found");
  return toDTO(updated);
}

export async function restoreItemType(
  id: string,
  ctx: ItemTypeContext,
): Promise<ItemTypeDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) {
    throw new NotFoundError("Item type not found");
  }
  const updated = await ItemType.findOneAndUpdate(
    { _id: id, orgId: orgIdFilter(ctx.orgId) },
    {
      $set: {
        status: RecordState.ACTIVE,
        updatedBy: new Types.ObjectId(ctx.actorId),
      },
    },
    { new: true },
  ).lean<ItemTypeDoc & { _id: Types.ObjectId }>();
  if (!updated) throw new NotFoundError("Item type not found");
  return toDTO(updated);
}

// Re-export types the API + UI bind against without importing the model
// directly.
export type {
  SchedulingType,
  ItemAttributeType,
  ItemPricingModel,
  EmailBlockKey,
};
