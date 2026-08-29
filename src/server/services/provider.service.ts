import "server-only";


import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  RecordState,
  ServiceType,
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
    // `?? [CAR_RENTAL]` and `?? []` are load-bearing: `.lean()` does not
    // apply Mongoose defaults, so every provider row stored before these
    // fields existed arrives with no such keys. `[]` means "available to
    // every organization", which is exactly how the catalog behaved before.
    serviceTypes: doc.serviceTypes ?? [ServiceType.CAR_RENTAL],
    organizationIds: (doc.organizationIds ?? []).map(String),
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
 * Which is exactly what happened: orders created before the GridFS migration
 * carry `/providers/<key>-<hex>.<ext>`, whose bytes a later deploy destroyed,
 * so 19 AVIS orders and 3 SIXT orders render a broken image while the
 * Providers page — which reads the live document — renders fine.
 *
 * Resolving the logo live is NOT a new policy. It is already what happens for
 * the six seeded brands: `resolveProvider` ignores the snapshot's logo
 * whenever the id is in PROVIDER_SEED and uses the registry path instead,
 * which is why BUDGET and HERTZ never broke. This extends the same rule to
 * DB-backed providers, so behaviour stops depending on whether a brand
 * happens to be hardcoded.
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
 * list results, and threading a promise through its 23 call sites is how one
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

/**
 * The provider catalog, optionally narrowed to one service type and one
 * organization.
 *
 * BOTH FILTERS ARE OPT-IN AND BACKWARD-COMPATIBLE.
 *
 *   serviceType  — a row with no `serviceTypes` key predates the field and
 *                  is a car-rental supplier, so the CAR_RENTAL filter must
 *                  also match `$exists: false`. Without that, every
 *                  existing provider would vanish from the rental form the
 *                  moment this shipped.
 *
 *   organizationId — `organizationIds: []` means "available to every
 *                  organization", which is how the whole catalog behaves
 *                  today. Only a row with a NON-EMPTY list is restricted,
 *                  so an airline added for FlightBizz stays out of the
 *                  other two brands' dropdowns while every pre-existing
 *                  row keeps appearing for everyone. No backfill needed.
 *
 * Callers that pass neither get exactly the list they got before.
 */
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
  const and: Record<string, unknown>[] = [];
  if (query.serviceType) {
    and.push(
      query.serviceType === ServiceType.CAR_RENTAL
        ? {
            $or: [
              { serviceTypes: ServiceType.CAR_RENTAL },
              { serviceTypes: { $exists: false } },
              { serviceTypes: { $size: 0 } },
            ],
          }
        : { serviceTypes: query.serviceType },
    );
  }
  if (query.organizationId && Types.ObjectId.isValid(query.organizationId)) {
    and.push({
      $or: [
        { organizationIds: { $size: 0 } },
        { organizationIds: { $exists: false } },
        { organizationIds: new Types.ObjectId(query.organizationId) },
      ],
    });
  }
  if (and.length > 0) filter.$and = and;
  const docs = await Provider.find(filter)
    .sort({ sortOrder: 1, name: 1 })
    .lean<(ProviderDoc & { _id: Types.ObjectId })[]>();
  return docs.map(toDTO);
}

export async function listActiveProviders(
  opts: { serviceType?: ServiceType; organizationId?: string | null } = {},
): Promise<ProviderDTO[]> {
  return listProviders({
    status: RecordState.ACTIVE,
    serviceType: opts.serviceType,
    organizationId: opts.organizationId ?? undefined,
  });
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
    // Default applied HERE rather than in the zod schema, so the schema's
    // Input and Output types stay identical for react-hook-form. Omitting
    // the field creates the car-rental supplier it has always created.
    serviceTypes: input.serviceTypes ?? [ServiceType.CAR_RENTAL],
    // Empty = available to EVERY organization, matching how every
    // pre-existing catalog row behaves. A non-empty list restricts.
    organizationIds: (input.organizationIds ?? []).map(
      (oid) => new Types.ObjectId(oid),
    ),
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

  // Array fields are compared by VALUE, not by reference — the scalar loop
  // below uses `!==`, which is always true for two arrays and would mark
  // every update as a change (and defeat the "No changes to apply" guard).
  if (input.serviceTypes !== undefined) {
    const next = [...input.serviceTypes].sort();
    const prev = [...(doc.serviceTypes ?? [])].sort();
    if (JSON.stringify(next) !== JSON.stringify(prev)) {
      doc.serviceTypes = input.serviceTypes;
      changes.serviceTypes = input.serviceTypes;
    }
  }
  if (input.organizationIds !== undefined) {
    const next = [...input.organizationIds].sort();
    const prev = [...(doc.organizationIds ?? [])].map(String).sort();
    if (JSON.stringify(next) !== JSON.stringify(prev)) {
      doc.organizationIds = input.organizationIds.map(
        (oid) => new Types.ObjectId(oid),
      );
      changes.organizationIds = input.organizationIds;
    }
  }

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
  // Browser-supplied mime is attacker-controlled; sniff the bytes so
  // a mislabelled HTML/SVG payload can't reach disk under an image
  // extension and turn into stored XSS on the public path.
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
  // production — every repo-committed logo returned 200 while every
  // uploaded one (avis-563c9c0b.jpg, sixt-ace37dd4.jpg) returned 404.
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
  const staleId = assetIdFromUrl(previousLogo);
  if (staleId) await deleteAsset(staleId);

  return toDTO(doc.toObject() as ProviderDoc & { _id: Types.ObjectId });
}

export { MAX_LOGO_BYTES, ALLOWED_MIME };
