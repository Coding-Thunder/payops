import "server-only";

import { Types } from "mongoose";

import { Currency, RecordState } from "@/lib/constants/enums";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import {
  Item,
  ItemType,
  type ItemDoc,
  type ItemTypeDoc,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { orgIdFilter, requireOrgId } from "@/server/db/org/org-context";

import { validateLineAttributes } from "./attribute-validator.service";

/**
 * Pass 6c — per-tenant Item catalog service.
 *
 * An `Item` is a reusable product/service/asset row that operators
 * pick when creating an order. Each Item references an `ItemType` by
 * key, so the line snapshot the operator builds is always shape-valid
 * against that org's attribute schema.
 *
 * Lifecycle:
 *   1. Admin creates an Item (catalog row): name + optional SKU +
 *      base price + per-itemType attributes (e.g. SKU, size, color
 *      for retail products).
 *   2. Operators pick the Item in the create-order dynamic form;
 *      `Order.lineItems[i]` carries `itemId` back-pointer + a frozen
 *      snapshot of name/attributes/unitPrice.
 *   3. Edits to the catalog row do NOT mutate existing orders — the
 *      snapshot keeps the historical truth.
 *   4. Archive (soft-delete) hides the Item from the picker; existing
 *      orders that reference it keep rendering via the snapshot.
 */

/* ─────────────────────────────── DTOs ────────────────────────────────── */

export interface ItemDTO {
  id: string;
  itemTypeKey: string;
  name: string;
  description: string | null;
  basePrice: { amount: number; currency: Currency } | null;
  sku: string | null;
  imageUrl: string | null;
  attributes: Record<string, unknown>;
  inventory: { available: number; reserved: number } | null;
  status: RecordState;
  createdAt: string;
  updatedAt: string;
}

function toDTO(doc: ItemDoc & { _id: Types.ObjectId }): ItemDTO {
  return {
    id: String(doc._id),
    itemTypeKey: doc.itemTypeKey,
    name: doc.name,
    description: doc.description ?? null,
    basePrice: doc.basePrice
      ? {
          amount: doc.basePrice.amount,
          currency: doc.basePrice.currency as Currency,
        }
      : null,
    sku: doc.sku ?? null,
    imageUrl: doc.imageUrl ?? null,
    attributes: (doc.attributes ?? {}) as Record<string, unknown>,
    inventory: doc.inventory
      ? {
          available: doc.inventory.available,
          reserved: doc.inventory.reserved,
        }
      : null,
    status: doc.status,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export interface ItemContext {
  orgId: string;
  actorId: string;
  actorName: string;
}

/* ────────────────────────── Read helpers ─────────────────────────────── */

/** Per-org active catalog list. Used by the create-order form's
 *  "Pick from catalog" picker. Optional `itemTypeKey` filter narrows
 *  to a single vertical so the picker only shows relevant rows. */
export async function listActiveItems(
  orgId: string | null,
  filter: { itemTypeKey?: string } = {},
): Promise<ItemDTO[]> {
  const scopedOrgId = requireOrgId(orgId);
  await connectMongo();
  const query: Record<string, unknown> = {
    orgId: orgIdFilter(scopedOrgId),
    status: RecordState.ACTIVE,
  };
  if (filter.itemTypeKey) query.itemTypeKey = filter.itemTypeKey;
  const docs = await Item.find(query)
    .sort({ name: 1 })
    .lean<(ItemDoc & { _id: Types.ObjectId })[]>();
  return docs.map(toDTO);
}

/** Admin list — includes ARCHIVED + DISABLED rows so admins can audit
 *  the full history of a catalog. */
export async function listAllItems(
  ctx: ItemContext,
  filter: { itemTypeKey?: string } = {},
): Promise<ItemDTO[]> {
  await connectMongo();
  const query: Record<string, unknown> = { orgId: orgIdFilter(ctx.orgId) };
  if (filter.itemTypeKey) query.itemTypeKey = filter.itemTypeKey;
  const docs = await Item.find(query)
    .sort({ status: 1, name: 1 })
    .lean<(ItemDoc & { _id: Types.ObjectId })[]>();
  return docs.map(toDTO);
}

export async function getItemById(
  id: string,
  ctx: ItemContext,
): Promise<ItemDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) {
    throw new NotFoundError("Item not found");
  }
  // Pin BOTH id AND orgId — cross-tenant id-guess refusal.
  const doc = await Item.findOne({
    _id: id,
    orgId: orgIdFilter(ctx.orgId),
  }).lean<ItemDoc & { _id: Types.ObjectId }>();
  if (!doc) throw new NotFoundError("Item not found");
  return toDTO(doc);
}

/* ────────────────────────── Write paths ──────────────────────────────── */

export interface CreateItemInput {
  itemTypeKey: string;
  name: string;
  description?: string | null;
  basePrice?: { amount: number; currency: Currency } | null;
  sku?: string | null;
  imageUrl?: string | null;
  attributes?: Record<string, unknown>;
  inventory?: { available: number; reserved: number } | null;
}

async function resolveItemType(
  orgId: string,
  key: string,
): Promise<ItemTypeDoc & { _id: Types.ObjectId }> {
  const doc = await ItemType.findOne({
    orgId: orgIdFilter(orgId),
    key,
  }).lean<ItemTypeDoc & { _id: Types.ObjectId }>();
  if (!doc) {
    throw new ValidationError(
      `Item type "${key}" is not defined for this organization. Create it via the admin catalog before adding items against it.`,
    );
  }
  return doc;
}

export async function createItem(
  input: CreateItemInput,
  ctx: ItemContext,
): Promise<ItemDTO> {
  await connectMongo();
  await resolveItemType(ctx.orgId, input.itemTypeKey);

  // Attribute payload must conform to the ItemType's attributeSchema
  // — same validator the order-create path runs against line items.
  // Reusing it here means an Item the admin saves can never produce
  // an invalid order line downstream.
  const { attributes } = await validateLineAttributes({
    orgId: ctx.orgId,
    itemTypeKey: input.itemTypeKey,
    attributes: input.attributes ?? {},
    context: `Item "${input.name}"`,
  });

  try {
    const created = await Item.create({
      orgId: orgIdFilter(ctx.orgId),
      itemTypeKey: input.itemTypeKey,
      name: input.name,
      description: input.description ?? null,
      basePrice: input.basePrice ?? null,
      sku: input.sku ?? null,
      imageUrl: input.imageUrl ?? null,
      attributes,
      inventory: input.inventory ?? null,
      status: RecordState.ACTIVE,
      createdBy: {
        userId: new Types.ObjectId(ctx.actorId),
        name: ctx.actorName,
      },
      updatedBy: new Types.ObjectId(ctx.actorId),
    });
    return toDTO(created.toObject() as ItemDoc & { _id: Types.ObjectId });
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000
    ) {
      throw new ConflictError(
        `An item with SKU "${input.sku}" already exists. Pick a different SKU or update the existing item.`,
      );
    }
    throw err;
  }
}

