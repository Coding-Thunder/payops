import "server-only";

import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  UserRole,
} from "@/lib/constants/enums";
import {
  CUSTOM_TEMPLATE_KEY_REGEX,
  SYSTEM_TEMPLATE_DESCRIPTIONS,
  SYSTEM_TEMPLATE_LABELS,
  SYSTEM_EMAIL_TEMPLATE_KEYS,
  isSystemTemplateKey,
  type SystemEmailTemplateKey,
} from "@/lib/constants/email-templates";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import type {
  CreateCustomTemplateInput,
  CreateEmailTemplateVersionInput,
} from "@/lib/validation";
import {
  EmailTemplate,
  type EmailTemplateContent,
  type EmailTemplateDoc,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { orgIdFilter } from "@/server/db/org/org-context";
import type {
  EmailTemplateSummaryDTO,
  EmailTemplateVersionDTO,
} from "@/types";

import type { RequestContext } from "@/server/api/request-context";
import { recordAudit } from "./audit.service";

interface ActorCtx {
  actor: { id: string; name: string; role: UserRole };
  /** Active organization. New rows are stamped with this orgId so each
   *  tenant's template versions form an independent stream. Legacy
   *  un-scoped callers (no orgId) save global rows for back-compat. */
  orgId?: string | null;
  request?: RequestContext | null;
}

// ─── Mapping ───────────────────────────────────────────────────────────────

function toDTO(
  doc: EmailTemplateDoc & { _id: Types.ObjectId | string },
): EmailTemplateVersionDTO {
  return {
    id: String(doc._id),
    templateKey: doc.templateKey,
    kind: doc.kind ?? (isSystemTemplateKey(doc.templateKey) ? "system" : "custom"),
    displayName: doc.displayName?.trim() || defaultDisplayName(doc.templateKey),
    description:
      doc.description ?? defaultDescription(doc.templateKey),
    triggerBindings: (doc.triggerBindings ?? []).map((b) => ({
      event: b.event,
      enabled: b.enabled,
    })),
    version: doc.version,
    active: doc.active,
    subject: doc.subject,
    greeting: doc.greeting,
    intro: doc.intro,
    note: doc.note,
    supportHeadline: doc.supportHeadline,
    supportDescription: doc.supportDescription,
    footerNote: doc.footerNote,
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

function defaultDisplayName(key: string): string {
  if (isSystemTemplateKey(key)) return SYSTEM_TEMPLATE_LABELS[key];
  return key;
}

function defaultDescription(key: string): string | null {
  if (isSystemTemplateKey(key)) return SYSTEM_TEMPLATE_DESCRIPTIONS[key];
  return null;
}

// ─── Reads ─────────────────────────────────────────────────────────────────

/**
 * List every version of a template for the given org. When `orgId` is
 * supplied we return only that tenant's rows; when omitted (legacy
 * caller) we list every row regardless of orgId, preserves the
 * pre-Phase-3d behaviour while admin pages migrate to the new
 * signature.
 *
 * Per-org templates are OPTIONAL: most tenants will run on the code's
 * built-in copy (no DB row at all). Saving a row in the admin UI is
 * how an operator overrides the defaults for THEIR brand voice.
 */
export async function listTemplateVersions(
  templateKey: string,
  orgId?: string | null,
): Promise<EmailTemplateVersionDTO[]> {
  await connectMongo();
  const filter: Record<string, unknown> = { templateKey };
  if (orgId) filter.orgId = orgIdFilter(orgId);
  const docs = await EmailTemplate.find(filter)
    .sort({ version: -1 })
    .lean<(EmailTemplateDoc & { _id: Types.ObjectId })[]>();
  return docs.map(toDTO);
}

/**
 * Return the currently-active version for an org. Returns null when no
 * row exists for this org, the email service then falls back to the
 * code's hardcoded copy (which is the right default for tenants that
 * never customize).
 *
 * Legacy callers (no `orgId`) get the pre-Phase-3d behaviour: a single
 * global active row per templateKey. Used by un-migrated paths during
 * cutover.
 */
export async function getActiveTemplate(
  templateKey: string,
  orgId?: string | null,
): Promise<EmailTemplateVersionDTO | null> {
  await connectMongo();
  const filter: Record<string, unknown> = { templateKey, active: true };
  if (orgId) filter.orgId = orgIdFilter(orgId);
  const doc = await EmailTemplate.findOne(filter).lean<
    EmailTemplateDoc & { _id: Types.ObjectId }
  >();
  return doc ? toDTO(doc) : null;
}

/**
 * Returns just the content fields for the currently active template
 * version. Used by the email-sending services (payment-request /
 * payment-confirmation) as override defaults, falls back to null so
 * the template's hardcoded copy stays in effect when no admin has
 * customized anything.
 */
export async function getActiveTemplateContent(
  templateKey: string,
  orgId?: string | null,
): Promise<EmailTemplateContent | null> {
  // Per-org override first; null fall-through means the email renderer
  // uses the code-defined default copy (which is the right thing for
  // tenants that never customize templates).
  const active = await getActiveTemplate(templateKey, orgId);
  if (!active) return null;
  return {
    subject: active.subject,
    greeting: active.greeting,
    intro: active.intro,
    note: active.note,
    supportHeadline: active.supportHeadline,
    supportDescription: active.supportDescription,
    footerNote: active.footerNote,
  };
}

// ─── Mutations ─────────────────────────────────────────────────────────────

/**
 * Create a new immutable version for `templateKey`, automatically
 * deactivating any previously active version so the new row becomes
 * the live copy. Returns the just-created DTO.
 *
 * NB: serialised in JS rather than relying on Mongo for activation
 * uniqueness. Concurrent calls for the same key could race; in
 * practice this is admin-only and low-frequency.
 */
export async function createTemplateVersion(
  templateKey: string,
  input: CreateEmailTemplateVersionInput,
  ctx: ActorCtx,
): Promise<EmailTemplateVersionDTO> {
  await connectMongo();
  // Scope every version lookup + update to the caller's org. Version
  // numbers count UP within (orgId, templateKey), Tenant #2's v1
  // doesn't share a counter with Tenant #1's v17.
  const scope: Record<string, unknown> = { templateKey };
  if (ctx.orgId) scope.orgId = orgIdFilter(ctx.orgId);

  const latest = await EmailTemplate.findOne(scope)
    .sort({ version: -1 })
    .select({
      version: 1,
      kind: 1,
      displayName: 1,
      description: 1,
      triggerBindings: 1,
    })
    .lean<{
      version: number;
      kind?: "system" | "custom";
      displayName?: string;
      description?: string | null;
      triggerBindings?: Array<{ event: string; enabled: boolean }>;
    }>();
  const nextVersion = (latest?.version ?? 0) + 1;
  // Custom templates require an existing first-version row (created
  // via `createCustomTemplate`). System templates fall through with a
  // virtual "kind=system" default so the initial admin save still works.
  if (!latest && !isSystemTemplateKey(templateKey)) {
    throw new NotFoundError(
      "Custom template not found, create it from the templates page first",
    );
  }
  const kind = latest?.kind ?? "system";
  const displayName = latest?.displayName ?? defaultDisplayName(templateKey);
  const description = latest?.description ?? defaultDescription(templateKey);
  const triggerBindings = latest?.triggerBindings ?? [];

  // Deactivate the currently active row FOR THIS TENANT only.
  await EmailTemplate.updateMany(
    { ...scope, active: true },
    { $set: { active: false } },
  );

  const doc = await EmailTemplate.create({
    orgId: ctx.orgId ? orgIdFilter(ctx.orgId) : null,
    templateKey,
    kind,
    displayName,
    description,
    triggerBindings,
    version: nextVersion,
    active: true,
    subject: input.subject ?? null,
    greeting: input.greeting ?? null,
    intro: input.intro ?? null,
    note: input.note ?? null,
    supportHeadline: input.supportHeadline ?? null,
    supportDescription: input.supportDescription ?? null,
    footerNote: input.footerNote ?? null,
    createdBy: {
      userId: new Types.ObjectId(ctx.actor.id),
      name: ctx.actor.name,
    },
  });

  await recordAudit({
    action: AuditAction.EMAIL_TEMPLATE_VERSION_CREATED,
    entityType: AuditEntity.EMAIL_TEMPLATE,
    entityId: String(doc._id),
    orgId: ctx.orgId ?? null,
    actor: {
      userId: ctx.actor.id,
      name: ctx.actor.name,
      role: ctx.actor.role,
    },
    request: ctx.request ?? null,
    metadata: {
      templateKey,
      version: nextVersion,
    },
  });

  return toDTO(doc.toObject() as EmailTemplateDoc & { _id: Types.ObjectId });
}

/**
 * Flip the active flag to an existing historical version (rollback).
 * Atomic at the (templateKey) level: any other active rows for this
 * key are flipped off first.
 */
export async function activateTemplateVersion(
  templateKey: string,
  versionId: string,
  ctx: ActorCtx,
): Promise<EmailTemplateVersionDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(versionId)) {
    throw new NotFoundError("Template version not found");
  }
  const doc = await EmailTemplate.findById(versionId).lean<
    EmailTemplateDoc & { _id: Types.ObjectId }
  >();
  if (!doc || doc.templateKey !== templateKey) {
    throw new NotFoundError("Template version not found");
  }
  // Cross-tenant guard: a Tenant #2 admin can't activate a Tenant #1
  // version by guessing the id. Skipped for legacy un-scoped callers
  // (no ctx.orgId, pre-Phase-3d behaviour).
  if (ctx.orgId && doc.orgId && String(doc.orgId) !== ctx.orgId) {
    throw new NotFoundError("Template version not found");
  }
  if (doc.active) {
    return toDTO(doc);
  }

  const scope: Record<string, unknown> = { templateKey, active: true };
  if (ctx.orgId) scope.orgId = orgIdFilter(ctx.orgId);
  await EmailTemplate.updateMany(scope, { $set: { active: false } });
  const updated = await EmailTemplate.findByIdAndUpdate(
    versionId,
    { $set: { active: true } },
    { returnDocument: "after" },
  ).lean<EmailTemplateDoc & { _id: Types.ObjectId }>();
  if (!updated) throw new ValidationError("Failed to activate version");

  await recordAudit({
    action: AuditAction.EMAIL_TEMPLATE_VERSION_ACTIVATED,
    entityType: AuditEntity.EMAIL_TEMPLATE,
    entityId: String(updated._id),
    orgId: ctx.orgId ?? null,
    actor: {
      userId: ctx.actor.id,
      name: ctx.actor.name,
      role: ctx.actor.role,
    },
    request: ctx.request ?? null,
    metadata: {
      templateKey,
      version: updated.version,
    },
  });

  return toDTO(updated);
}

// ─── Custom template lifecycle ────────────────────────────────────────────

interface CustomTemplateCtx {
  actor: { id: string; name: string; role: UserRole };
  /** Active org. Required for custom kinds, the whole point of a
   *  per-tenant registry is that org A can name what org B cannot see. */
  orgId: string;
  request?: RequestContext | null;
}

/**
 * Create a brand-new custom template. Writes the very first version
 * (version=1, active=true) with whatever content fields were supplied,
 * stamps the kind + displayName + description + (optional) initial
 * trigger bindings. Subsequent edits go through `createTemplateVersion`
 * which copies the metadata forward.
 *
 * Refuses to create against a system key, or against a slug already
 * owned by this tenant.
 */
export async function createCustomTemplate(
  input: CreateCustomTemplateInput,
  ctx: CustomTemplateCtx,
): Promise<EmailTemplateVersionDTO> {
  await connectMongo();
  const key = input.templateKey.trim().toLowerCase();
  if (isSystemTemplateKey(key)) {
    throw new ConflictError(
      "That key is reserved for a system template. Pick a different one.",
    );
  }
  if (!CUSTOM_TEMPLATE_KEY_REGEX.test(key)) {
    throw new ValidationError(
      "Template key must be lower-case kebab (e.g. payment-reminder), 2 to 48 chars, starting with a letter",
    );
  }
  const orgObjectId = orgIdFilter(ctx.orgId);
  const collision = await EmailTemplate.exists({
    orgId: orgObjectId,
    templateKey: key,
  });
  if (collision) {
    throw new ConflictError(
      "You already have a template with that key, edit it from the templates page",
    );
  }

  const doc = await EmailTemplate.create({
    orgId: orgObjectId,
    templateKey: key,
    kind: "custom",
    displayName: input.displayName.trim(),
    description: input.description?.trim() || null,
    triggerBindings: [],
    version: 1,
    active: true,
    subject: input.subject ?? null,
    greeting: input.greeting ?? null,
    intro: input.intro ?? null,
    note: input.note ?? null,
    supportHeadline: input.supportHeadline ?? null,
    supportDescription: input.supportDescription ?? null,
    footerNote: input.footerNote ?? null,
    createdBy: {
      userId: new Types.ObjectId(ctx.actor.id),
      name: ctx.actor.name,
    },
  });

  await recordAudit({
    action: AuditAction.EMAIL_TEMPLATE_VERSION_CREATED,
    entityType: AuditEntity.EMAIL_TEMPLATE,
    entityId: String(doc._id),
    orgId: ctx.orgId,
    actor: {
      userId: ctx.actor.id,
      name: ctx.actor.name,
      role: ctx.actor.role,
    },
    request: ctx.request ?? null,
    metadata: {
      templateKey: key,
      version: 1,
      kind: "custom",
      displayName: input.displayName,
    },
  });

  return toDTO(doc.toObject() as EmailTemplateDoc & { _id: Types.ObjectId });
}

/**
 * Rename a custom template (displayName / description). Edits the
 * metadata directly across every version row for this (orgId,
 * templateKey) so the registry stays consistent. Refuses on system
 * templates, those are platform-named.
 */
export async function renameCustomTemplate(
  templateKey: string,
  input: { displayName?: string; description?: string | null },
  ctx: CustomTemplateCtx,
): Promise<EmailTemplateVersionDTO> {
  await connectMongo();
  if (isSystemTemplateKey(templateKey)) {
    throw new ForbiddenError(
      "System templates cannot be renamed, only their copy is editable",
    );
  }
  const orgObjectId = orgIdFilter(ctx.orgId);
  const update: Record<string, unknown> = {};
  if (input.displayName !== undefined) {
    const name = input.displayName.trim();
    if (!name) throw new ValidationError("Display name cannot be empty");
    update.displayName = name;
  }
  if (input.description !== undefined) {
    update.description = input.description?.trim() || null;
  }
  if (Object.keys(update).length === 0) {
    throw new ValidationError("Nothing to update");
  }

  const res = await EmailTemplate.updateMany(
    { orgId: orgObjectId, templateKey, kind: "custom" },
    { $set: update },
  );
  if (res.matchedCount === 0) {
    throw new NotFoundError("Custom template not found");
  }

  const active = await EmailTemplate.findOne({
    orgId: orgObjectId,
    templateKey,
    active: true,
  }).lean<EmailTemplateDoc & { _id: Types.ObjectId }>();
  if (!active) throw new NotFoundError("Custom template not found");

  await recordAudit({
    action: AuditAction.EMAIL_TEMPLATE_VERSION_CREATED,
    entityType: AuditEntity.EMAIL_TEMPLATE,
    entityId: String(active._id),
    orgId: ctx.orgId,
    actor: {
      userId: ctx.actor.id,
      name: ctx.actor.name,
      role: ctx.actor.role,
    },
    request: ctx.request ?? null,
    metadata: { templateKey, change: "rename", patch: update },
  });

  return toDTO(active);
}

/**
 * Archive a custom template by flipping every version row off-active
 * and the latest off-active. Soft-delete: rows stay for audit + future
 * trigger replay, but the template no longer appears in the active
 * picker.
 */
export async function archiveCustomTemplate(
  templateKey: string,
  ctx: CustomTemplateCtx,
): Promise<void> {
  await connectMongo();
  if (isSystemTemplateKey(templateKey)) {
    throw new ForbiddenError(
      "System templates cannot be archived",
    );
  }
  const orgObjectId = orgIdFilter(ctx.orgId);
  const res = await EmailTemplate.updateMany(
    { orgId: orgObjectId, templateKey, kind: "custom" },
    { $set: { active: false } },
  );
  if (res.matchedCount === 0) {
    throw new NotFoundError("Custom template not found");
  }
  await recordAudit({
    action: AuditAction.EMAIL_TEMPLATE_VERSION_ACTIVATED,
    entityType: AuditEntity.EMAIL_TEMPLATE,
    entityId: null,
    orgId: ctx.orgId,
    actor: {
      userId: ctx.actor.id,
      name: ctx.actor.name,
      role: ctx.actor.role,
    },
    request: ctx.request ?? null,
    metadata: { templateKey, change: "archive" },
  });
}

// ─── Listing for admin + picker surfaces ─────────────────────────────────

/**
 * Summary list: system kinds (whether or not the tenant has an active
 * row) merged with this tenant's custom kinds (active rows only).
 * Drives the admin template list AND the "Send a template" picker on
 * order / customer / payment surfaces.
 */
export async function listAllTemplatesSummary(
  orgId: string,
): Promise<EmailTemplateSummaryDTO[]> {
  await connectMongo();
  const orgObjectId = orgIdFilter(orgId);

  // Active rows for this tenant (system + custom both surface here).
  const activeRows = await EmailTemplate.find({
    orgId: orgObjectId,
    active: true,
  })
    .select({
      templateKey: 1,
      kind: 1,
      displayName: 1,
      description: 1,
    })
    .lean<
      Array<{
        templateKey: string;
        kind?: "system" | "custom";
        displayName?: string;
        description?: string | null;
      }>
    >();
  const activeMap = new Map<string, (typeof activeRows)[number]>();
  for (const row of activeRows) activeMap.set(row.templateKey, row);

  // System rows ALWAYS surface in the picker, even when the tenant
  // never overrode them, so admins can still send a payment-request
  // ad-hoc.
  const systemRows: EmailTemplateSummaryDTO[] = SYSTEM_EMAIL_TEMPLATE_KEYS.map(
    (key) => {
      const overlay = activeMap.get(key);
      return {
        templateKey: key,
        kind: "system" as const,
        displayName: overlay?.displayName?.trim() || SYSTEM_TEMPLATE_LABELS[key],
        description:
          overlay?.description ?? SYSTEM_TEMPLATE_DESCRIPTIONS[key],
        hasActiveVersion: Boolean(overlay),
      };
    },
  );

  // Custom rows: only the tenant's active ones make the picker.
  const customRows: EmailTemplateSummaryDTO[] = activeRows
    .filter((r) => r.kind === "custom")
    .map((r) => ({
      templateKey: r.templateKey,
      kind: "custom" as const,
      displayName: r.displayName?.trim() || r.templateKey,
      description: r.description ?? null,
      hasActiveVersion: true,
    }));

  return [...systemRows, ...customRows].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  );
}

