import { beforeEach, describe, expect, it } from "vitest";

import { Review } from "@/server/db/models";
import {
  aggregateRatingJsonLd,
  getReviewSummary,
  listApprovedReviews,
  submitReview,
} from "@/server/services/review.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * Reviews: the moderation boundary, and the two things that must never leak.
 *
 * Reviews are the only public write surface on the marketing site that
 * produces text shown to other visitors. Three properties carry the weight,
 * and every one of them fails silently if broken:
 *
 *  1. A SUBMISSION IS NEVER PUBLIC. `submitReview` has no parameter that can
 *     set status, and every public read filters on APPROVED.
 *  2. THE REVIEWER'S EMAIL IS NEVER PUBLIC. It is collected for moderation.
 *     A projection that spread the document would leak it, which is why the
 *     public shape is built field by field.
 *  3. NO RATING IS CLAIMED THAT DOES NOT EXIST. `aggregateRating` markup with
 *     an invented or single-sample value is a false claim about other
 *     people's opinions, and a manual-action offence at Google.
 */

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
});

const BASE = {
  authorName: "Ada Lovelace",
  authorEmail: "ada@example.com",
  rating: 5,
  title: "Genuinely useful",
  body: "We stopped losing track of what we had invoiced. That is the whole review.",
};

async function approved(over: Record<string, unknown> = {}) {
  return Review.create({
    ...BASE,
    status: "APPROVED",
    approvedAt: new Date(),
    ...over,
  });
}

describe("a submission is PENDING and invisible", () => {
  it("stores a review as PENDING no matter what", async () => {
    await submitReview(BASE);
    const doc = await Review.findOne({ authorEmail: "ada@example.com" }).lean();
    expect(doc?.status).toBe("PENDING");
    expect(doc?.approvedAt).toBeNull();
  });

  it("does not appear on the public page", async () => {
    await submitReview(BASE);
    expect(await listApprovedReviews()).toEqual([]);
  });

  it("does not count toward the summary or the rating markup", async () => {
    await submitReview(BASE);
    const summary = await getReviewSummary();
    expect(summary.count).toBe(0);
    // Null, not zero: "no reviews" and "everyone rated it zero" are different
    // statements and the caller has to be able to tell them apart.
    expect(summary.average).toBeNull();
    expect(await aggregateRatingJsonLd()).toBeNull();
  });

  it("a REJECTED review is invisible too", async () => {
    await approved({ status: "REJECTED", approvedAt: null, title: "Rejected" });
    expect(await listApprovedReviews()).toEqual([]);
    expect((await getReviewSummary()).count).toBe(0);
  });

  it("an APPROVED row with no approvedAt is still not published", async () => {
    // Belt and braces: the status alone is not the boundary. A row written by
    // a script, or half-migrated, must not slip through.
    await Review.create({ ...BASE, status: "APPROVED", approvedAt: null });
    expect(await listApprovedReviews()).toEqual([]);
  });
});

describe("the reviewer's email never reaches the public shape", () => {
  it("is absent from a listed review", async () => {
    await approved();
    const [review] = await listApprovedReviews();
    expect(review).not.toHaveProperty("authorEmail");
    expect(JSON.stringify(review)).not.toContain("ada@example.com");
  });

  it("is absent even from a field added to the model later", async () => {
    // The public shape is built field by field rather than by spreading the
    // document, so an unexpected stored field cannot ride along. This writes
    // one directly and proves it does not surface.
    await Review.collection.insertOne({
      ...BASE,
      status: "APPROVED",
      approvedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      submittedIp: "203.0.113.9",
      moderationNote: "internal: verified by phone",
      secretFutureField: "must-not-surface",
    });
    const json = JSON.stringify(await listApprovedReviews());
    expect(json).not.toContain("203.0.113.9");
    expect(json).not.toContain("internal: verified by phone");
    expect(json).not.toContain("must-not-surface");
    expect(json).not.toContain("ada@example.com");
  });
});

describe("ratings are whole stars", () => {
  it("rounds a fractional rating rather than storing it", async () => {
    await submitReview({ ...BASE, rating: 4.4 });
    const doc = await Review.findOne({}).lean();
    expect(doc?.rating).toBe(4);
  });

  it("refuses an out-of-range or non-numeric rating outright", async () => {
    for (const rating of [0, 6, -1, NaN, Infinity]) {
      await submitReview({ ...BASE, rating: rating as number });
    }
    expect(await Review.countDocuments({})).toBe(0);
  });
});

describe("the public read", () => {
  it("returns approved reviews newest-approval-first", async () => {
    await approved({ title: "Older", approvedAt: new Date("2026-01-01") });
    await approved({ title: "Newer", approvedAt: new Date("2026-06-01") });
    const reviews = await listApprovedReviews();
    expect(reviews.map((r) => r.title)).toEqual(["Newer", "Older"]);
  });

  it("returns the reviewer's words unchanged", async () => {
    // Moderation is publish-or-not. Nothing in the read path rewrites text.
    const body = "It is fine.\n\nNot amazing. The invoicing bit is the good part.";
    await approved({ body });
    const [review] = await listApprovedReviews();
    expect(review.body).toBe(body);
  });
});

describe("aggregate rating markup", () => {
  it("is withheld entirely with no reviews", async () => {
    expect(await aggregateRatingJsonLd()).toBeNull();
  });

  it("is withheld with exactly ONE review", async () => {
    // An average of one rating is arithmetically true and reads as a rating
    // FOR THE PRODUCT, which it is not.
    await approved({ rating: 5 });
    expect(await aggregateRatingJsonLd()).toBeNull();
  });

  it("is emitted from two or more, with the real average", async () => {
    await approved({ rating: 5, authorEmail: "a@example.com" });
    await approved({ rating: 4, authorEmail: "b@example.com" });
    expect(await aggregateRatingJsonLd()).toEqual({
      "@type": "AggregateRating",
      ratingValue: 4.5,
      reviewCount: 2,
      bestRating: 5,
      worstRating: 1,
    });
  });

  it("counts only approved reviews in the average", async () => {
    await approved({ rating: 5, authorEmail: "a@example.com" });
    await approved({ rating: 5, authorEmail: "b@example.com" });
    // A pending 1-star must not drag the public average down, and a pending
    // 5-star must not prop it up.
    await submitReview({ ...BASE, rating: 1, authorEmail: "c@example.com" });
    const rating = (await aggregateRatingJsonLd()) as { ratingValue: number };
    expect(rating.ratingValue).toBe(5);
    expect((await getReviewSummary()).count).toBe(2);
  });

  it("reports the distribution across all five stars", async () => {
    await approved({ rating: 5, authorEmail: "a@example.com" });
    await approved({ rating: 3, authorEmail: "b@example.com" });
    await approved({ rating: 3, authorEmail: "c@example.com" });
    const summary = await getReviewSummary();
    expect(summary.distribution).toEqual({ 1: 0, 2: 0, 3: 2, 4: 0, 5: 1 });
    expect(summary.count).toBe(3);
    expect(summary.average).toBe(3.7);
  });
});
