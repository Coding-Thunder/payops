import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  PROVIDER_KEY_REGEX,
  PROVIDER_SEED,
  type ProviderSnapshot,
} from "@/lib/constants/providers";
import type {
  CreateProviderInput,
  ListProvidersQuery,
  SetProviderStatusInput,
  UpdateProviderInput,
} from "@/lib/validation";
import { Provider, type ProviderDoc } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import type { ProviderDTO } from "@/types";

import type { RequestContext } from "@/server/api/request-context";
import { recordAudit } from "./audit.service";

interface ProviderActor {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

interface ProviderContext {
  actor: ProviderActor;
  request?: RequestContext | null;
}

// ─── Upload constraints ────────────────────────────────────────────────────

const MAX_LOGO_BYTES = 512 * 1024; // 512KB
const ALLOWED_MIME: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/svg+xml", "svg"],
]);

const PUBLIC_DIR = path.join(process.cwd(), "public");
const PROVIDERS_DIR = path.join(PUBLIC_DIR, "providers");

// ─── Mapping ───────────────────────────────────────────────────────────────

function toDTO(doc: ProviderDoc & { _id: Types.ObjectId | string }): ProviderDTO {
  return {
    id: String(doc._id),
    key: doc.key,
    name: doc.name,
    logo: doc.logo,
    primaryColor: doc.primaryColor,
    onPrimaryColor: doc.onPrimaryColor,
    tagline: doc.tagline ?? "",
    status: doc.status,
    sortOrder: doc.sortOrder,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function toSnapshot(doc: ProviderDoc): ProviderSnapshot {
  return {
    id: doc.key,
    name: doc.name,
    logo: doc.logo,
    primaryColor: doc.primaryColor,
    onPrimaryColor: doc.onPrimaryColor,
  };
}

// ─── Seeding ───────────────────────────────────────────────────────────────

/**
 * Populate the catalog from `PROVIDER_SEED` on first read so the app is
 * never empty after a clean install. Inserts are idempotent — re-seeding
 * only adds keys that don't exist yet. The existence check is a single
 * projection-only query, cheap enough to run on every list-shaped path
 * (and re-runs correctly across test databases that share the process).
 */
export async function ensureSeedProviders(): Promise<void> {
  await connectMongo();
  const existingKeys = new Set(
    (await Provider.find({}, { key: 1 }).lean<{ key: string }[]>()).map(
      (p) => p.key,
    ),
  );
  const toInsert = Object.values(PROVIDER_SEED)
    .filter((p) => !existingKeys.has(p.id))
    .map((p, idx) => ({
      key: p.id,
      name: p.name,
      logo: p.logo,
      primaryColor: p.primaryColor,
      onPrimaryColor: p.onPrimaryColor,
      tagline: p.tagline,
      status: RecordState.ACTIVE,
      sortOrder: idx,
    }));
  if (toInsert.length === 0) return;
  await Provider.insertMany(toInsert, { ordered: false }).catch((err) => {
    logger.warn("providers.seed_partial", {
      err: err instanceof Error ? err.message : String(err),
    });
  });
  logger.info("providers.seeded", { count: toInsert.length });
}

// ─── Listing ───────────────────────────────────────────────────────────────

export async function listProviders(
  query: ListProvidersQuery = {},
): Promise<ProviderDTO[]> {
  await ensureSeedProviders();
  const filter: Record<string, unknown> = {};
  if (query.status) {
    filter.status = query.status;
  } else if (!query.includeAll) {
    filter.status = RecordState.ACTIVE;
  }
  const docs = await Provider.find(filter)
    .sort({ sortOrder: 1, name: 1 })
    .lean<(ProviderDoc & { _id: Types.ObjectId })[]>();
  return docs.map(toDTO);
}

export async function listActiveProviders(): Promise<ProviderDTO[]> {
  return listProviders({ status: RecordState.ACTIVE });
}

export async function getProviderById(id: string): Promise<ProviderDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Provider not found");
  const doc = await Provider.findById(id).lean<
    ProviderDoc & { _id: Types.ObjectId }
  >();
  if (!doc) throw new NotFoundError("Provider not found");
  return toDTO(doc);
}

export async function getProviderByKey(key: string): Promise<ProviderDoc | null> {
  await connectMongo();
  return Provider.findOne({ key: key.toUpperCase() });
}

/**
 * Resolve a snapshot to attach to a newly-created order. Throws if the
 * provider key doesn't exist or is not ACTIVE — keeps stale references off
 * new orders without locking up the catalog when an admin disables a brand.
 */
export async function buildProviderSnapshotFromKey(
  key: string,
): Promise<ProviderSnapshot> {
  await ensureSeedProviders();
  const normalised = key.trim().toUpperCase();
  if (!PROVIDER_KEY_REGEX.test(normalised)) {
    throw new ValidationError("That provider id is malformed");
  }
  const doc = await Provider.findOne({ key: normalised }).lean<ProviderDoc>();
  if (!doc) throw new ValidationError("Unknown rental provider");
  if (doc.status !== RecordState.ACTIVE) {
    throw new ValidationError("That provider is currently disabled");
  }
  return toSnapshot(doc);
}

// ─── Mutations ─────────────────────────────────────────────────────────────

export async function createProvider(
  input: CreateProviderInput,
  ctx: ProviderContext,
): Promise<ProviderDTO> {
  await connectMongo();
  const key = input.key.toUpperCase();
  const existing = await Provider.exists({ key });
  if (existing) {
    throw new ConflictError(`A provider with key ${key} already exists`);
  }
  const doc = await Provider.create({
    key,
    name: input.name,
    logo: input.logo,
    primaryColor: input.primaryColor,
    onPrimaryColor: input.onPrimaryColor,
    tagline: input.tagline,
    sortOrder: input.sortOrder,
    status: RecordState.ACTIVE,
    createdBy: new Types.ObjectId(ctx.actor.id),
    updatedBy: new Types.ObjectId(ctx.actor.id),
  });

  await recordAudit({
    action: AuditAction.PROVIDER_CREATED,
    entityType: AuditEntity.PROVIDER,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { key, name: input.name },
  });

  return toDTO(doc.toObject() as ProviderDoc & { _id: Types.ObjectId });
}

export async function updateProvider(
  id: string,
  input: UpdateProviderInput,
  ctx: ProviderContext,
): Promise<ProviderDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Provider not found");
  const doc = await Provider.findById(id);
  if (!doc) throw new NotFoundError("Provider not found");

  const changes: Record<string, unknown> = {};
  for (const field of [
    "name",
    "logo",
    "primaryColor",
    "onPrimaryColor",
    "tagline",
    "sortOrder",
  ] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (doc[field] !== value) {
      // Mongoose typing on assignment via index isn't tight enough here;
      // the field whitelist above keeps this safe.
      (doc as unknown as Record<string, unknown>)[field] = value;
      changes[field] = value;
    }
  }
  if (Object.keys(changes).length === 0) {
    throw new ValidationError("No changes to apply");
  }
  doc.updatedBy = new Types.ObjectId(ctx.actor.id);
  await doc.save();

  await recordAudit({
    action: AuditAction.PROVIDER_UPDATED,
    entityType: AuditEntity.PROVIDER,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { changes },
  });

  return toDTO(doc.toObject() as ProviderDoc & { _id: Types.ObjectId });
}

