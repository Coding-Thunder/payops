import "server-only";

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  UserRole,
} from "@/lib/constants/enums";
import { ValidationError } from "@/lib/errors";
import { env } from "@/lib/env";
import { Branding, BRANDING_KEY, type BrandingDoc } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import type { UpdateBrandingInput } from "@/lib/validation";
import type { BrandingDTO } from "@/types";

import type { RequestContext } from "@/server/api/request-context";
import { recordAudit } from "./audit.service";

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
const ALLOWED_MIME: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/svg+xml", "svg"],
]);

const PUBLIC_DIR = path.join(process.cwd(), "public");
const BRANDING_DIR = path.join(PUBLIC_DIR, "branding");

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
  const suffix = randomBytes(4).toString("hex");
  const fileName = `workspace-${suffix}.${ext}`;
  const fullPath = path.join(BRANDING_DIR, fileName);
  const resolved = path.resolve(fullPath);
  // Defensive: ensure we stay inside BRANDING_DIR even though the file
  // name we built can't escape today.
  if (!resolved.startsWith(path.resolve(BRANDING_DIR) + path.sep)) {
    throw new ValidationError("Invalid file path");
  }
  await fs.mkdir(BRANDING_DIR, { recursive: true });
  await fs.writeFile(resolved, input.buffer);
  return `/branding/${fileName}`;
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

  return toDTO(updated);
}
