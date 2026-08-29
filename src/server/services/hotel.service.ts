import "server-only";

import { Types } from "mongoose";

import { AuditAction, AuditEntity, UserRole } from "@/lib/constants/enums";
import { ConflictError, NotFoundError } from "@/lib/errors";
import type {
  CreateHotelInput,
  ListHotelsQuery,
  UpdateHotelInput,
} from "@/lib/validation";
/**
 * NOTE: the hotel catalog is deliberately NOT organization-scoped.
 *
 * Same rule as the car library (see car-link.service.ts and commit
 * 4ee5690): it is reference data about the world, not about a tenant. The
 * Hilton in Dubai is the same property whichever brand books it, and a
 * catalog row grants access to nothing. Tenancy lives on the ORDER, which
 * carries `organizationId` and is scoped at every read site.
 */
import { Hotel, type HotelDoc } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import type { HotelDTO } from "@/types";

import type { RequestContext } from "@/server/api/request-context";
import { recordAudit } from "./audit.service";

interface HotelActor {
  id: string;
  name: string;
  role: UserRole;
}

interface HotelContext {
  actor: HotelActor;
  request?: RequestContext | null;
}

// ─── Mapping ───────────────────────────────────────────────────────────────

function toDTO(doc: HotelDoc & { _id: Types.ObjectId | string }): HotelDTO {
  const images = [...(doc.images ?? [])]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((img) => ({
      url: img.url,
      caption: img.caption ?? null,
      sortOrder: img.sortOrder,
    }));
  return {
    id: String(doc._id),
    name: doc.name,
    description: doc.description ?? null,
    location: {
      city: doc.location.city,
      country: doc.location.country,
      address: doc.location.address ?? null,
    },
    /** Pre-composed so selectors and order snapshots agree on one string. */
    label: `${doc.name} — ${doc.location.city}`,
    amenities: doc.amenities ?? [],
    images,
    /** Convenience for list rows that show a single thumbnail. */
    primaryImageUrl: images[0]?.url ?? null,
    starRating: doc.starRating ?? null,
    notes: doc.notes ?? null,
    active: doc.active,
    createdBy: {
      userId: doc.createdBy?.userId ? String(doc.createdBy.userId) : null,
      name: doc.createdBy?.name ?? "Unknown",
    },
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** Stamp an explicit ascending order when the caller omitted one, so the
 *  stored array has a stable, meaningful sequence. */
function normaliseImages(
  images: CreateHotelInput["images"],
): { url: string; caption: string | null; sortOrder: number }[] {
  return (images ?? []).map((img, i) => ({
    url: img.url,
    caption: img.caption ?? null,
    sortOrder: img.sortOrder ?? i,
  }));
}

// ─── List ──────────────────────────────────────────────────────────────────

export async function listHotels(query: ListHotelsQuery): Promise<HotelDTO[]> {
  await connectMongo();
  const filter: Record<string, unknown> = {};
  if (!query.includeArchived) filter.active = true;
  if (query.city && query.city.length > 0) {
    const escaped = query.city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter["location.city"] = new RegExp(`^${escaped}$`, "i");
  }
  if (query.q && query.q.length > 0) {
    // Same sanitize-then-RegExp approach as listCarLinks: cap the input at
    // the schema layer and escape metacharacters so an operator cannot
    // trigger catastrophic backtracking on Mongo's regex engine.
    const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(escaped, "i");
    filter.$or = [
      { name: rx },
      { "location.city": rx },
      { "location.country": rx },
    ];
  }
  const docs = await Hotel.find(filter)
    .sort({ updatedAt: -1 })
    .limit(query.limit)
    .lean<(HotelDoc & { _id: Types.ObjectId })[]>();
  return docs.map(toDTO);
}

export async function getHotelById(id: string): Promise<HotelDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Hotel not found");
  const doc = await Hotel.findById(id).lean<
    HotelDoc & { _id: Types.ObjectId }
  >();
  if (!doc) throw new NotFoundError("Hotel not found");
  return toDTO(doc);
}

// ─── Mutations ─────────────────────────────────────────────────────────────

export async function createHotel(
  input: CreateHotelInput,
  ctx: HotelContext,
): Promise<HotelDTO> {
  await connectMongo();

  // Pre-check for a friendly error. The `hotels_dedupe` unique index is the
  // real guard against a concurrent double-insert; this just turns the
  // common case into a readable message instead of an E11000.
  const existing = await Hotel.findOne({
    name: new RegExp(
      `^${input.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      "i",
    ),
    "location.city": new RegExp(
      `^${input.location.city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      "i",
    ),
  }).lean<{ _id: Types.ObjectId } | null>();
  if (existing) {
    throw new ConflictError(
      `${input.name} in ${input.location.city} is already in the hotel catalog`,
    );
  }

  const doc = await Hotel.create({
    name: input.name,
    description: input.description ?? null,
    location: {
      city: input.location.city,
      country: input.location.country,
      address: input.location.address ?? null,
    },
    amenities: input.amenities ?? [],
    images: normaliseImages(input.images),
    starRating: input.starRating ?? null,
    notes: input.notes ?? null,
    active: true,
    createdBy: {
      userId: new Types.ObjectId(ctx.actor.id),
      name: ctx.actor.name,
    },
  });

  await recordAudit({
    action: AuditAction.HOTEL_CREATED,
    entityType: AuditEntity.HOTEL,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: {
      name: input.name,
      city: input.location.city,
      imageCount: (input.images ?? []).length,
    },
  });

  return toDTO(
    doc.toObject({ getters: false }) as HotelDoc & { _id: Types.ObjectId },
  );
}

export async function updateHotel(
  id: string,
  input: UpdateHotelInput,
  ctx: HotelContext,
): Promise<HotelDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Hotel not found");
  const doc = await Hotel.findById(id);
  if (!doc) throw new NotFoundError("Hotel not found");

  const changes: Record<string, unknown> = {};

  if (input.name !== undefined && input.name !== doc.name) {
    doc.name = input.name;
    changes.name = input.name;
  }
  if (input.description !== undefined && input.description !== doc.description) {
    doc.description = input.description;
    changes.description = input.description;
  }
  if (input.starRating !== undefined && input.starRating !== doc.starRating) {
    doc.starRating = input.starRating ?? null;
    changes.starRating = input.starRating ?? null;
  }
  if (input.notes !== undefined && input.notes !== doc.notes) {
    doc.notes = input.notes;
    changes.notes = input.notes;
  }
  if (input.location !== undefined) {
    const next = {
      city: input.location.city,
      country: input.location.country,
      address: input.location.address ?? null,
    };
    if (JSON.stringify(next) !== JSON.stringify(doc.location)) {
      doc.location = next;
      changes.location = next;
    }
  }
  // Arrays compared BY VALUE — `!==` on two arrays is always true and would
  // mark every save as a change, defeating the no-op guard below.
  if (input.amenities !== undefined) {
    if (
      JSON.stringify([...input.amenities].sort()) !==
      JSON.stringify([...(doc.amenities ?? [])].sort())
    ) {
      doc.amenities = input.amenities;
      changes.amenities = input.amenities;
    }
  }
  if (input.images !== undefined) {
    const next = normaliseImages(input.images);
    const prev = (doc.images ?? []).map((i) => ({
      url: i.url,
      caption: i.caption ?? null,
      sortOrder: i.sortOrder,
    }));
    if (JSON.stringify(next) !== JSON.stringify(prev)) {
      doc.images = next;
      changes.images = next;
    }
  }

  if (Object.keys(changes).length === 0) {
    throw new ConflictError("No changes to apply");
  }

  await doc.save();

  await recordAudit({
    action: AuditAction.HOTEL_UPDATED,
    entityType: AuditEntity.HOTEL,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { changes: Object.keys(changes) },
  });

  return toDTO(
    doc.toObject({ getters: false }) as HotelDoc & { _id: Types.ObjectId },
  );
}

/** Soft delete. Historical orders keep rendering the label they captured. */
export async function deactivateHotel(
  id: string,
  ctx: HotelContext,
): Promise<HotelDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Hotel not found");
  const doc = await Hotel.findById(id);
  if (!doc) throw new NotFoundError("Hotel not found");
  if (!doc.active) return toDTO(doc.toObject() as HotelDoc & { _id: Types.ObjectId });

  doc.active = false;
  await doc.save();

  await recordAudit({
    action: AuditAction.HOTEL_DEACTIVATED,
    entityType: AuditEntity.HOTEL,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { name: doc.name },
  });

  return toDTO(
    doc.toObject({ getters: false }) as HotelDoc & { _id: Types.ObjectId },
  );
}

export async function restoreHotel(
  id: string,
  ctx: HotelContext,
): Promise<HotelDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Hotel not found");
  const doc = await Hotel.findById(id);
  if (!doc) throw new NotFoundError("Hotel not found");
  if (doc.active) return toDTO(doc.toObject() as HotelDoc & { _id: Types.ObjectId });

  doc.active = true;
  await doc.save();

  await recordAudit({
    action: AuditAction.HOTEL_RESTORED,
    entityType: AuditEntity.HOTEL,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { name: doc.name },
  });

  return toDTO(
    doc.toObject({ getters: false }) as HotelDoc & { _id: Types.ObjectId },
  );
}
