import "server-only";

import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  UserRole,
} from "@/lib/constants/enums";
import {
  ConflictError,
  NotFoundError,
} from "@/lib/errors";
import type {
  CreateCarLinkInput,
  ListCarLinksQuery,
  UpdateCarLinkInput,
} from "@/lib/validation";
import { CarLink, type CarLinkDoc } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import type { CarLinkDTO } from "@/types";

import type { RequestContext } from "@/server/api/request-context";
import { recordAudit } from "./audit.service";

interface CarLinkActor {
  id: string;
  name: string;
  role: UserRole;
}

interface CarLinkContext {
  actor: CarLinkActor;
  request?: RequestContext | null;
}

// ─── Mapping ───────────────────────────────────────────────────────────────

function toDTO(
  doc: CarLinkDoc & { _id: Types.ObjectId | string },
): CarLinkDTO {
  return {
    id: String(doc._id),
    carMake: doc.carMake,
    carType: doc.carType,
    label: `${doc.carMake} ${doc.carType}`.trim(),
    imageUrl: doc.imageUrl,
    notes: doc.notes ?? null,
    active: doc.active,
    createdBy: {
      userId: doc.createdBy?.userId
        ? String(doc.createdBy.userId)
        : null,
      name: doc.createdBy?.name ?? "Unknown",
    },
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// ─── List ──────────────────────────────────────────────────────────────────

export async function listCarLinks(
  query: ListCarLinksQuery,
): Promise<CarLinkDTO[]> {
  await connectMongo();
  const filter: Record<string, unknown> = {};
  if (!query.includeArchived) filter.active = true;
  if (query.q && query.q.length > 0) {
    // Case-insensitive prefix-style match across make + type so the
    // selector finds "toy" → Toyota, "cam" → Camry. Mongoose handles
    // the regex escape if we use a literal RegExp from a sanitized
    // string.
    const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(escaped, "i");
    filter.$or = [{ carMake: rx }, { carType: rx }, { notes: rx }];
  }
  const docs = await CarLink.find(filter)
    .sort({ updatedAt: -1 })
    .limit(query.limit)
    .lean<(CarLinkDoc & { _id: Types.ObjectId })[]>();
  return docs.map(toDTO);
}

export async function getCarLinkById(id: string): Promise<CarLinkDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) {
    throw new NotFoundError("Car link not found");
  }
  const doc = await CarLink.findById(id).lean<
    CarLinkDoc & { _id: Types.ObjectId }
  >();
  if (!doc) throw new NotFoundError("Car link not found");
  return toDTO(doc);
}

// ─── Mutations ─────────────────────────────────────────────────────────────

export async function createCarLink(
  input: CreateCarLinkInput,
  ctx: CarLinkContext,
): Promise<CarLinkDTO> {
  await connectMongo();
  try {
    const doc = await CarLink.create({
      carMake: input.carMake,
      carType: input.carType,
      imageUrl: input.imageUrl,
      notes: input.notes ?? null,
      active: true,
      createdBy: {
        userId: new Types.ObjectId(ctx.actor.id),
        name: ctx.actor.name,
      },
    });
    await recordAudit({
      action: AuditAction.CAR_LINK_CREATED,
      entityType: AuditEntity.CAR_LINK,
      entityId: String(doc._id),
      actor: {
        userId: ctx.actor.id,
        name: ctx.actor.name,
        role: ctx.actor.role,
      },
      request: ctx.request ?? null,
      metadata: {
        carMake: input.carMake,
        carType: input.carType,
      },
    });
    return toDTO(doc.toObject() as CarLinkDoc & { _id: Types.ObjectId });
  } catch (err) {
    if (err instanceof Error && err.message.includes("duplicate key")) {
      throw new ConflictError(
        "This car link already exists in the library",
      );
    }
    throw err;
  }
}

export async function updateCarLink(
  id: string,
  input: UpdateCarLinkInput,
  ctx: CarLinkContext,
): Promise<CarLinkDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) {
    throw new NotFoundError("Car link not found");
  }
  const set: Record<string, unknown> = {};
  if (input.carMake !== undefined) set.carMake = input.carMake;
  if (input.carType !== undefined) set.carType = input.carType;
  if (input.imageUrl !== undefined) set.imageUrl = input.imageUrl;
  if (input.notes !== undefined) set.notes = input.notes ?? null;
  if (Object.keys(set).length === 0) {
    return getCarLinkById(id);
  }
  const doc = await CarLink.findByIdAndUpdate(
    id,
    { $set: set },
    { returnDocument: "after" },
  ).lean<CarLinkDoc & { _id: Types.ObjectId }>();
  if (!doc) throw new NotFoundError("Car link not found");
  await recordAudit({
    action: AuditAction.CAR_LINK_UPDATED,
    entityType: AuditEntity.CAR_LINK,
    entityId: String(doc._id),
    actor: {
      userId: ctx.actor.id,
      name: ctx.actor.name,
      role: ctx.actor.role,
    },
    request: ctx.request ?? null,
    metadata: { changes: set },
  });
  return toDTO(doc);
}

export async function deactivateCarLink(
  id: string,
  ctx: CarLinkContext,
): Promise<CarLinkDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) {
    throw new NotFoundError("Car link not found");
  }
  const doc = await CarLink.findByIdAndUpdate(
    id,
    { $set: { active: false } },
    { returnDocument: "after" },
  ).lean<CarLinkDoc & { _id: Types.ObjectId }>();
  if (!doc) throw new NotFoundError("Car link not found");
  await recordAudit({
    action: AuditAction.CAR_LINK_DEACTIVATED,
    entityType: AuditEntity.CAR_LINK,
    entityId: String(doc._id),
    actor: {
      userId: ctx.actor.id,
      name: ctx.actor.name,
      role: ctx.actor.role,
    },
    request: ctx.request ?? null,
  });
  return toDTO(doc);
}

export async function restoreCarLink(
  id: string,
  ctx: CarLinkContext,
): Promise<CarLinkDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) {
    throw new NotFoundError("Car link not found");
  }
  const doc = await CarLink.findByIdAndUpdate(
    id,
    { $set: { active: true } },
    { returnDocument: "after" },
  ).lean<CarLinkDoc & { _id: Types.ObjectId }>();
  if (!doc) throw new NotFoundError("Car link not found");
  await recordAudit({
    action: AuditAction.CAR_LINK_RESTORED,
    entityType: AuditEntity.CAR_LINK,
    entityId: String(doc._id),
    actor: {
      userId: ctx.actor.id,
      name: ctx.actor.name,
      role: ctx.actor.role,
    },
    request: ctx.request ?? null,
  });
  return toDTO(doc);
}
