import "server-only";

import { createHash } from "node:crypto";

import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  UserRole,
} from "@/lib/constants/enums";
import { ValidationError } from "@/lib/errors";
import { env } from "@/lib/env";
import {
  Branding,
  BRANDING_KEY,
  Organization,
  User,
  type BrandingDoc,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { loadScopedSingleton } from "@/server/db/org/scoped-singleton";
import { orgIdFilter } from "@/server/db/org/org-context";
import type { UpdateBrandingInput } from "@/lib/validation";
import type { BrandingDTO } from "@/types";

import type { RequestContext } from "@/server/api/request-context";
import { recordAudit } from "./audit.service";
import { bytesMatchMime } from "./file-sniff";

interface BrandingActor {
  id: string;
  name: string;
  role: UserRole;
}

interface BrandingContext {
  actor: BrandingActor;
  /** Active organization. When supplied, reads/writes target the
   *  per-org branding row (lazy-provisioned on first access). When
   *  omitted, the legacy `{ key: "default" }` singleton is used -
   *  preserved for back-compat with un-migrated callers. */
  orgId?: string | null;
  request?: RequestContext | null;
}

// ─── Upload constraints ────────────────────────────────────────────────────

const MAX_LOGO_BYTES = 512 * 1024;
// SVG intentionally NOT allowed: SVG can carry inline <script> and runs
// same-origin when fetched directly, turning the public/branding folder
// into a stored-XSS sink. Rasterise to PNG/WebP upstream if needed.
const ALLOWED_MIME: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

// ─── Mapping ───────────────────────────────────────────────────────────────

function toDTO(doc: BrandingDoc): BrandingDTO {
  return {
    brandName: doc.brandName,
    supportEmail: doc.supportEmail,
    supportPhone: doc.supportPhone,
    senderEmail: doc.senderEmail ?? "",
    logo: doc.logo ?? "",
    primaryColor: doc.primaryColor,
    footerTagline: doc.footerTagline ?? "",
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// ─── Legacy single-tenant defaults (back-compat shim) ──────────────────────
//
// Used ONLY by the no-orgId path, which is preserved for un-migrated
// callers and the legacy `{ key: "default" }` singleton row. The
// multi-tenant seed path below does NOT read these, every tenant's
// brand is derived from their own Organization + founder data.

function platformFallback(): Omit<BrandingDTO, "updatedAt"> {
  const e = env.server;
  return {
    brandName: e.CUSTOMER_BRAND_NAME,
    supportEmail: e.SUPPORT_EMAIL,
    supportPhone: e.SUPPORT_PHONE,
    senderEmail: "",
    logo: "",
    primaryColor: "#0B1220",
    footerTagline: "",
  };
}

/** Build the seed payload for a fresh per-org branding row using ONLY
 *  data owned by that tenant, never env defaults. The tenant's
 *  business identity (brand name, support email, support phone, logo,
 *  colors, footer) is fully theirs from row #1; cross-tenant env
 *  defaults would leak the platform's previous tenant brand into
 *  every newly provisioned org's emails.
 *
 *  Seed sources:
 *    - brandName     ← Organization.name (collected at signup)
 *    - supportEmail  ← founder User.email (the owner who signed up)
 *    - supportPhone  ← empty (admin fills in /app/admin/branding)
 *    - primaryColor  ← neutral platform-default (#0B1220), not a
 *                      brand decision, just a placeholder until the
 *                      admin picks one. Safe because it doesn't
 *                      identify any specific tenant.
 *    - logo          ← empty (admin uploads in /app/admin/branding)
 *    - footerTagline ← empty
 *
 *  MUST NOT include `key`. */
function seedBrandingFromOrg(input: {
  orgName: string;
  founderEmail: string;
}): Record<string, unknown> {
  return {
    brandName: input.orgName.trim(),
    supportEmail: input.founderEmail.trim().toLowerCase(),
    supportPhone: "",
    // senderEmail empty means "use platform default From". The tenant
    // can switch to their own address once SPF/DKIM is set up.
    senderEmail: "",
    primaryColor: "#0B1220",
    logo: "",
    footerTagline: "",
  };
}

/** Fetch the org name + founder email needed to seed a fresh per-org
 *  branding row. Throws if either piece is missing, a tenant without
 *  a name or founder is a corrupt provisioning, not a recoverable
 *  state, and silently falling back to env would re-introduce the
 *  cross-tenant leak this whole refactor exists to prevent. */
async function readOrgSeedSource(
  orgId: string,
): Promise<{ orgName: string; founderEmail: string }> {
  const org = await Organization.findById(orgId)
    .select({ name: 1, ownerUserId: 1 })
    .lean<{ name: string; ownerUserId: unknown }>();
  if (!org) {
    throw new Error(`Cannot seed branding: Organization ${orgId} not found`);
  }
  const owner = await User.findById(org.ownerUserId)
    .select({ email: 1 })
    .lean<{ email: string }>();
  if (!owner) {
    throw new Error(
      `Cannot seed branding: founder for org ${orgId} not found`,
    );
  }
  return { orgName: org.name, founderEmail: owner.email };
}

/**
 * Idempotent upsert. On first run, attempts to migrate any
 * `supportEmail`/`supportPhone` already saved on the legacy Settings doc
 * so admins who edited those (and silently lost them) don't have to
 * re-enter on the new screen.
 *
 * When `orgId` is supplied the per-org row is lazy-provisioned; when
 * omitted the legacy `{ key: "default" }` singleton is upserted -
 * preserved for back-compat through the multi-tenant migration window.
 */
export async function ensureBrandingDocument(
  orgId?: string | null,
): Promise<BrandingDoc> {
  await connectMongo();
  if (orgId) {
    // Fast-path: per-org row already exists. Read it directly so the
    // happy case (every email send for an established tenant) doesn't
    // pay the seed-source fetch cost.
    const existing = await Branding.findOne({
      orgId: orgIdFilter(orgId),
    }).lean<BrandingDoc>();
    if (existing) return existing;

    // Slow path (first access for this tenant): fetch the seed source
    // and provision. loadScopedSingleton handles the concurrency race
    // on the orgId unique index, two parallel first-access calls
    // won't produce duplicate rows.
    const seedSource = await readOrgSeedSource(orgId);
    const doc = await loadScopedSingleton<BrandingDoc>(Branding, {
      orgId,
      legacyKeyField: "key",
      legacyKeyValue: BRANDING_KEY,
      seedFor: () => seedBrandingFromOrg(seedSource),
    });
    if (!doc) throw new Error("Failed to load branding document for org");
    return doc;
  }
  // Late import keeps this service stand-alone for tests that don't load
  // the Settings model.
  const { Setting, SETTINGS_KEY } = await import("@/server/db/models");
  const defaults = platformFallback();

  const legacySettings = await Setting.findOne({ key: SETTINGS_KEY }).lean<{
    supportEmail?: string;
    supportPhone?: string;
  } | null>();

  const doc = await Branding.findOneAndUpdate(
    { key: BRANDING_KEY },
    {
      $setOnInsert: {
        key: BRANDING_KEY,
        brandName: defaults.brandName,
        supportEmail:
          legacySettings?.supportEmail?.trim() || defaults.supportEmail,
        supportPhone:
          legacySettings?.supportPhone?.trim() || defaults.supportPhone,
        primaryColor: defaults.primaryColor,
        logo: "",
        footerTagline: "",
      },
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true },
  ).lean<BrandingDoc>();
  if (!doc) throw new Error("Failed to load branding document");
  return doc;
}

// ─── Read ──────────────────────────────────────────────────────────────────

export async function getBranding(orgId?: string | null): Promise<BrandingDTO> {
  const doc = await ensureBrandingDocument(orgId);
  return toDTO(doc);
}

// ─── Update ────────────────────────────────────────────────────────────────

export async function updateBranding(
  input: UpdateBrandingInput,
  ctx: BrandingContext,
): Promise<BrandingDTO> {
  const existing = await ensureBrandingDocument(ctx.orgId ?? null);

  // Diff against current so the audit row carries actual changes only.
  // Empty input or a no-op (all values match) errors out, mirroring the
  // settings flow.
  const changes: Record<string, unknown> = {};
  for (const field of [
    "brandName",
    "supportEmail",
    "supportPhone",
    "senderEmail",
    "primaryColor",
    "footerTagline",
    "logo",
  ] as const) {
    const next = input[field];
    if (next === undefined) continue;
    if (existing[field] !== next) {
      changes[field] = next;
    }
  }
  if (Object.keys(changes).length === 0) {
    throw new ValidationError("No changes to apply");
  }

  // Per-org row when ctx carries orgId; legacy singleton otherwise.
  const updateFilter = ctx.orgId
    ? { orgId: orgIdFilter(ctx.orgId) }
    : { key: BRANDING_KEY };
  const updated = await Branding.findOneAndUpdate(
    updateFilter,
    {
      $set: { ...changes, updatedBy: new Types.ObjectId(ctx.actor.id) },
    },
    { returnDocument: "after" },
  ).lean<BrandingDoc>();
  if (!updated) throw new Error("Branding document missing after update");

  await recordAudit({
    action: AuditAction.BRANDING_UPDATED,
    entityType: AuditEntity.BRANDING,
    entityId: ctx.orgId ?? BRANDING_KEY,
    orgId: ctx.orgId ?? null,
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { changes },
  });

  return toDTO(updated);
}

// ─── Logo upload ───────────────────────────────────────────────────────────

interface SaveLogoInput {
  buffer: Buffer;
  mimeType: string;
}

interface ValidatedLogo {
  buffer: Buffer;
  mimeType: string;
  ext: string;
  /** Content hash, used as the URL's cache-busting segment so updates
   *  invalidate aggressively-cached customer-facing copies. */
  hash: string;
}

function validateLogoUpload(input: SaveLogoInput): ValidatedLogo {
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
  // The browser-supplied `mimeType` is attacker-controlled. Sniff the
  // bytes and confirm they match the declared type before storing, an
  // HTML/SVG payload labelled image/png that the route hands back with
  // the declared Content-Type would otherwise be stored XSS the moment
  // anyone opens the URL directly.
  if (!bytesMatchMime(input.buffer, input.mimeType)) {
    throw new ValidationError(
      "Uploaded file does not match the declared image type",
    );
  }
  const ext = ALLOWED_MIME.get(input.mimeType)!;
  const hash = createHash("sha256")
    .update(input.buffer)
    .digest("hex")
    .slice(0, 16);
  return { buffer: input.buffer, mimeType: input.mimeType, ext, hash };
}

function buildLogoUrl(orgId: string | null, hash: string, ext: string): string {
  // Per-org URL. The hash + ext are cosmetic, they're cache-busters,
  // not part of the lookup. The route always serves the current bytes
  // stored on the Branding doc for that orgId.
  const key = orgId ?? BRANDING_KEY;
  return `/api/branding/logo/${key}/${hash}.${ext}`;
}

export async function replaceBrandingLogo(
  file: { buffer: Buffer; mimeType: string },
  ctx: BrandingContext,
): Promise<BrandingDTO> {
  const existing = await ensureBrandingDocument(ctx.orgId ?? null);
  const previousLogo = existing.logo;
  const validated = validateLogoUpload(file);
  const nextLogo = buildLogoUrl(ctx.orgId ?? null, validated.hash, validated.ext);

  const updateFilter = ctx.orgId
    ? { orgId: orgIdFilter(ctx.orgId) }
    : { key: BRANDING_KEY };
  const updated = await Branding.findOneAndUpdate(
    updateFilter,
    {
      $set: {
        logo: nextLogo,
        logoBytes: validated.buffer,
        logoMimeType: validated.mimeType,
        updatedBy: new Types.ObjectId(ctx.actor.id),
      },
    },
    { returnDocument: "after" },
  ).lean<BrandingDoc>();
  if (!updated) throw new Error("Branding document missing after upload");

  await recordAudit({
    action: AuditAction.BRANDING_LOGO_REPLACED,
    entityType: AuditEntity.BRANDING,
    entityId: ctx.orgId ?? BRANDING_KEY,
    orgId: ctx.orgId ?? null,
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { previousLogo, nextLogo },
  });

  return toDTO(updated);
}
