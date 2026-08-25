import "server-only";

import { createHash } from "node:crypto";
import { Types } from "mongoose";

import {
  FileVisibility,
  MAX_FILE_UPLOAD_BYTES,
  LARGE_FILE_GUIDANCE,
  ResourceActorType,
  ResourceSource,
  extensionOf,
  findFileFormat,
  type FileFilter,
} from "@/lib/constants/client-resources";
import { AuditAction, AuditEntity, RecordState } from "@/lib/constants/enums";
import { NotFoundError, ValidationError } from "@/lib/errors";
import type { RequestContext } from "@/server/api/request-context";
import type { UserRole } from "@/lib/constants/enums";
import {
  CLIENT_FILE_BUCKET,
  ClientFile,
  Customer,
  Order,
  type ClientFileDoc,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { deleteBytes, putBytes, readBytes } from "@/server/db/gridfs";
import { orgIdFilter, requireOrgId } from "@/server/db/org/org-context";
import { bytesMatchExtension } from "@/server/services/file-sniff";
import type { ClientFileDTO } from "@/types";

import { recordAudit } from "./audit.service";

/**
 * Client Files — upload, list, relate, share.
 *
 * The architectural rule the whole feature rests on: a file is stored
 * ONCE and related to context, never copied into it. `customerId` is
 * mandatory, `orderId` is optional, and the "Client Files" and "Order
 * Files" views are two filters over the same collection. Moving a file
 * onto an order is a field update, not a duplication — which is exactly
 * why the same row can honestly appear in both places.
 */

export interface FileActorCtx {
  actor: { id: string; name: string; role: UserRole };
  orgId: string;
  request?: RequestContext | null;
}

const iso = (d?: Date | null): string | null =>
  d ? new Date(d).toISOString() : null;

function escapeRegex(s: string): string {
  return s.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toDTO(
  doc: ClientFileDoc & { _id: Types.ObjectId },
): ClientFileDTO {
  return {
    id: String(doc._id),
    customerId: String(doc.customerId),
    orderId: doc.orderId ? String(doc.orderId) : null,
    orderNumber: doc.orderNumber ?? null,
    fileName: doc.fileName,
    extension: doc.extension,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    description: doc.description ?? null,
    visibility: doc.visibility,
    source: doc.source,
    addedBy: {
      userId: doc.addedBy?.userId ? String(doc.addedBy.userId) : null,
      name: doc.addedBy?.name ?? "Unknown",
      actorType: doc.addedBy?.actorType ?? ResourceActorType.BUSINESS,
    },
    lastEmailedAt: iso(doc.lastEmailedAt),
    emailSendCount: doc.emailSendCount ?? 0,
    sharedWithClientAt: iso(doc.sharedWithClientAt),
    downloadUrl: `/api/files/${String(doc._id)}/download`,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

/**
 * Sanitise an uploaded name down to something safe to echo back in a
 * Content-Disposition header and a filesystem-flavoured UI. Path
 * separators and control characters go; the extension is preserved
 * because the allow-list check already ran against it.
 */
function safeFileName(raw: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? raw).trim();
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f"\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 255) || "upload";
}

/** Resolve + tenant-check the client. Returns the id every write pins to. */
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

/**
 * Resolve an optional order relationship.
 *
 * Two guards, both load-bearing: the order must belong to THIS tenant,
 * and it must belong to THIS client. Without the second one an operator
 * could file client A's contract under client B's order and it would
 * surface in both profiles.
 */
async function resolveOrder(
  orgId: string,
  customerId: Types.ObjectId,
  orderId: string | null,
): Promise<{ id: Types.ObjectId | null; number: string | null }> {
  if (!orderId) return { id: null, number: null };
  if (!Types.ObjectId.isValid(orderId)) {
    throw new NotFoundError("Order not found");
  }
  const order = await Order.findOne({
    _id: new Types.ObjectId(orderId),
    orgId: orgIdFilter(orgId),
  })
    .select({ orderNumber: 1, customerId: 1, "customer.email": 1 })
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

export interface ListFilesArgs {
  customerId?: string;
  orderId?: string;
  q?: string;
  filter?: FileFilter;
}

/**
 * List the files in one context.
 *
 * Scope rules:
 *   - `orderId` alone (or with a client) → Order Files: only rows
 *     related to that order.
 *   - `customerId` alone → Client Files: every row for the client,
 *     including the ones related to an order. That inclusion is the
 *     point — "a file connected to an order should also appear in the
 *     Client Files section".
 */
export async function listClientFiles(
  args: ListFilesArgs,
  orgId: string | null | undefined,
): Promise<ClientFileDTO[]> {
  const scopedOrgId = requireOrgId(orgId);
  await connectMongo();

  const filter: Record<string, unknown> = {
    orgId: orgIdFilter(scopedOrgId),
    deletedAt: null,
  };
  // Both scopes may be present (Order Files opened from a client's
  // profile); each one narrows independently.
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
    case "shared":
      filter.visibility = FileVisibility.SHARED;
      break;
    case "internal":
      filter.visibility = FileVisibility.INTERNAL;
      break;
    case "order":
      // Meaningless (and destructive) when the list is already pinned to
      // one order — `$ne: null` would widen it back to every order.
      if (!scopedToOrder) filter.orderId = { $ne: null };
      break;
    case "email":
      filter.lastEmailedAt = { $ne: null };
      break;
    default:
      break;
  }

  const q = args.q?.trim();
  if (q) {
    filter.fileName = { $regex: escapeRegex(q), $options: "i" };
  }

  const docs = await ClientFile.find(filter)
    .sort({ createdAt: -1 })
    .limit(200)
    .lean<(ClientFileDoc & { _id: Types.ObjectId })[]>();
  return docs.map(toDTO);
}

/** One file's metadata, tenant-checked. */
export async function getClientFile(
  id: string,
  orgId: string | null | undefined,
): Promise<ClientFileDTO> {
  const doc = await loadFile(id, orgId);
  return toDTO(doc);
}

async function loadFile(
  id: string,
  orgId: string | null | undefined,
): Promise<ClientFileDoc & { _id: Types.ObjectId }> {
  const scopedOrgId = requireOrgId(orgId);
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("File not found");
  const doc = await ClientFile.findOne({
    _id: new Types.ObjectId(id),
    orgId: orgIdFilter(scopedOrgId),
    deletedAt: null,
  }).lean<ClientFileDoc & { _id: Types.ObjectId }>();
  if (!doc) throw new NotFoundError("File not found");
  return doc;
}

/** Metadata + bytes, for the authenticated download route. */
export async function readClientFile(
  id: string,
  orgId: string | null | undefined,
): Promise<{ file: ClientFileDTO; bytes: Buffer }> {
  const doc = await loadFile(id, orgId);
  const bytes = await readBytes(CLIENT_FILE_BUCKET, doc.storageId);
  return { file: toDTO(doc), bytes };
}

/**
 * Resolve a set of file ids into mail attachments.
 *
 * Scoped to BOTH the tenant and the client the message is addressed to.
 * The org check alone is not enough: every id here arrives in the compose
 * payload, so an org-only filter would let a crafted request attach
 * client B's contract to an email going to client A — and then stamp
 * that file "sent via email" on B's timeline, which is a false record on
 * top of a leak. The picker only ever offers the current client's files;
 * this is the server making the same guarantee.
 *
 * The combined size is capped by the caller before a single byte reaches
 * the transport — an oversized message fails at the provider with an
 * opaque error otherwise.
 */
export async function loadAttachments(
  ids: readonly string[],
  orgId: string | null | undefined,
  customerId: string,
): Promise<Array<{ id: string; fileName: string; mimeType: string; bytes: Buffer }>> {
  if (ids.length === 0) return [];
  const scopedOrgId = requireOrgId(orgId);
  if (!Types.ObjectId.isValid(customerId)) {
    throw new NotFoundError("Client not found");
  }
  await connectMongo();
  // De-duplicate first: the same file listed twice is one attachment,
  // not a missing one, and the count check below would otherwise report
  // it as "no longer available".
  const unique = [...new Set(ids)].filter((id) => Types.ObjectId.isValid(id));
  const objectIds = unique.map((id) => new Types.ObjectId(id));
  const docs = await ClientFile.find({
    _id: { $in: objectIds },
    orgId: orgIdFilter(scopedOrgId),
    customerId: new Types.ObjectId(customerId),
    deletedAt: null,
  }).lean<(ClientFileDoc & { _id: Types.ObjectId })[]>();
  if (docs.length !== unique.length) {
    // Deliberately the same message whether the file is gone or belongs
    // to a different client — a probe must not learn which.
    throw new NotFoundError("One of the selected files is no longer available");
  }
  const out: Array<{
    id: string;
    fileName: string;
    mimeType: string;
    bytes: Buffer;
  }> = [];
  for (const doc of docs) {
    out.push({
      id: String(doc._id),
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      bytes: await readBytes(CLIENT_FILE_BUCKET, doc.storageId),
    });
  }
  return out;
}

/* ─── Writes ──────────────────────────────────────────────────────────── */

export interface CreateClientFileArgs {
  customerId: string;
  orderId: string | null;
  fileName: string;
  /** Browser-declared Content-Type. Advisory only — the extension
   *  allow-list plus the byte sniff decide what is actually stored. */
  declaredMimeType: string;
  buffer: Buffer;
  description: string | null;
  visibility: FileVisibility;
  source: ResourceSource;
  actorType: ResourceActorType;
}

export async function createClientFile(
  args: CreateClientFileArgs,
  ctx: FileActorCtx,
): Promise<ClientFileDTO> {
  const scopedOrgId = requireOrgId(ctx.orgId);
  await connectMongo();

  const fileName = safeFileName(args.fileName);
  const size = args.buffer.byteLength;
  if (size === 0) throw new ValidationError("That file is empty");
  // The size rule is a product decision, not a technical one, so the
  // message says what to do instead rather than just refusing.
  if (size > MAX_FILE_UPLOAD_BYTES) {
    throw new ValidationError(LARGE_FILE_GUIDANCE);
  }

  const format = findFileFormat(fileName);
  if (!format) {
    const ext = extensionOf(fileName);
    throw new ValidationError(
      ext
        ? `.${ext} files aren't supported yet. Add it as a link instead, or convert it to a supported format.`
        : "That file has no recognisable extension.",
    );
  }
  if (!bytesMatchExtension(args.buffer, format.extension)) {
    throw new ValidationError(
      `That file doesn't look like a real .${format.extension} file.`,
    );
  }

  const customerOid = await requireCustomer(scopedOrgId, args.customerId);
  const order = await resolveOrder(scopedOrgId, customerOid, args.orderId);

  const checksum = createHash("sha256").update(args.buffer).digest("hex");
  const storageId = await putBytes(CLIENT_FILE_BUCKET, fileName, args.buffer, {
    orgId: scopedOrgId,
    customerId: String(customerOid),
    checksum,
  });

  let created;
  try {
    created = await ClientFile.create({
      orgId: orgIdFilter(scopedOrgId),
      customerId: customerOid,
      orderId: order.id,
      orderNumber: order.number,
      fileName,
      extension: format.extension,
      // Persist the format's canonical type, never the browser's claim:
      // that string is what the download route echoes back as
      // Content-Type, so it must come from the allow-list.
      mimeType: format.mimeTypes[0],
      sizeBytes: size,
      storageId,
      checksum,
      description: args.description,
      visibility: args.visibility,
      source: args.source,
      addedBy: {
        // The acting user is recorded even for client-provided files: a
        // teammate who saves the brand assets a client emailed over IS
        // the uploader. `actorType` records where the file came FROM,
        // which is the thing the Files list and Timeline report.
        userId: new Types.ObjectId(ctx.actor.id),
        name: ctx.actor.name,
        actorType: args.actorType,
      },
      sharedWithClientAt:
        args.visibility === FileVisibility.SHARED ? new Date() : null,
    });
  } catch (err) {
    // Don't strand orphaned chunks in GridFS when the metadata write
    // loses — the bytes are unreachable without a row pointing at them.
    await deleteBytes(CLIENT_FILE_BUCKET, storageId);
    throw err;
  }

  await recordAudit({
    action: AuditAction.CLIENT_FILE_ADDED,
    entityType: AuditEntity.CLIENT_FILE,
    entityId: String(created._id),
    orgId: scopedOrgId,
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: {
      fileName,
      sizeBytes: size,
      customerId: args.customerId,
      orderId: order.id ? String(order.id) : null,
      visibility: args.visibility,
      source: args.source,
    },
  });

  return toDTO(created.toObject() as ClientFileDoc & { _id: Types.ObjectId });
}

export interface UpdateClientFileArgs {
  description?: string | null;
  visibility?: FileVisibility;
  orderId?: string | null;
}

export async function updateClientFile(
  id: string,
  input: UpdateClientFileArgs,
  ctx: FileActorCtx,
): Promise<ClientFileDTO> {
  const existing = await loadFile(id, ctx.orgId);
  const scopedOrgId = requireOrgId(ctx.orgId);

  const update: Record<string, unknown> = {};
  if (input.description !== undefined) update.description = input.description;
  if (input.visibility !== undefined) {
    update.visibility = input.visibility;
    // First transition to SHARED stamps the moment; flipping back to
    // internal doesn't erase it, because the file WAS shared and the
    // timeline says so.
    if (
      input.visibility === FileVisibility.SHARED &&
      !existing.sharedWithClientAt
    ) {
      update.sharedWithClientAt = new Date();
    }
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

  const updated = await ClientFile.findOneAndUpdate(
    { _id: existing._id, orgId: orgIdFilter(scopedOrgId), deletedAt: null },
    { $set: update },
    { returnDocument: "after" },
  ).lean<ClientFileDoc & { _id: Types.ObjectId }>();
  if (!updated) throw new NotFoundError("File not found");

  await recordAudit({
    action: AuditAction.CLIENT_FILE_UPDATED,
    entityType: AuditEntity.CLIENT_FILE,
    entityId: String(updated._id),
    orgId: scopedOrgId,
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { fileName: updated.fileName, patch: update },
  });

  return toDTO(updated);
}

/**
 * Remove a file.
 *
 * The metadata row is SOFT-deleted so the Timeline keeps telling the
 * truth ("Yogesh uploaded requirements.pdf" happened, and deleting the
 * file later doesn't un-happen it). The bytes, by contrast, are really
 * destroyed — "delete" has to mean the content is gone, and an
 * unreachable GridFS blob is pure cost.
 */
export async function deleteClientFile(
  id: string,
  ctx: FileActorCtx,
): Promise<void> {
  const existing = await loadFile(id, ctx.orgId);
  const scopedOrgId = requireOrgId(ctx.orgId);
  await ClientFile.updateOne(
    { _id: existing._id, orgId: orgIdFilter(scopedOrgId) },
    { $set: { deletedAt: new Date() } },
  );
  await deleteBytes(CLIENT_FILE_BUCKET, existing.storageId);

  await recordAudit({
    action: AuditAction.CLIENT_FILE_DELETED,
    entityType: AuditEntity.CLIENT_FILE,
    entityId: String(existing._id),
    orgId: scopedOrgId,
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { fileName: existing.fileName },
  });
}

/**
 * Stamp the email provenance after a successful send.
 *
 * A file that has gone out to the client is, by definition, shared with
 * them — so this also promotes visibility rather than leaving a
 * "Internal" badge on a document sitting in the client's inbox.
 */
export async function markFilesEmailed(
  ids: readonly string[],
  ctx: FileActorCtx,
): Promise<void> {
  if (ids.length === 0) return;
  const scopedOrgId = requireOrgId(ctx.orgId);
  await connectMongo();
  const now = new Date();
  const objectIds = ids
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  if (objectIds.length === 0) return;

  await ClientFile.updateMany(
    { _id: { $in: objectIds }, orgId: orgIdFilter(scopedOrgId) },
    {
      $set: { lastEmailedAt: now, visibility: FileVisibility.SHARED },
      $inc: { emailSendCount: 1 },
    },
  );
  // Backfill the share timestamp only where it was never set, so the
  // original share moment survives a later re-send.
  await ClientFile.updateMany(
    {
      _id: { $in: objectIds },
      orgId: orgIdFilter(scopedOrgId),
      sharedWithClientAt: null,
    },
    { $set: { sharedWithClientAt: now } },
  );

  await recordAudit({
    action: AuditAction.CLIENT_FILE_SHARED,
    entityType: AuditEntity.CLIENT_FILE,
    entityId: objectIds.length === 1 ? String(objectIds[0]) : null,
    orgId: scopedOrgId,
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { fileIds: objectIds.map(String), channel: "email" },
  });
}

/**
 * Count the files hanging off one client — used for the tab badge so the
 * profile can advertise the section without loading every row.
 */
export async function countClientFiles(
  orgId: string | null | undefined,
  customerId: string,
): Promise<number> {
  const scopedOrgId = requireOrgId(orgId);
  await connectMongo();
  if (!Types.ObjectId.isValid(customerId)) return 0;
  return ClientFile.countDocuments({
    orgId: orgIdFilter(scopedOrgId),
    customerId: new Types.ObjectId(customerId),
    deletedAt: null,
  });
}

/** Orders this client has, for the "Related order" picker. Archived
 *  rows are excluded, matching every other client-scoped surface. */
export async function listClientOrderOptions(
  orgId: string | null | undefined,
  customerId: string,
): Promise<Array<{ id: string; orderNumber: string }>> {
  const scopedOrgId = requireOrgId(orgId);
  await connectMongo();
  if (!Types.ObjectId.isValid(customerId)) return [];
  const docs = await Order.find({
    orgId: orgIdFilter(scopedOrgId),
    customerId: new Types.ObjectId(customerId),
    state: { $ne: RecordState.ARCHIVED },
  })
    .sort({ createdAt: -1 })
    .limit(50)
    .select({ orderNumber: 1 })
    .lean<Array<{ _id: Types.ObjectId; orderNumber?: string }>>();
  return docs.map((d) => ({
    id: String(d._id),
    orderNumber: d.orderNumber ?? "—",
  }));
}
