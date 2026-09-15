import "server-only";

import { recordAdminAction } from "@/console/server/audit";
import { Review, type ReviewDoc } from "@/console/server/db/models";
import { connectMongo } from "@/console/server/db/mongoose";
import { assertConsoleAdmin } from "@/console/server/auth/session";

/**
 * Review moderation — the admin side.
 *
 * ── What a moderator can and cannot do ───────────────────────────────────
 *
 * Approve, reject, un-approve, and attach an internal note. Deliberately NOT
 * edit: there is no function here that changes `title`, `body`, `rating` or
 * `authorName`, and that omission is the design rather than an oversight.
 *
 * Editing someone else's review and republishing it under their name is
 * misrepresentation, and a moderation tool that makes it a two-click
 * operation will eventually see it done — to fix a typo, to trim a sentence,
 * to soften a complaint. The only decisions available are publish it as
 * written or do not publish it, which is exactly what the public page
 * promises the submitter.
 *
 * Every action is attributed to the authenticated console operator and
 * recorded in the admin audit log, so a rejected review is a decision with a
 * name attached rather than a row that quietly stopped existing.
 */

export interface ReviewRow {
  id: string;
  authorName: string;
  /** Visible to moderators only. Never returned by any public read. */
  authorEmail: string;
  authorTitle: string | null;
  authorCompany: string | null;
  rating: number;
  title: string;
  body: string;
  status: string;
  approvedAt: string | null;
  moderatedByEmail: string | null;
  moderatedAt: string | null;
  moderationNote: string | null;
  submittedIp: string | null;
  createdAt: string | null;
}

function toRow(d: ReviewDoc): ReviewRow {
  return {
    id: String(d._id),
    authorName: d.authorName,
    authorEmail: d.authorEmail,
    authorTitle: d.authorTitle ?? null,
    authorCompany: d.authorCompany ?? null,
    rating: Number(d.rating) || 0,
    title: d.title,
    body: d.body,
    status: d.status,
    approvedAt: d.approvedAt ? new Date(d.approvedAt).toISOString() : null,
    moderatedByEmail: d.moderatedByEmail ?? null,
    moderatedAt: d.moderatedAt ? new Date(d.moderatedAt).toISOString() : null,
    moderationNote: d.moderationNote ?? null,
    submittedIp: d.submittedIp ?? null,
    createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
  };
}

export class ReviewModerationError extends Error {}

const OID = /^[a-f0-9]{24}$/i;

export interface ListReviewsResult {
  items: ReviewRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function listReviews(opts: {
  status?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}): Promise<ListReviewsResult> {
  await assertConsoleAdmin();
  await connectMongo();
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 25));
  const filter: Record<string, unknown> = {};
  if (opts.status && opts.status !== "ALL") filter.status = opts.status;
  if (opts.search?.trim()) {
    const escaped = opts.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(escaped, "i");
    filter.$or = [{ authorName: rx }, { authorEmail: rx }, { title: rx }];
  }

  const [docs, total] = await Promise.all([
    Review.find(filter)
      // Pending first is not expressible as a single sort key, so the queue
      // is reached through the status filter and this sorts by recency.
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean<ReviewDoc[]>(),
    Review.countDocuments(filter),
  ]);

  return {
    items: docs.map(toRow),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function getReview(id: string): Promise<ReviewRow | null> {
  await assertConsoleAdmin();
  await connectMongo();
  if (!OID.test(id)) return null;
  const doc = await Review.findById(id).lean<ReviewDoc>();
  return doc ? toRow(doc) : null;
}

export async function countPendingReviews(): Promise<number> {
  await assertConsoleAdmin();
  await connectMongo();
  return Review.countDocuments({ status: "PENDING" });
}

/**
 * Prior submissions from the same address.
 *
 * Context a moderator needs and cannot get any other way: three glowing
 * five-star reviews from one address in an afternoon is the shape of abuse,
 * and it is invisible when each is judged on its own.
 */
export async function otherReviewsByAuthor(
  email: string,
  excludeId: string,
): Promise<ReviewRow[]> {
  await assertConsoleAdmin();
  await connectMongo();
  if (!email) return [];
  const docs = await Review.find({
    authorEmail: email.trim().toLowerCase(),
    ...(OID.test(excludeId) ? { _id: { $ne: excludeId } } : {}),
  })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean<ReviewDoc[]>();
  return docs.map(toRow);
}

async function moderate(
  id: string,
  status: "APPROVED" | "REJECTED" | "PENDING",
  actor: string,
  ip: string | null,
  note?: string | null,
): Promise<ReviewRow> {
  // The exported wrappers below are non-async one-liners, so the gate lives
  // here — the single place every moderation write funnels through.
  await assertConsoleAdmin();
  await connectMongo();
  if (!OID.test(id)) throw new ReviewModerationError("Unknown review.");
  const current = await Review.findById(id).lean<ReviewDoc>();
  if (!current) throw new ReviewModerationError("Unknown review.");

  const set: Record<string, unknown> = {
    status,
    moderatedByEmail: actor,
    moderatedAt: new Date(),
  };
  // `approvedAt` is the public sort key. Set on first approval, preserved on
  // a re-approval so an un-approved-then-re-approved review does not jump to
  // the top of the page.
  if (status === "APPROVED") set.approvedAt = current.approvedAt ?? new Date();
  // Un-approving clears it: the review is no longer public, so it has no
  // public position to hold.
  if (status !== "APPROVED") set.approvedAt = null;
  if (note !== undefined) set.moderationNote = note?.trim() || null;

  await Review.updateOne({ _id: id }, { $set: set });

  await recordAdminAction({
    actorEmail: actor,
    action: `review.${status.toLowerCase()}`,
    targetType: "review",
    targetId: id,
    // The reviewer's own words are not copied into the audit metadata; the
    // review row is the record of those. Only the decision is logged.
    metadata: { rating: current.rating, previousStatus: current.status },
    ip,
  });

  const updated = await Review.findById(id).lean<ReviewDoc>();
  return toRow(updated as ReviewDoc);
}

/** Publish. The review appears on /reviews exactly as submitted. */
export function approveReview(id: string, actor: string, ip: string | null) {
  return moderate(id, "APPROVED", actor, ip);
}

/** Refuse. Never public; kept so the decision and its reason are on record. */
export function rejectReview(
  id: string,
  actor: string,
  ip: string | null,
  note?: string | null,
) {
  return moderate(id, "REJECTED", actor, ip, note ?? null);
}

/** Take a published review back down, returning it to the queue. */
export function unapproveReview(id: string, actor: string, ip: string | null) {
  return moderate(id, "PENDING", actor, ip);
}

/** Attach or update the internal note. Never changes status or content. */
export async function setReviewNote(
  id: string,
  note: string,
  actor: string,
  ip: string | null,
): Promise<ReviewRow> {
  await assertConsoleAdmin();
  await connectMongo();
  if (!OID.test(id)) throw new ReviewModerationError("Unknown review.");
  const trimmed = note.trim().slice(0, 2000);
  const result = await Review.updateOne(
    { _id: id },
    { $set: { moderationNote: trimmed || null } },
  );
  if (!result.matchedCount) throw new ReviewModerationError("Unknown review.");
  await recordAdminAction({
    actorEmail: actor,
    action: "review.note",
    targetType: "review",
    targetId: id,
    ip,
  });
  const updated = await Review.findById(id).lean<ReviewDoc>();
  return toRow(updated as ReviewDoc);
}
