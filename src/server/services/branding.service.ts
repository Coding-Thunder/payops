import "server-only";

import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  UserRole,
} from "@/lib/constants/enums";
import { ValidationError } from "@/lib/errors";
import { env } from "@/lib/env";
import {
  assetIdFromUrl,
  deleteAsset,
  putAsset,
} from "@/server/storage/asset-store";
import { Branding, BRANDING_KEY, type BrandingDoc } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
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
  request?: RequestContext | null;
}

// ─── Upload constraints ────────────────────────────────────────────────────

const MAX_LOGO_BYTES = 512 * 1024;
// SVG intentionally NOT allowed: SVG can carry inline <script> and runs
// same-origin when fetched directly, which would turn the branding upload
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
    logo: doc.logo ?? "",
    primaryColor: doc.primaryColor,
    footerTagline: doc.footerTagline ?? "",
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// ─── Env-seeded defaults ───────────────────────────────────────────────────

function envDefaults(): Omit<BrandingDTO, "updatedAt"> {
  const e = env.server;
  return {
    brandName: e.CUSTOMER_BRAND_NAME,
    supportEmail: e.SUPPORT_EMAIL,
    supportPhone: e.SUPPORT_PHONE,
    logo: "",
    primaryColor: "#0B1220",
    footerTagline: "",
  };
}

/**
 * Idempotent upsert. On first run, attempts to migrate any
 * `supportEmail`/`supportPhone` already saved on the legacy Settings doc
 * so admins who edited those (and silently lost them) don't have to
 * re-enter on the new screen.
 */
export async function ensureBrandingDocument(): Promise<BrandingDoc> {
  await connectMongo();
  // Late import keeps this service stand-alone for tests that don't load
  // the Settings model.
  const { Setting, SETTINGS_KEY } = await import("@/server/db/models");
  const defaults = envDefaults();

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

export async function getBranding(): Promise<BrandingDTO> {
  const doc = await ensureBrandingDocument();
  return toDTO(doc);
}

// ─── Update ────────────────────────────────────────────────────────────────

export async function updateBranding(
  input: UpdateBrandingInput,
  ctx: BrandingContext,
): Promise<BrandingDTO> {
  const existing = await ensureBrandingDocument();

  // Diff against current so the audit row carries actual changes only.
  // Empty input or a no-op (all values match) errors out, mirroring the
  // settings flow.
  const changes: Record<string, unknown> = {};
  for (const field of [
    "brandName",
    "supportEmail",
    "supportPhone",
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

  const updated = await Branding.findOneAndUpdate(
    { key: BRANDING_KEY },
    {
      $set: { ...changes, updatedBy: new Types.ObjectId(ctx.actor.id) },
    },
    { returnDocument: "after" },
  ).lean<BrandingDoc>();
  if (!updated) throw new Error("Branding document missing after update");

  await recordAudit({
    action: AuditAction.BRANDING_UPDATED,
    entityType: AuditEntity.BRANDING,
    entityId: BRANDING_KEY,
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

async function saveBrandingLogoFile(input: SaveLogoInput): Promise<string> {
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
  // bytes and confirm they actually match the declared type before storing
  // them — without this, an HTML/SVG payload labelled as image/png would be
  // served back from our own origin and become stored XSS.
  if (!bytesMatchMime(input.buffer, input.mimeType)) {
    throw new ValidationError("Uploaded file does not match the declared image type");
  }

  // Bytes go to the DURABLE asset store, for the same reason provider logos
  // do: `public/branding/` is served from the build artifact and rebuilt on
  // every deploy, so a runtime write is neither served nor retained. That
  // directory does not even exist in this repo, so every branding upload
  // this deployment has ever taken resolved to a 404.
  const stored = await putAsset({
    buffer: input.buffer,
    contentType: input.mimeType,
    label: "workspace",
    kind: "branding-logo",
  });
  return stored.url;
}

export async function replaceBrandingLogo(
  file: { buffer: Buffer; mimeType: string },
  ctx: BrandingContext,
): Promise<BrandingDTO> {
  const existing = await ensureBrandingDocument();
  const previousLogo = existing.logo;
  const nextLogo = await saveBrandingLogoFile(file);

  const updated = await Branding.findOneAndUpdate(
    { key: BRANDING_KEY },
    {
      $set: { logo: nextLogo, updatedBy: new Types.ObjectId(ctx.actor.id) },
    },
    { returnDocument: "after" },
  ).lean<BrandingDoc>();
  if (!updated) throw new Error("Branding document missing after upload");

  await recordAudit({
    action: AuditAction.BRANDING_LOGO_REPLACED,
    entityType: AuditEntity.BRANDING,
    entityId: BRANDING_KEY,
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { previousLogo, nextLogo },
  });

  // Reclaim the superseded asset only after the document is repointed, so a
  // failed delete can never leave branding pointing at bytes that are gone.
  // Only touches the asset store — a legacy `/branding/*` value refers to a
  // file that never survived a deploy anyway, and is left alone.
  const staleId = assetIdFromUrl(previousLogo);
  if (staleId) await deleteAsset(staleId);

  return toDTO(updated);
}
