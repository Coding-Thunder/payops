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
import type { EmailTemplateVersionDTO } from "@/types";

import type { RequestContext } from "@/server/api/request-context";
import { recordAudit } from "./audit.service";

interface ActorCtx {
  actor: { id: string; name: string; role: UserRole };
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

export async function listTemplateVersions(
  templateKey: EmailTemplateKey,
): Promise<EmailTemplateVersionDTO[]> {
  await connectMongo();
  const docs = await EmailTemplate.find({ templateKey })
    .sort({ version: -1 })
    .lean<(EmailTemplateDoc & { _id: Types.ObjectId })[]>();
  return docs.map(toDTO);
}

export async function getActiveTemplate(
  templateKey: EmailTemplateKey,
): Promise<EmailTemplateVersionDTO | null> {
  await connectMongo();
  const doc = await EmailTemplate.findOne({
    templateKey,
    active: true,
  }).lean<EmailTemplateDoc & { _id: Types.ObjectId }>();
  return doc ? toDTO(doc) : null;
}

/**
 * Returns just the content fields for the currently active template
 * version. Used by the email-sending services (payment-request /
 * payment-confirmation) as override defaults — falls back to null so
 * the template's hardcoded copy stays in effect when no admin has
 * customized anything.
 */
export async function getActiveTemplateContent(
  templateKey: EmailTemplateKey,
): Promise<EmailTemplateContent | null> {
  const active = await getActiveTemplate(templateKey);
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
  // Highest version number currently in use for this key.
  const latest = await EmailTemplate.findOne({ templateKey })
    .sort({ version: -1 })
    .select({ version: 1 })
    .lean<{ version: number }>();
  const nextVersion = (latest?.version ?? 0) + 1;

  // Deactivate any currently active row so the new version takes over.
  await EmailTemplate.updateMany(
    { templateKey, active: true },
    { $set: { active: false } },
  );

  const doc = await EmailTemplate.create({
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
  if (doc.active) {
    return toDTO(doc);
  }

  await EmailTemplate.updateMany(
    { templateKey, active: true },
    { $set: { active: false } },
  );
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
