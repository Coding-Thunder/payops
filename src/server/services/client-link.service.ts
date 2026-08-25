import "server-only";

import { Types } from "mongoose";

import {
  ResourceActorType,
  parseResourceUrl,
  type LinkFilter,
} from "@/lib/constants/client-resources";
import { AuditAction, AuditEntity } from "@/lib/constants/enums";
import type { UserRole } from "@/lib/constants/enums";
import { NotFoundError, ValidationError } from "@/lib/errors";
import type { RequestContext } from "@/server/api/request-context";
import {
  ClientLink,
  Customer,
  Order,
  type ClientLinkDoc,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { orgIdFilter, requireOrgId } from "@/server/db/org/org-context";
import type { ClientLinkDTO } from "@/types";

import { recordAudit } from "./audit.service";

/**
 * Client Links — the external half of the resource record.
 *
 * Deliberately thin: we store a name, a URL, and the context it belongs
 * to. TraceTxn never fetches, mirrors, previews, or validates the far
 * side of the link. "Links should open the original external
 * destination. Do not attempt to download or store the external file."
 *
 * Relationship model is identical to ClientFile (mandatory client,
 * optional order) so both sections behave the same way at the client and
 * order levels.
 */

export interface LinkActorCtx {
  actor: { id: string; name: string; role: UserRole };
  orgId: string;
  request?: RequestContext | null;
}

const iso = (d?: Date | null): string | null =>
  d ? new Date(d).toISOString() : null;

function escapeRegex(s: string): string {
  return s.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toDTO(doc: ClientLinkDoc & { _id: Types.ObjectId }): ClientLinkDTO {
  return {
    id: String(doc._id),
    customerId: String(doc.customerId),
    orderId: doc.orderId ? String(doc.orderId) : null,
    orderNumber: doc.orderNumber ?? null,
    name: doc.name,
    url: doc.url,
    host: doc.host,
    source: doc.source,
    description: doc.description ?? null,
    addedBy: {
      userId: doc.addedBy?.userId ? String(doc.addedBy.userId) : null,
      name: doc.addedBy?.name ?? "Unknown",
      actorType: doc.addedBy?.actorType ?? ResourceActorType.BUSINESS,
    },
    lastEmailedAt: iso(doc.lastEmailedAt),
    emailSendCount: doc.emailSendCount ?? 0,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

async function requireCustomer(
  orgId: string,
  customerId: string,
): Promise<Types.ObjectId> {
  if (!Types.ObjectId.isValid(customerId)) {
    throw new NotFoundError("Client not found");
  }
  const oid = new Types.ObjectId(customerId);
  const exists = await Customer.exists({ _id: oid, orgId: orgIdFilter(orgId) });
  if (!exists) throw new NotFoundError("Client not found");
  return oid;
}

async function resolveOrder(
  orgId: string,
  customerId: Types.ObjectId,
  orderId: string | null,
): Promise<{ id: Types.ObjectId | null; number: string | null }> {
  if (!orderId) return { id: null, number: null };
  if (!Types.ObjectId.isValid(orderId)) throw new NotFoundError("Order not found");
  const order = await Order.findOne({
    _id: new Types.ObjectId(orderId),
    orgId: orgIdFilter(orgId),
  })
    .select({ orderNumber: 1, customerId: 1 })
    .lean<{
      _id: Types.ObjectId;
      orderNumber?: string;
      customerId?: Types.ObjectId | null;
    }>();
  if (!order) throw new NotFoundError("Order not found");
  if (order.customerId && String(order.customerId) !== String(customerId)) {
    throw new ValidationError("That order belongs to a different client");
  }
  return { id: order._id, number: order.orderNumber ?? null };
}

/* ─── Reads ───────────────────────────────────────────────────────────── */

export interface ListLinksArgs {
  customerId?: string;
  orderId?: string;
  q?: string;
  filter?: LinkFilter;
}

export async function listClientLinks(
  args: ListLinksArgs,
  orgId: string | null | undefined,
): Promise<ClientLinkDTO[]> {
  const scopedOrgId = requireOrgId(orgId);
  await connectMongo();

  const filter: Record<string, unknown> = {
    orgId: orgIdFilter(scopedOrgId),
    deletedAt: null,
  };
  if (args.customerId) {
    if (!Types.ObjectId.isValid(args.customerId)) return [];
    filter.customerId = new Types.ObjectId(args.customerId);
  }
  const scopedToOrder = Boolean(args.orderId);
  if (args.orderId) {
    if (!Types.ObjectId.isValid(args.orderId)) return [];
    filter.orderId = new Types.ObjectId(args.orderId);
  }

  switch (args.filter ?? "all") {
    case "order":
      // See client-file.service: widening an already order-pinned list
      // back to "any order" is never what the filter means.
      if (!scopedToOrder) filter.orderId = { $ne: null };
      break;
    case "email":
      filter.lastEmailedAt = { $ne: null };
      break;
    default:
      break;
  }

  const q = args.q?.trim();
  if (q) filter.name = { $regex: escapeRegex(q), $options: "i" };

  const docs = await ClientLink.find(filter)
    .sort({ createdAt: -1 })
    .limit(200)
    .lean<(ClientLinkDoc & { _id: Types.ObjectId })[]>();
  return docs.map(toDTO);
}

async function loadLink(
  id: string,
  orgId: string | null | undefined,
): Promise<ClientLinkDoc & { _id: Types.ObjectId }> {
  const scopedOrgId = requireOrgId(orgId);
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Link not found");
  const doc = await ClientLink.findOne({
    _id: new Types.ObjectId(id),
    orgId: orgIdFilter(scopedOrgId),
    deletedAt: null,
  }).lean<ClientLinkDoc & { _id: Types.ObjectId }>();
  if (!doc) throw new NotFoundError("Link not found");
  return doc;
}

/**
 * Resolve link ids for an outgoing email, scoped to BOTH the tenant and
 * the client being written to. See `loadAttachments` — same reasoning:
 * ids arrive in the compose payload, so an org-only filter would let one
 * client's private resource be shared into another client's inbox and
 * recorded on the wrong timeline.
 */
export async function loadLinksForEmail(
  ids: readonly string[],
  orgId: string | null | undefined,
  customerId: string,
): Promise<ClientLinkDTO[]> {
  if (ids.length === 0) return [];
  const scopedOrgId = requireOrgId(orgId);
  if (!Types.ObjectId.isValid(customerId)) {
    throw new NotFoundError("Client not found");
  }
  await connectMongo();
  const unique = [...new Set(ids)].filter((id) => Types.ObjectId.isValid(id));
  const objectIds = unique.map((id) => new Types.ObjectId(id));
  const docs = await ClientLink.find({
    _id: { $in: objectIds },
    orgId: orgIdFilter(scopedOrgId),
    customerId: new Types.ObjectId(customerId),
    deletedAt: null,
  }).lean<(ClientLinkDoc & { _id: Types.ObjectId })[]>();
  if (docs.length !== unique.length) {
    throw new NotFoundError("One of the selected links is no longer available");
  }
  // Preserve the operator's chosen order rather than Mongo's.
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  return unique
    .map((id) => byId.get(id))
    .filter((d): d is ClientLinkDoc & { _id: Types.ObjectId } => Boolean(d))
    .map(toDTO);
}

/* ─── Writes ──────────────────────────────────────────────────────────── */

export interface CreateClientLinkArgs {
  customerId: string;
  orderId: string | null;
  name: string;
  url: string;
  description: string | null;
  actorType?: ResourceActorType;
}

export async function createClientLink(
  args: CreateClientLinkArgs,
  ctx: LinkActorCtx,
): Promise<ClientLinkDTO> {
  const scopedOrgId = requireOrgId(ctx.orgId);
  await connectMongo();

  const parsed = parseResourceUrl(args.url);
  if (!parsed) {
    throw new ValidationError(
      "Enter a valid web address starting with http:// or https://",
    );
  }

  const customerOid = await requireCustomer(scopedOrgId, args.customerId);
  const order = await resolveOrder(scopedOrgId, customerOid, args.orderId);
  const actorType = args.actorType ?? ResourceActorType.BUSINESS;

  const created = await ClientLink.create({
    orgId: orgIdFilter(scopedOrgId),
    customerId: customerOid,
    orderId: order.id,
    orderNumber: order.number,
    name: args.name.trim(),
    url: parsed.url,
    host: parsed.host,
    source: parsed.source,
    description: args.description,
    addedBy: {
      // See client-file.service: `userId` is who acted, `actorType` is
      // where the resource came from. Both are true at once when a
      // teammate records a link the client sent them.
      userId: new Types.ObjectId(ctx.actor.id),
      name: ctx.actor.name,
      actorType,
    },
  });

  await recordAudit({
    action: AuditAction.CLIENT_LINK_ADDED,
    entityType: AuditEntity.CLIENT_LINK,
    entityId: String(created._id),
    orgId: scopedOrgId,
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: {
      name: args.name,
      host: parsed.host,
      customerId: args.customerId,
      orderId: order.id ? String(order.id) : null,
    },
  });

  return toDTO(created.toObject() as ClientLinkDoc & { _id: Types.ObjectId });
}

export interface UpdateClientLinkArgs {
  name?: string;
  url?: string;
  description?: string | null;
  orderId?: string | null;
}

export async function updateClientLink(
  id: string,
  input: UpdateClientLinkArgs,
  ctx: LinkActorCtx,
): Promise<ClientLinkDTO> {
  const existing = await loadLink(id, ctx.orgId);
  const scopedOrgId = requireOrgId(ctx.orgId);

  const update: Record<string, unknown> = {};
  if (input.name !== undefined) update.name = input.name.trim();
  if (input.description !== undefined) update.description = input.description;
  if (input.url !== undefined) {
    const parsed = parseResourceUrl(input.url);
    if (!parsed) {
      throw new ValidationError(
        "Enter a valid web address starting with http:// or https://",
      );
    }
    update.url = parsed.url;
    update.host = parsed.host;
    update.source = parsed.source;
  }
  if (input.orderId !== undefined) {
    const order = await resolveOrder(
      scopedOrgId,
      existing.customerId,
      input.orderId,
    );
    update.orderId = order.id;
    update.orderNumber = order.number;
  }

  const updated = await ClientLink.findOneAndUpdate(
    { _id: existing._id, orgId: orgIdFilter(scopedOrgId), deletedAt: null },
    { $set: update },
    { returnDocument: "after" },
  ).lean<ClientLinkDoc & { _id: Types.ObjectId }>();
  if (!updated) throw new NotFoundError("Link not found");

  await recordAudit({
    action: AuditAction.CLIENT_LINK_UPDATED,
    entityType: AuditEntity.CLIENT_LINK,
    entityId: String(updated._id),
    orgId: scopedOrgId,
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { name: updated.name, patch: update },
  });

  return toDTO(updated);
}

/** Soft delete — same reasoning as files: the Timeline recorded that
 *  this resource was added, and history is not editable. */
export async function deleteClientLink(
  id: string,
  ctx: LinkActorCtx,
): Promise<void> {
  const existing = await loadLink(id, ctx.orgId);
  const scopedOrgId = requireOrgId(ctx.orgId);
  await ClientLink.updateOne(
    { _id: existing._id, orgId: orgIdFilter(scopedOrgId) },
    { $set: { deletedAt: new Date() } },
  );
  await recordAudit({
    action: AuditAction.CLIENT_LINK_DELETED,
    entityType: AuditEntity.CLIENT_LINK,
    entityId: String(existing._id),
    orgId: scopedOrgId,
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { name: existing.name },
  });
}

export async function markLinksEmailed(
  ids: readonly string[],
  ctx: LinkActorCtx,
): Promise<void> {
  if (ids.length === 0) return;
  const scopedOrgId = requireOrgId(ctx.orgId);
  await connectMongo();
  const objectIds = ids
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  if (objectIds.length === 0) return;
  await ClientLink.updateMany(
    { _id: { $in: objectIds }, orgId: orgIdFilter(scopedOrgId) },
    { $set: { lastEmailedAt: new Date() }, $inc: { emailSendCount: 1 } },
  );
  await recordAudit({
    action: AuditAction.CLIENT_LINK_SHARED,
    entityType: AuditEntity.CLIENT_LINK,
    entityId: objectIds.length === 1 ? String(objectIds[0]) : null,
    orgId: scopedOrgId,
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { linkIds: objectIds.map(String), channel: "email" },
  });
}

export async function countClientLinks(
  orgId: string | null | undefined,
  customerId: string,
): Promise<number> {
  const scopedOrgId = requireOrgId(orgId);
  await connectMongo();
  if (!Types.ObjectId.isValid(customerId)) return 0;
  return ClientLink.countDocuments({
    orgId: orgIdFilter(scopedOrgId),
    customerId: new Types.ObjectId(customerId),
    deletedAt: null,
  });
}
