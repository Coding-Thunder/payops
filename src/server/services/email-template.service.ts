import "server-only";

import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import type { CreateEmailTemplateVersionInput } from "@/lib/validation";
import {
  EmailTemplate,
  type EmailTemplateContent,
  type EmailTemplateDoc,
  type EmailTemplateKey,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { organizationStamp } from "@/server/db/organization-filter";
import {
  getRequestOrganizationScope,
  organizationsExist,
} from "@/server/auth/organization";
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
    serviceType: doc.serviceType ?? ServiceType.CAR_RENTAL,
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

// ─── Service ───────────────────────────────────────────────────────────────

/**
 * The rows that hold one service's copy: its own rows, plus — for car
 * rental only — the rows written before copy was per service
 * (`serviceType: null`), which were car rental copy. Never another service's.
 */
function serviceRows(serviceType: ServiceType): (ServiceType | null)[] {
  return serviceType === ServiceType.CAR_RENTAL
    ? [ServiceType.CAR_RENTAL, null]
    : [serviceType];
}

/**
 * Whose copy the admin screens list, save and activate: the selected brand's
 * own — or, on a deployment with no brands at all, the deployment's own
 * (unowned) copy, exactly as before brands existed. With brands, an unowned
 * row is never written or switched: every brand without copy of its own
 * would inherit it.
 */
async function editingOwner(): Promise<
  { allowed: true; owner: Types.ObjectId | null } | { allowed: false }
> {
  const owner = organizationStamp(await getRequestOrganizationScope());
  if (owner) return { allowed: true, owner };
  return (await organizationsExist())
    ? { allowed: false }
    : { allowed: true, owner: null };
}

// ─── Reads ─────────────────────────────────────────────────────────────────

export async function listTemplateVersions(
  templateKey: EmailTemplateKey,
  /** One service's versions; every service's when omitted. */
  serviceType?: ServiceType,
): Promise<EmailTemplateVersionDTO[]> {
  await connectMongo();
  // The brand's OWN versions only — the ones it can edit and activate.
  const editing = await editingOwner();
  if (!editing.allowed) return [];
  const docs = await EmailTemplate.find({
    templateKey,
    organizationId: editing.owner,
    ...(serviceType ? { serviceType: { $in: serviceRows(serviceType) } } : {}),
  })
    .sort({ version: -1 })
    .lean<(EmailTemplateDoc & { _id: Types.ObjectId })[]>();
  return docs.map(toDTO);
}

/**
 * The live template for one organization and ONE service.
 *
 * FLIGHT / HOTEL: only this organization's own row for that service —
 * never another service's copy, never a shared row, never another brand's.
 * Without one, the template's built-in copy applies.
 *
 * CAR RENTAL: exactly the rule car rental emails have always used —
 * OVERRIDE-THEN-SHARED over the car rental rows (rows saved for car rental,
 * plus those written before copy was per service, which were car rental
 * copy): this organization's own row wins, otherwise the shared row
 * (organizationId null) applies.
 *
 * The organization is an explicit ARGUMENT rather than ambient request scope
 * because the send paths run on the outbox drainer and on webhooks, which
 * have no session and no organization cookie. Reading ambient scope there
 * would silently give every automated send the shared copy.
 */
export async function getActiveTemplate(
  templateKey: EmailTemplateKey,
  organizationId: string | null,
  serviceType: ServiceType,
): Promise<EmailTemplateVersionDTO | null> {
  await connectMongo();
  const ids: (Types.ObjectId | null)[] =
    serviceType === ServiceType.CAR_RENTAL ? [null] : [];
  if (organizationId && Types.ObjectId.isValid(organizationId)) {
    ids.unshift(new Types.ObjectId(organizationId));
  }
  if (ids.length === 0) return null;
  const docs = await EmailTemplate.find({
    templateKey,
    active: true,
    organizationId: { $in: ids },
    serviceType: { $in: serviceRows(serviceType) },
  }).lean<(EmailTemplateDoc & { _id: Types.ObjectId })[]>();
  if (!docs.length) return null;
  // The organization's own row beats the shared one, and copy written for
  // this service beats a car rental row from before copy was per service.
  // Done in JS rather than with a sort so it does not depend on how Mongo
  // orders null against an ObjectId.
  const isOwn = (d: EmailTemplateDoc) =>
    Boolean(organizationId) && String(d.organizationId ?? "") === organizationId;
  const rank = (d: EmailTemplateDoc) =>
    (isOwn(d) ? 0 : 2) + (d.serviceType === serviceType ? 0 : 1);
  const best = [...docs].sort((a, b) => rank(a) - rank(b))[0]!;
  return toDTO(best);
}

/** The version the ADMIN screens act on: the caller's own organization. */
export async function getActiveTemplateForRequest(
  templateKey: EmailTemplateKey,
  serviceType: ServiceType,
): Promise<EmailTemplateVersionDTO | null> {
  const scope = await getRequestOrganizationScope();
  return getActiveTemplate(templateKey, scope.organizationId, serviceType);
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
  /** The ORDER's service: its copy is that service's, and only that
   *  service's — never another service's copy as a fallback. */
  serviceType: ServiceType,
): Promise<EmailTemplateContent | null> {
  const active = await getActiveTemplate(templateKey, organizationId, serviceType);
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
  /** The service this copy is for. */
  serviceType: ServiceType,
): Promise<EmailTemplateVersionDTO> {
  await connectMongo();
  // Everything below is scoped to the AUTHORING organization. Unscoped, the
  // version counter collided across brands and — worse — the deactivation
  // below switched off the other brand's live template, silently replacing
  // its customer-facing copy.
  // Copy is always a brand's own: with brands but none selected there is no
  // owner, and an unowned row would be inherited by every other brand.
  const editing = await editingOwner();
  if (!editing.allowed) {
    throw new ForbiddenError("Select a brand to edit its email copy.");
  }
  const owner = editing.owner;
  const ownerFilter = { organizationId: owner };

  // Highest version number currently in use for this key, in this org.
  const latest = await EmailTemplate.findOne({ templateKey, ...ownerFilter })
    .sort({ version: -1 })
    .select({ version: 1 })
    .lean<{ version: number }>();
  const nextVersion = (latest?.version ?? 0) + 1;

  // Deactivate this organization's currently active row FOR THIS SERVICE so
  // the new version takes over — theirs only, this service only.
  await EmailTemplate.updateMany(
    {
      templateKey,
      active: true,
      ...ownerFilter,
      serviceType: { $in: serviceRows(serviceType) },
    },
    { $set: { active: false } },
  );

  const doc = await EmailTemplate.create({
    templateKey,
    serviceType,
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
      serviceType,
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
  // Same NotFound (never Forbidden) as the order paths: a different status
  // would let one brand's admin probe which version ids exist in another's.
  // Only the editor's OWN versions can be activated: with brands, a shared
  // row (no organization) is read-only, since switching it would change the
  // copy of every brand that inherits it.
  const editing = await editingOwner();
  if (
    !doc ||
    doc.templateKey !== templateKey ||
    !editing.allowed ||
    String(doc.organizationId ?? "") !== String(editing.owner ?? "")
  ) {
    throw new NotFoundError("Template version not found");
  }
  if (doc.active) {
    return toDTO(doc);
  }

  // Roll back within the OWNING row's organization, not the caller's — a
  // default-org admin may legitimately activate a shared (null) row, and
  // that must not switch off their own override or anyone else's — and
  // within the row's own service, so another service's copy stays live.
  await EmailTemplate.updateMany(
    {
      templateKey,
      active: true,
      organizationId: doc.organizationId ?? null,
      serviceType: {
        $in: serviceRows(doc.serviceType ?? ServiceType.CAR_RENTAL),
      },
    },
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
