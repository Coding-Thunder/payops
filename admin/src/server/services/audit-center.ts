import "server-only";

import { connectMongo } from "@/server/db/mongoose";
import { AuditLog, AdminAudit, Types } from "@/server/db/models";
import {
  buildPageResult,
  type Pagination,
  type PageResult,
} from "@/server/pagination";

/**
 * Audit Center — one screen over the two audit trails the platform keeps:
 *   - product  → the main app's `audit_logs` (cross-tenant: orders,
 *                payments, consent, disputes, email delivery, user
 *                lifecycle, …). Read-only.
 *   - console  → this app's `admin_audit` (who did what in the console).
 *                Append-only + immutable.
 * Both are normalised to a common `AuditRow` for a uniform list; the
 * detail view shows the full, source-specific record.
 */

export const AUDIT_SOURCES = ["product", "console"] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

export function normalizeSource(s: string | undefined): AuditSource {
  return s === "console" ? "console" : "product";
}

export interface AuditRow {
  id: string;
  source: AuditSource;
  action: string;
  actor: string;
  entity: string;
  org: string | null;
  ip: string | null;
  createdAt: string | null;
}

export interface AuditDetail extends AuditRow {
  entityId: string | null;
  actorName: string | null;
  actorRole: string | null;
  userAgent: string | null;
  requestId: string | null;
  metadata: Record<string, unknown> | null;
}

export interface AuditFilters {
  action?: string;
  actor?: string;
  type?: string;
  id?: string;
  from?: string;
  to?: string;
}

const iso = (d?: Date | null): string | null =>
  d ? new Date(d).toISOString() : null;

function rx(s: string): RegExp {
  return new RegExp(s.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

/** createdAt range from `from`/`to` (YYYY-MM-DD). `to` is inclusive of the day. */
function dateRange(f: AuditFilters): Record<string, Date> | null {
  const range: Record<string, Date> = {};
  if (f.from) {
    const d = new Date(f.from);
    if (!Number.isNaN(d.getTime())) range.$gte = d;
  }
  if (f.to) {
    const d = new Date(f.to);
    if (!Number.isNaN(d.getTime())) {
      // UTC end-of-day so the inclusive boundary is TZ-stable.
      d.setUTCHours(23, 59, 59, 999);
      range.$lte = d;
    }
  }
  return Object.keys(range).length ? range : null;
}

/* ── product (audit_logs) ─────────────────────────────────────────────── */

interface LeanProduct {
  _id: Types.ObjectId;
  orgId?: Types.ObjectId | null;
  action?: string;
  entityType?: string;
  entityId?: string | null;
  actor?: { name?: string | null; email?: string | null; role?: string | null } | null;
  request?: { ip?: string | null; userAgent?: string | null; requestId?: string | null } | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: Date | null;
}

function productFilter(f: AuditFilters): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  if (f.action?.trim()) q.action = rx(f.action);
  if (f.actor?.trim()) q["actor.email"] = rx(f.actor);
  if (f.type?.trim()) q.entityType = rx(f.type);
  if (f.id?.trim()) q.entityId = f.id.trim();
  const range = dateRange(f);
  if (range) q.createdAt = range;
  return q;
}

function productRow(d: LeanProduct): AuditRow {
  return {
    id: String(d._id),
    source: "product",
    action: d.action ?? "—",
    actor: d.actor?.email ?? d.actor?.name ?? "system",
    entity: d.entityId
      ? `${d.entityType ?? "?"}:${d.entityId}`
      : (d.entityType ?? "—"),
    org: d.orgId ? String(d.orgId) : null,
    ip: d.request?.ip ?? null,
    createdAt: iso(d.createdAt),
  };
}

/* ── console (admin_audit) ────────────────────────────────────────────── */

interface LeanConsole {
  _id: Types.ObjectId;
  action?: string;
  actorEmail?: string;
  targetType?: string;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  createdAt?: Date | null;
}

function consoleFilter(f: AuditFilters): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  if (f.action?.trim()) q.action = rx(f.action);
  if (f.actor?.trim()) q.actorEmail = rx(f.actor);
  if (f.type?.trim()) q.targetType = rx(f.type);
  if (f.id?.trim()) q.targetId = f.id.trim();
  const range = dateRange(f);
  if (range) q.createdAt = range;
  return q;
}

function consoleRow(d: LeanConsole): AuditRow {
  return {
    id: String(d._id),
    source: "console",
    action: d.action ?? "—",
    actor: d.actorEmail ?? "—",
    entity: d.targetId
      ? `${d.targetType ?? "?"}:${d.targetId}`
      : (d.targetType ?? "—"),
    org: null,
    ip: d.ip ?? null,
    createdAt: iso(d.createdAt),
  };
}

/* ── public API ───────────────────────────────────────────────────────── */

export async function listAudit(
  source: AuditSource,
  p: Pagination,
  f: AuditFilters = {},
): Promise<PageResult<AuditRow>> {
  await connectMongo();
  if (source === "console") {
    const filter = consoleFilter(f);
    const [docs, total] = await Promise.all([
      AdminAudit.find(filter)
        .sort({ createdAt: -1 })
        .skip(p.skip)
        .limit(p.limit)
        .lean<LeanConsole[]>(),
      AdminAudit.countDocuments(filter),
    ]);
    return buildPageResult(docs.map(consoleRow), total, p);
  }
  const filter = productFilter(f);
  const [docs, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(p.skip)
      .limit(p.limit)
      .lean<LeanProduct[]>(),
    AuditLog.countDocuments(filter),
  ]);
  return buildPageResult(docs.map(productRow), total, p);
}

export async function getAuditById(
  source: AuditSource,
  id: string,
): Promise<AuditDetail | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  await connectMongo();
  if (source === "console") {
    const d = await AdminAudit.findById(id).lean<LeanConsole | null>();
    if (!d) return null;
    return {
      ...consoleRow(d),
      entityId: d.targetId ?? null,
      actorName: null,
      actorRole: null,
      userAgent: null,
      requestId: null,
      metadata: d.metadata ?? null,
    };
  }
  const d = await AuditLog.findById(id).lean<LeanProduct | null>();
  if (!d) return null;
  return {
    ...productRow(d),
    entityId: d.entityId ?? null,
    actorName: d.actor?.name ?? null,
    actorRole: d.actor?.role ?? null,
    userAgent: d.request?.userAgent ?? null,
    requestId: d.request?.requestId ?? null,
    metadata: d.metadata ?? null,
  };
}

export async function listAuditForExport(
  source: AuditSource,
  f: AuditFilters = {},
  cap = 5000,
): Promise<AuditRow[]> {
  await connectMongo();
  if (source === "console") {
    const docs = await AdminAudit.find(consoleFilter(f))
      .sort({ createdAt: -1 })
      .limit(cap)
      .lean<LeanConsole[]>();
    return docs.map(consoleRow);
  }
  const docs = await AuditLog.find(productFilter(f))
    .sort({ createdAt: -1 })
    .limit(cap)
    .lean<LeanProduct[]>();
  return docs.map(productRow);
}