export async function setProviderStatus(
  id: string,
  input: SetProviderStatusInput,
  ctx: ProviderContext,
): Promise<ProviderDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Provider not found");
  const doc = await Provider.findById(id);
  if (!doc) throw new NotFoundError("Provider not found");

  if (doc.status === input.status) {
    throw new ValidationError(`Provider is already ${input.status.toLowerCase()}`);
  }
  doc.status = input.status;
  doc.updatedBy = new Types.ObjectId(ctx.actor.id);
  await doc.save();

  await recordAudit({
    action:
      input.status === RecordState.ARCHIVED
        ? AuditAction.PROVIDER_ARCHIVED
        : AuditAction.PROVIDER_STATUS_CHANGED,
    entityType: AuditEntity.PROVIDER,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { status: input.status },
  });

  return toDTO(doc.toObject() as ProviderDoc & { _id: Types.ObjectId });
}

export async function archiveProvider(
  id: string,
  ctx: ProviderContext,
): Promise<ProviderDTO> {
  return setProviderStatus(id, { status: RecordState.ARCHIVED }, ctx);
}

// ─── Logo upload ───────────────────────────────────────────────────────────

interface SaveLogoInput {
  key: string;
  buffer: Buffer;
  mimeType: string;
}

/**
 * Persist a logo file to `public/providers/` and return its public path.
 *
 * Naming: `<key-lowercase>-<random>.<ext>`. The random suffix forces email
 * clients + CDNs to bypass cache for any new upload, and means we can keep
 * the previous file in place so historical order snapshots that reference
 * it keep rendering.
 */
export async function saveProviderLogoFile(
  input: SaveLogoInput,
): Promise<string> {
  if (!ALLOWED_MIME.has(input.mimeType)) {
    throw new ValidationError(
      "Unsupported image type. Use PNG, JPEG, WebP, GIF, or SVG.",
    );
  }
  if (input.buffer.byteLength === 0) {
    throw new ValidationError("Logo file is empty");
  }
  if (input.buffer.byteLength > MAX_LOGO_BYTES) {
    throw new ValidationError(
      `Logo file is larger than ${Math.round(MAX_LOGO_BYTES / 1024)}KB`,
    );
  }
  const ext = ALLOWED_MIME.get(input.mimeType)!;
  const safeKey = input.key.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!safeKey) throw new ValidationError("Provider key is required");
  const suffix = randomBytes(4).toString("hex");
  const fileName = `${safeKey}-${suffix}.${ext}`;
  // Resolve + verify the final path is still inside PROVIDERS_DIR. Belt-
  // and-braces guard against path-traversal via a hostile `key`.
  const fullPath = path.join(PROVIDERS_DIR, fileName);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(PROVIDERS_DIR) + path.sep)) {
    throw new ValidationError("Invalid file path");
  }
  await fs.mkdir(PROVIDERS_DIR, { recursive: true });
  await fs.writeFile(resolved, input.buffer);
  return `/providers/${fileName}`;
}

/**
 * Replace the logo for an existing provider. The file write happens first;
 * if it fails the DB is untouched.
 */
export async function replaceProviderLogo(
  id: string,
  file: { buffer: Buffer; mimeType: string },
  ctx: ProviderContext,
): Promise<ProviderDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Provider not found");
  const doc = await Provider.findById(id);
  if (!doc) throw new NotFoundError("Provider not found");

  const previousLogo = doc.logo;
  const nextLogo = await saveProviderLogoFile({
    key: doc.key,
    buffer: file.buffer,
    mimeType: file.mimeType,
  });

  doc.logo = nextLogo;
  doc.updatedBy = new Types.ObjectId(ctx.actor.id);
  await doc.save();

  await recordAudit({
    action: AuditAction.PROVIDER_LOGO_REPLACED,
    entityType: AuditEntity.PROVIDER,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { previousLogo, nextLogo },
  });

  return toDTO(doc.toObject() as ProviderDoc & { _id: Types.ObjectId });
}

export { MAX_LOGO_BYTES, ALLOWED_MIME };