export interface UpdateItemInput {
  name?: string;
  description?: string | null;
  basePrice?: { amount: number; currency: Currency } | null;
  sku?: string | null;
  imageUrl?: string | null;
  attributes?: Record<string, unknown>;
  inventory?: { available: number; reserved: number } | null;
}

export async function updateItem(
  id: string,
  input: UpdateItemInput,
  ctx: ItemContext,
): Promise<ItemDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) {
    throw new NotFoundError("Item not found");
  }
  // Load the existing row so we can validate `attributes` against the
  // (immutable) itemTypeKey it's bound to. Disallow itemTypeKey
  // changes — would invalidate snapshots on historical orders.
  const existing = await Item.findOne({
    _id: id,
    orgId: orgIdFilter(ctx.orgId),
  }).lean<ItemDoc & { _id: Types.ObjectId }>();
  if (!existing) throw new NotFoundError("Item not found");

  const update: Record<string, unknown> = {
    updatedBy: new Types.ObjectId(ctx.actorId),
  };
  if (input.name !== undefined) update.name = input.name;
  if (input.description !== undefined)
    update.description = input.description ?? null;
  if (input.basePrice !== undefined) update.basePrice = input.basePrice ?? null;
  if (input.sku !== undefined) update.sku = input.sku ?? null;
  if (input.imageUrl !== undefined) update.imageUrl = input.imageUrl ?? null;
  if (input.inventory !== undefined) update.inventory = input.inventory ?? null;
  if (input.attributes !== undefined) {
    const { attributes } = await validateLineAttributes({
      orgId: ctx.orgId,
      itemTypeKey: existing.itemTypeKey,
      attributes: input.attributes,
      context: `Item "${existing.name}"`,
    });
    update.attributes = attributes;
  }

  try {
    const updated = await Item.findOneAndUpdate(
      { _id: id, orgId: orgIdFilter(ctx.orgId) },
      { $set: update },
      { new: true, runValidators: true },
    ).lean<ItemDoc & { _id: Types.ObjectId }>();
    if (!updated) throw new NotFoundError("Item not found");
    return toDTO(updated);
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: number }).code === 11000
    ) {
      throw new ConflictError(
        `An item with SKU "${input.sku}" already exists.`,
      );
    }
    throw err;
  }
}

/** Soft-delete: sets `status: ARCHIVED` + records archivedAt. Existing
 *  orders that reference the row keep rendering via their snapshots. */
export async function archiveItem(
  id: string,
  ctx: ItemContext,
): Promise<ItemDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) {
    throw new NotFoundError("Item not found");
  }
  const updated = await Item.findOneAndUpdate(
    { _id: id, orgId: orgIdFilter(ctx.orgId) },
    {
      $set: {
        status: RecordState.ARCHIVED,
        archivedAt: new Date(),
        updatedBy: new Types.ObjectId(ctx.actorId),
      },
    },
    { new: true },
  ).lean<ItemDoc & { _id: Types.ObjectId }>();
  if (!updated) throw new NotFoundError("Item not found");
  return toDTO(updated);
}

export async function restoreItem(
  id: string,
  ctx: ItemContext,
): Promise<ItemDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) {
    throw new NotFoundError("Item not found");
  }
  const updated = await Item.findOneAndUpdate(
    { _id: id, orgId: orgIdFilter(ctx.orgId) },
    {
      $set: {
        status: RecordState.ACTIVE,
        archivedAt: null,
        updatedBy: new Types.ObjectId(ctx.actorId),
      },
    },
    { new: true },
  ).lean<ItemDoc & { _id: Types.ObjectId }>();
  if (!updated) throw new NotFoundError("Item not found");
  return toDTO(updated);
}
