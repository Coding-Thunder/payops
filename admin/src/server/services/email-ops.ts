import "server-only";

import { connectMongo } from "@/server/db/mongoose";
import { PendingEmail, Types } from "@/server/db/models";
import {
  buildPageResult,
  type Pagination,
  type PageResult,
} from "@/server/pagination";

/**
 * Email Operations — visibility + control over the main app's email
 * outbox (`pending_emails`). The main app owns delivery (an in-process
 * drainer claims PENDING rows → PROCESSING → SENT/FAILED with backoff);
 * this console reads the queue and performs a few safe, well-defined
 * status transitions that the drainer then acts on:
 *   - retry:  re-queue a FAILED/stuck email (status→PENDING, due now)
 *   - cancel: delete a PENDING/FAILED email so it never sends
 *   - resend: enqueue a fresh copy of a SENT/FAILED email
 */

export const EMAIL_STATUSES = [
  "PENDING",
  "PROCESSING",
  "SENT",
  "FAILED",
] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const EMAIL_SORTS = {
  created: { createdAt: -1 },
  oldest: { createdAt: 1 },
  nextAttempt: { nextAttemptAt: 1 },
  attempts: { attempts: -1 },
} as const;
export type EmailSort = keyof typeof EMAIL_SORTS;

export interface EmailRow {
  id: string;
  kind: string;
  recipient: string;
  status: string;
  attempts: number;
  lastError: string | null;
  orderId: string | null;
  nextAttemptAt: string | null;
  sentAt: string | null;
  createdAt: string | null;
}

export interface EmailDetail extends EmailRow {
  orgId: string | null;
  metadata: Record<string, unknown> | null;
  updatedAt: string | null;
}

export interface EmailFilters {
  status?: string;
  kind?: string;
  q?: string;
  sort?: string;
}

interface LeanEmail {
  _id: Types.ObjectId;
  orderId?: Types.ObjectId | null;
  orgId?: Types.ObjectId | null;
  kind?: string;
  recipient?: string;
  status?: string;
  attempts?: number;
  lastError?: string | null;
  nextAttemptAt?: Date | null;
  sentAt?: Date | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

const iso = (d?: Date | null): string | null =>
  d ? new Date(d).toISOString() : null;

function toRow(d: LeanEmail): EmailRow {
  return {
    id: String(d._id),
    kind: d.kind ?? "—",
    recipient: d.recipient ?? "—",
    status: d.status ?? "—",
    attempts: d.attempts ?? 0,
    lastError: d.lastError ?? null,
    orderId: d.orderId ? String(d.orderId) : null,
    nextAttemptAt: iso(d.nextAttemptAt),
    sentAt: iso(d.sentAt),
    createdAt: iso(d.createdAt),
  };
}

function buildFilter(f: EmailFilters): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (f.status && (EMAIL_STATUSES as readonly string[]).includes(f.status)) {
    filter.status = f.status;
  }
  if (f.kind && f.kind.trim()) filter.kind = f.kind.trim();
  if (f.q && f.q.trim()) {
    const safe = f.q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.recipient = new RegExp(safe, "i");
  }
  return filter;
}

export async function listEmails(
  p: Pagination,
  f: EmailFilters = {},
): Promise<PageResult<EmailRow>> {
  await connectMongo();
  const filter = buildFilter(f);
  const sort =
    (f.sort && EMAIL_SORTS[f.sort as EmailSort]) || EMAIL_SORTS.created;

  const [docs, total] = await Promise.all([
    PendingEmail.find(filter)
      .sort(sort)
      .skip(p.skip)
      .limit(p.limit)
      .lean<LeanEmail[]>(),
    PendingEmail.countDocuments(filter),
  ]);

  return buildPageResult(docs.map(toRow), total, p);
}

export interface EmailStats {
  PENDING: number;
  PROCESSING: number;
  SENT: number;
  FAILED: number;
  total: number;
}

export async function getEmailStats(): Promise<EmailStats> {
  await connectMongo();
  const agg = await PendingEmail.aggregate<{ _id: string; n: number }>([
    { $group: { _id: "$status", n: { $sum: 1 } } },
  ]);
  const out: EmailStats = {
    PENDING: 0,
    PROCESSING: 0,
    SENT: 0,
    FAILED: 0,
    total: 0,
  };
  for (const r of agg) {
    if (r._id in out) out[r._id as EmailStatus] = r.n;
    out.total += r.n;
  }
  return out;
}

export async function getEmailById(id: string): Promise<EmailDetail | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  await connectMongo();
  const d = await PendingEmail.findById(id).lean<LeanEmail | null>();
  if (!d) return null;
  return {
    ...toRow(d),
    orgId: d.orgId ? String(d.orgId) : null,
    metadata: d.metadata ?? null,
    updatedAt: iso(d.updatedAt),
  };
}

/** Export rows (no pagination) for CSV. Capped so a huge outbox can't OOM. */
export async function listEmailsForExport(
  f: EmailFilters = {},
  cap = 5000,
): Promise<EmailRow[]> {
  await connectMongo();
  const filter = buildFilter(f);
  const sort =
    (f.sort && EMAIL_SORTS[f.sort as EmailSort]) || EMAIL_SORTS.created;
  const docs = await PendingEmail.find(filter)
    .sort(sort)
    .limit(cap)
    .lean<LeanEmail[]>();
  return docs.map(toRow);
}

export interface ActionResult {
  ok: boolean;
  message?: string;
  newId?: string;
}

/** Re-queue a FAILED / stuck email: due immediately, error cleared. */
export async function retryEmail(id: string): Promise<ActionResult> {
  if (!Types.ObjectId.isValid(id)) return { ok: false, message: "Invalid id" };
  await connectMongo();
  const res = await PendingEmail.updateOne(
    {
      _id: new Types.ObjectId(id),
      status: { $in: ["FAILED", "PROCESSING", "PENDING"] },
    },
    { $set: { status: "PENDING", nextAttemptAt: new Date(), lastError: null } },
  );
  if (res.matchedCount === 0) {
    return { ok: false, message: "Email not found, or already sent" };
  }
  return { ok: true };
}

/** Remove a not-yet-sent email so the drainer never picks it up. */
export async function cancelEmail(id: string): Promise<ActionResult> {
  if (!Types.ObjectId.isValid(id)) return { ok: false, message: "Invalid id" };
  await connectMongo();
  const res = await PendingEmail.deleteOne({
    _id: new Types.ObjectId(id),
    status: { $in: ["PENDING", "FAILED"] },
  });
  if (res.deletedCount === 0) {
    return {
      ok: false,
      message: "Only pending or failed emails can be cancelled",
    };
  }
  return { ok: true };
}

/** Enqueue a fresh copy so the drainer re-renders + re-delivers it. */
export async function resendEmail(id: string): Promise<ActionResult> {
  if (!Types.ObjectId.isValid(id)) return { ok: false, message: "Invalid id" };
  await connectMongo();
  const src = await PendingEmail.findById(id).lean<LeanEmail | null>();
  if (!src) return { ok: false, message: "Email not found" };
  const created = await PendingEmail.create({
    orderId: src.orderId ?? null,
    orgId: src.orgId ?? null,
    kind: src.kind,
    recipient: src.recipient,
    status: "PENDING",
    attempts: 0,
    nextAttemptAt: new Date(),
    lastError: null,
    metadata: src.metadata ?? null,
  });
  return { ok: true, newId: String(created._id) };
}
