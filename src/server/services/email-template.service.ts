import "server-only";

import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  UserRole,
} from "@/lib/constants/enums";
import { NotFoundError, ValidationError } from "@/lib/errors";
import type { CreateEmailTemplateVersionInput } from "@/lib/validation";
import {
  EmailTemplate,
  type EmailTemplateContent,
  type EmailTemplateDoc,
  type EmailTemplateKey,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { orgIdFilter } from "@/server/db/org/org-context";
import type { EmailTemplateVersionDTO } from "@/types";

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
  templateKey: EmailTemplateKey,
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
  templateKey: EmailTemplateKey,
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
  templateKey: EmailTemplateKey,
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
  templateKey: EmailTemplateKey,
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
    .select({ version: 1 })
    .lean<{ version: number }>();
  const nextVersion = (latest?.version ?? 0) + 1;

  // Deactivate the currently active row FOR THIS TENANT only.
  await EmailTemplate.updateMany(
    { ...scope, active: true },
    { $set: { active: false } },
  );

  const doc = await EmailTemplate.create({
    orgId: ctx.orgId ? orgIdFilter(ctx.orgId) : null,
    templateKey,
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
  templateKey: EmailTemplateKey,
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
