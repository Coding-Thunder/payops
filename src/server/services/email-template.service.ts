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
import {
  belongsToScope,
  organizationStamp,
  withOrganizationScope,
} from "@/server/db/organization-filter";
import { getRequestOrganizationScope } from "@/server/auth/organization";
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
  const docs = await EmailTemplate.find(
    withOrganizationScope({ templateKey }, await getRequestOrganizationScope()),
  )
    .sort({ version: -1 })
    .lean<(EmailTemplateDoc & { _id: Types.ObjectId })[]>();
  return docs.map(toDTO);
}

/**
 * The live template for one organization.
 *
 * Resolution is OVERRIDE-THEN-SHARED: a row stamped with this organization
 * wins; otherwise the shared row (organizationId null) applies. The null
 * bucket is a deliberate deployment-wide default here, not merely
 * pre-migration residue — see the note on the model.
 *
 * The organization is an explicit ARGUMENT rather than ambient request scope
 * because the send paths run on the outbox drainer and on webhooks, which
 * have no session and no organization cookie. Reading ambient scope there
 * would silently give every automated send the shared copy.
 */
export async function getActiveTemplate(
  templateKey: EmailTemplateKey,
  organizationId: string | null,
): Promise<EmailTemplateVersionDTO | null> {
  await connectMongo();
  const ids: (Types.ObjectId | null)[] = [null];
  if (organizationId && Types.ObjectId.isValid(organizationId)) {
    ids.unshift(new Types.ObjectId(organizationId));
  }
  const docs = await EmailTemplate.find({
    templateKey,
    active: true,
    organizationId: { $in: ids },
  }).lean<(EmailTemplateDoc & { _id: Types.ObjectId })[]>();
  if (!docs.length) return null;
  // Prefer the organization's own row over the shared one. Done in JS
  // rather than with a sort so it does not depend on how Mongo orders
  // null against an ObjectId.
  const own = organizationId
    ? docs.find((d) => String(d.organizationId ?? "") === organizationId)
    : undefined;
  return toDTO(own ?? docs[0]);
}

/** The version the ADMIN screens act on: the caller's own organization. */
export async function getActiveTemplateForRequest(
  templateKey: EmailTemplateKey,
): Promise<EmailTemplateVersionDTO | null> {
  const scope = await getRequestOrganizationScope();
  return getActiveTemplate(templateKey, scope.organizationId);
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
  organizationId: string | null,
): Promise<EmailTemplateContent | null> {
  const active = await getActiveTemplate(templateKey, organizationId);
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
  // Everything below is scoped to the AUTHORING organization. Unscoped, the
  // version counter collided across brands and — worse — the deactivation
  // below switched off the other brand's live template, silently replacing
  // its customer-facing copy.
  const scope = await getRequestOrganizationScope();
  const owner = organizationStamp(scope);
  const ownerFilter = { organizationId: owner };

  // Highest version number currently in use for this key, in this org.
  const latest = await EmailTemplate.findOne({ templateKey, ...ownerFilter })
    .sort({ version: -1 })
    .select({ version: 1 })
    .lean<{ version: number }>();
  const nextVersion = (latest?.version ?? 0) + 1;

  // Deactivate this organization's currently active row so the new version
  // takes over — theirs only.
  await EmailTemplate.updateMany(
    { templateKey, active: true, ...ownerFilter },
    { $set: { active: false } },
  );

  const doc = await EmailTemplate.create({
    templateKey,
    organizationId: owner,
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
  const scope = await getRequestOrganizationScope();
  const doc = await EmailTemplate.findById(versionId).lean<
    EmailTemplateDoc & { _id: Types.ObjectId }
  >();
  // Same NotFound (never Forbidden) as the order paths: a different status
  // would let one brand's admin probe which version ids exist in another's.
  if (
    !doc ||
    doc.templateKey !== templateKey ||
    !belongsToScope(doc.organizationId, scope)
  ) {
    throw new NotFoundError("Template version not found");
  }
  if (doc.active) {
    return toDTO(doc);
  }

  // Roll back within the OWNING row's organization, not the caller's — a
  // default-org admin may legitimately activate a shared (null) row, and
  // that must not switch off their own override or anyone else's.
  await EmailTemplate.updateMany(
    { templateKey, active: true, organizationId: doc.organizationId ?? null },
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
