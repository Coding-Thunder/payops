import "server-only";

import { Types } from "mongoose";

import { AuditAction, AuditEntity, UserRole } from "@/lib/constants/enums";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { Organization } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

import type { RequestContext } from "@/server/api/request-context";
import { recordAudit } from "./audit.service";

/**
 * Organization-level mutations.
 *
 * Kept narrowly-scoped: the only field the tenant edits via the admin
 * UI today is the display name (which they typically rename from the
 * "X's workspace" the founder signup auto-synthesised). Slug stays
 * immutable post-creation, it's URL-visible in places like the
 * webhook path, and renaming a slug would orphan all those references.
 * If a tenant truly needs a new slug, they delete + recreate.
 */

interface RenameInput {
  name: string;
}

interface ActorContext {
  actor: { id: string; name: string; role: UserRole };
  request?: RequestContext | null;
}

export interface OrganizationDTO {
  id: string;
  slug: string;
  name: string;
  legalName: string | null;
  status: string;
  updatedAt: string;
}

export async function getOrganization(orgId: string): Promise<OrganizationDTO> {
  await connectMongo();
  const doc = await Organization.findById(orgId).lean<{
    _id: unknown;
    slug: string;
    name: string;
    legalName?: string | null;
    status: string;
    updatedAt: Date;
  }>();
  if (!doc) throw new NotFoundError("Organization not found");
  return {
    id: String(doc._id),
    slug: doc.slug,
    name: doc.name,
    legalName: doc.legalName ?? null,
    status: doc.status,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export async function renameOrganization(
  orgId: string,
  input: RenameInput,
  ctx: ActorContext,
): Promise<OrganizationDTO> {
  await connectMongo();
  const next = input.name.trim();
  if (next.length < 1 || next.length > 120) {
    throw new ValidationError(
      "Workspace name must be between 1 and 120 characters",
    );
  }
  const doc = await Organization.findById(orgId);
  if (!doc) throw new NotFoundError("Organization not found");

  const previous = doc.name;
  if (previous === next) {
    // No-op, return current state without an audit row.
    return {
      id: String(doc._id),
      slug: doc.slug,
      name: doc.name,
      legalName: doc.legalName ?? null,
      status: doc.status,
      updatedAt: doc.updatedAt.toISOString(),
    };
  }
  doc.name = next;
  await doc.save();

  await recordAudit({
    action: AuditAction.SETTINGS_UPDATED,
    entityType: AuditEntity.SETTINGS,
    entityId: String(doc._id),
    orgId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { field: "organization.name", previous, next },
  });

  return {
    id: String(doc._id),
    slug: doc.slug,
    name: doc.name,
    legalName: doc.legalName ?? null,
    status: doc.status,
    updatedAt: doc.updatedAt.toISOString(),
  };
}
