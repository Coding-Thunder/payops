import "server-only";

import type { Types } from "mongoose";

import {
  Review,
  ReviewStatusValue,
  type ReviewDoc,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

/**
 * Reviews — the public side. Submission and approved reads.
 *
 * Two properties this module is responsible for, both of which are the kind
 * that fail silently:
 *
 *  1. NO PENDING REVIEW IS EVER PUBLIC. `approvedFilter()` is the single
 *     definition, and every public read composes it.
 *
 *  2. NO REVIEWER EMAIL IS EVER PUBLIC. `toPublicReview` builds its result
 *     field by field rather than spreading the document, so a field added to
 *     the model later cannot leak by default. The email is stored for
 *     moderation and has no business being on a marketing page.
 */

function approvedFilter() {
  return {
    status: ReviewStatusValue.APPROVED,
    approvedAt: { $ne: null },
  } as const;
}

/** A review as the public page renders it. Note the absence of `authorEmail`. */
export interface PublicReview {
  id: string;
  authorName: string;
  authorTitle: string | null;
  authorCompany: string | null;
  rating: number;
  title: string;
  body: string;
  approvedAt: string;
}

/**
 * Built explicitly, never by spreading the document.
 *
 * `{ ...doc, authorEmail: undefined }` would be one careless edit away from
 * leaking, and a field added to the model in six months would leak by
 * default. Listing what goes out inverts that: a new field is invisible until
 * someone adds it here on purpose.
 */
function toPublicReview(d: ReviewDoc & { _id: Types.ObjectId }): PublicReview {
  return {
    id: String(d._id),
    authorName: d.authorName,
    authorTitle: d.authorTitle ?? null,
    authorCompany: d.authorCompany ?? null,
    rating: d.rating,
    title: d.title,
    body: d.body,
    approvedAt: (d.approvedAt ?? d.createdAt).toISOString(),
  };
}

export interface SubmitReviewInput {
  authorName: string;
  authorEmail: string;
  authorTitle?: string | null;
  authorCompany?: string | null;
  rating: number;
  title: string;
  body: string;
  /** Recorded for abuse investigation only. Never public, never automatic. */
  ip?: string | null;
}

/**
 * Record a review submission.
 *
 * Always PENDING. `status` is not a parameter, and there is no code path in
 * this function that could set anything else — which is the property worth
 * having, rather than "we filter status out of the body".
 *
 * Returns void: the caller responds identically whether or not this email has
 * reviewed before, so submission never reveals anything about who else has.
 */
export async function submitReview(input: SubmitReviewInput): Promise<void> {
  await connectMongo();
  const rating = Math.round(Number(input.rating));
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return;

  await Review.create({
    authorName: input.authorName.trim(),
    authorEmail: input.authorEmail.trim().toLowerCase(),
    authorTitle: input.authorTitle?.trim() || null,
    authorCompany: input.authorCompany?.trim() || null,
    rating,
    title: input.title.trim(),
    body: input.body.trim(),
    status: ReviewStatusValue.PENDING,
    approvedAt: null,
    submittedIp: input.ip ?? null,
  });
}

/** Approved reviews, newest approval first. */
export async function listApprovedReviews(limit = 24): Promise<PublicReview[]> {
  await connectMongo();
  const docs = await Review.find(approvedFilter())
    .sort({ approvedAt: -1 })
    .limit(Math.min(100, Math.max(1, limit)))
    .lean<(ReviewDoc & { _id: Types.ObjectId })[]>();
  return docs.map(toPublicReview);
}

export interface ReviewSummary {
  count: number;
  /** Mean of approved ratings, to one decimal. Null when count is 0. */
  average: number | null;
  /** Counts per star, 1–5. */
  distribution: Record<number, number>;
}

/**
 * Aggregate over APPROVED reviews only.
 *
 * `average` is null rather than 0 when there is nothing to average, because
 * the caller has to be able to tell "no reviews" from "everyone gave zero" —
 * and because the only correct thing to emit as `aggregateRating` when there
 * are no reviews is nothing at all.
 */
export async function getReviewSummary(): Promise<ReviewSummary> {
  await connectMongo();
  const rows = await Review.aggregate<{ _id: number; n: number }>([
    { $match: approvedFilter() },
    { $group: { _id: "$rating", n: { $sum: 1 } } },
  ]);

  const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let count = 0;
  let total = 0;
  for (const row of rows) {
    const star = Number(row._id);
    if (!Number.isInteger(star) || star < 1 || star > 5) continue;
    distribution[star] = row.n;
    count += row.n;
    total += star * row.n;
  }

  return {
    count,
    average: count ? Math.round((total / count) * 10) / 10 : null,
    distribution,
  };
}

/**
 * `AggregateRating` JSON-LD, or null.
 *
 * NULL WHEN THERE ARE NO REVIEWS, and that is the point of this function
 * existing at all. An `aggregateRating` with a made-up value, or with
 * `reviewCount: 0`, is structured data that claims social proof the product
 * does not have. Google treats fabricated review markup as a manual-action
 * offence, and it would be a false statement regardless of whether anyone
 * enforced it.
 *
 * A single review is also withheld: an average computed from one rating is
 * technically true and reads as a rating for the product, which it is not.
 */
export async function aggregateRatingJsonLd(): Promise<object | null> {
  const summary = await getReviewSummary();
  if (summary.count < 2 || summary.average === null) return null;
  return {
    "@type": "AggregateRating",
    ratingValue: summary.average,
    reviewCount: summary.count,
    bestRating: 5,
    worstRating: 1,
  };
}
