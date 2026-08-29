import "server-only";

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
  assetIdFromUrl,
  deleteAsset,
  putAsset,
} from "@/server/storage/asset-store";
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
import { bytesMatchMime } from "./file-sniff";

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
// SVG intentionally NOT allowed: SVG can carry inline <script> and runs
// same-origin when fetched directly, turning the public/providers folder
// into a stored-XSS sink. Rasterise to PNG/WebP upstream if needed.
const ALLOWED_MIME: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

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

// ─── Current-logo resolution ───────────────────────────────────────────────
/*
 * An order stores a SNAPSHOT of its provider, frozen at creation. That is
 * deliberate for brand IDENTITY (name, colours) — a receipt should show what
 * the customer actually saw. But a logo is not identity, it is a POINTER,
 * and freezing a pointer to mutable storage means the image dies the moment
 * the target moves.
 *
 * Which is exactly what happened here. Every logo uploaded before the asset
 * store existed was written to `public/providers/<key>-<hex>.<ext>` on the
 * container filesystem, and a later deploy destroyed the bytes. Worse, each
 * re-upload minted a NEW random suffix and repointed only the provider
 * document — so the two AVIS orders in production still carry
 * `/providers/avis-c49d1deb.png`, a path two uploads out of date, while the
 * Providers page reads the live document and renders fine.
 *
 * Resolving the logo live is NOT a new policy. It is already what happens
 * for the six seeded brands: `resolveProvider` ignores the snapshot's logo
 * whenever the id is in PROVIDER_SEED and uses the registry path instead,
 * which is why BUDGET and THRIFTY never broke while AVIS did. This extends
 * the same rule to DB-backed providers, so behaviour stops depending on
 * whether a brand happens to be hardcoded.
 *
 * Cached in-process: consulted once per order in a list render. Short TTL
 * plus explicit invalidation on every provider write, so a replaced logo is
 * visible immediately rather than after a timeout.
 */
const LOGO_CACHE_TTL_MS = 30_000;
let logoCache: { at: number; map: Map<string, string> } | null = null;

/** Drop the cache. Called after any write that can change a logo. */
export function invalidateProviderLogoCache(): void {
  logoCache = null;
}

/** Load current logos keyed by provider key. The catalog is a handful of
 *  small documents, and the result is cached. */
export async function warmProviderLogoCache(): Promise<void> {
  if (logoCache && Date.now() - logoCache.at < LOGO_CACHE_TTL_MS) return;
  await connectMongo();
  const rows = await Provider.find({})
    .select("key logo")
    .lean<{ key: string; logo: string }[]>();
  logoCache = {
    at: Date.now(),
    map: new Map(rows.map((r) => [r.key, r.logo])),
  };
}

/**
 * The provider's CURRENT logo, or null when the cache is cold or the
 * provider no longer exists — in which case the caller keeps the snapshot,
 * so a deleted provider still renders the brand the customer saw.
 *
 * Synchronous on purpose: `orderToDTO` is sync and runs in a tight map over
 * list results, and threading a promise through its call sites is how one
 * gets forgotten and a single surface silently keeps the dead value.
 * Callers `await warmProviderLogoCache()` once before mapping.
 */
export function currentProviderLogo(
  key: string | null | undefined,
): string | null {
  if (!key || !logoCache) return null;
  return logoCache.map.get(key) ?? null;
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
  invalidateProviderLogoCache();

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
  invalidateProviderLogoCache();

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
 * Persist a logo to the durable asset store and return the URL to save on
 * the provider document.
 */
export async function saveProviderLogoFile(
  input: SaveLogoInput,
): Promise<string> {
  if (!ALLOWED_MIME.has(input.mimeType)) {
    throw new ValidationError(
      "Unsupported image type. Use PNG, JPEG, WebP, or GIF.",
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
  // Browser-supplied mime is attacker-controlled; sniff the bytes so a
  // mislabelled HTML/SVG payload can't be stored under an image content
  // type and turn into stored XSS when served back from our own origin.
  if (!bytesMatchMime(input.buffer, input.mimeType)) {
    throw new ValidationError(
      "Uploaded file does not match the declared image type",
    );
  }
  const safeKey = input.key.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!safeKey) throw new ValidationError("Provider key is required");

  // Bytes go to the DURABLE asset store, not to `public/providers/`.
  //
  // The filesystem write this replaces produced a path that could never
  // resolve in production: Next serves `public/` from the build artifact, so
  // a file written at runtime is not served, and DigitalOcean rebuilds the
  // container on every deploy so it is destroyed anyway. Confirmed against
  // this deployment — every repo-committed logo returned 200 while every
  // uploaded one (avis-ab943ee7.png, ace_rent_a_car-61da56a5.jpg) returned
  // 404, including one uploaded five hours earlier.
  //
  // Size, mime allowlist and magic-byte sniffing above are unchanged; only
  // the destination moved.
  const stored = await putAsset({
    buffer: input.buffer,
    contentType: input.mimeType,
    label: safeKey,
    kind: "provider-logo",
  });
  return stored.url;
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
  invalidateProviderLogoCache();

  await recordAudit({
    action: AuditAction.PROVIDER_LOGO_REPLACED,
    entityType: AuditEntity.PROVIDER,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { previousLogo, nextLogo },
  });

  // Reclaim the superseded asset AFTER the document is safely repointed, so
  // a failed delete can never leave a provider pointing at bytes that are
  // gone. Only touches the asset store — a `/providers/*.png` value is a
  // repo-committed seed logo and must be left exactly where it is.
  //
  // Existing ORDERS are unaffected by this delete: `orderToDTO` resolves the
  // provider's current logo rather than trusting the frozen snapshot, so an
  // order that still carries the old id renders the new image.
  const staleId = assetIdFromUrl(previousLogo);
  if (staleId) await deleteAsset(staleId);

  return toDTO(doc.toObject() as ProviderDoc & { _id: Types.ObjectId });
}

export { MAX_LOGO_BYTES, ALLOWED_MIME };
