import "server-only";

import {
  BetaApplication,
  BlogPost,
  Review,
} from "@/console/server/db/models";
import { connectMongo } from "@/console/server/db/mongoose";
import { DISPOSABLE_DOMAIN_COUNT } from "@/lib/validation/disposable-email";
import { assertConsoleAdmin } from "@/console/server/auth/session";

/**
 * Growth and content metrics for the admin overview.
 *
 * Everything here answers a question an operator would otherwise have to go
 * and count by hand: what is waiting on me, where are leads coming from, and
 * is anything being abused.
 *
 * ── Attribution counts are approximate on purpose ────────────────────────
 *
 * `topSources` groups leads by `attribution.utmSource`, which exists only for
 * applications submitted after attribution shipped and only for visitors who
 * arrived with a campaign tag. Direct traffic and every older lead land in
 * "Direct / unknown", and that bucket being large is expected rather than a
 * bug. It is labelled as such in the UI, because an unlabelled attribution
 * chart is read as complete and it is not.
 *
 * Nothing here makes a decision. These are counts on a dashboard.
 */

export interface GrowthMetrics {
  leads: {
    total: number;
    pending: number;
    /** Applications received in the last 7 days. */
    recent: number;
    /** How many carry any attribution at all. */
    attributed: number;
  };
  /** Lead counts by UTM source, largest first. Includes an unknown bucket. */
  topSources: { source: string; count: number }[];
  /** The landing pages leads actually arrived on, largest first. */
  topLandingPages: { path: string; count: number }[];
  blog: { total: number; published: number; drafts: number };
  reviews: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    /** Mean approved rating, or null when fewer than two exist. */
    averageRating: number | null;
  };
  abuse: {
    /** Disposable-mail providers currently refused at every public form. */
    blockedDomains: number;
    /** Addresses that submitted more than one review. Context, not a verdict. */
    repeatReviewers: number;
  };
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Group leads by one attribution field, with an explicit unknown bucket. */
async function groupByAttribution(
  field: "utmSource" | "landingPage",
  limit = 6,
): Promise<{ key: string; count: number }[]> {
  const rows = await BetaApplication.aggregate<{ _id: string | null; n: number }>(
    [
      { $group: { _id: `$attribution.${field}`, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: limit + 1 },
    ],
  );
  return rows.map((row) => ({
    // Null covers both "arrived directly" and "predates attribution"; the two
    // are genuinely indistinguishable in the data, so the label says so
    // rather than picking one.
    key: row._id ?? "Direct / unknown",
    count: row.n,
  }));
}

export async function getGrowthMetrics(): Promise<GrowthMetrics> {
  await assertConsoleAdmin();
  await connectMongo();
  const since = new Date(Date.now() - WEEK_MS);

  const [
    leadsTotal,
    leadsPending,
    leadsRecent,
    leadsAttributed,
    sources,
    landings,
    blogTotal,
    blogPublished,
    reviewsTotal,
    reviewsPending,
    reviewsApproved,
    reviewsRejected,
    ratingRows,
    repeatRows,
  ] = await Promise.all([
    BetaApplication.countDocuments({}),
    BetaApplication.countDocuments({ status: "PENDING" }),
    BetaApplication.countDocuments({ createdAt: { $gte: since } }),
    BetaApplication.countDocuments({ attribution: { $ne: null } }),
    groupByAttribution("utmSource"),
    groupByAttribution("landingPage"),
    BlogPost.countDocuments({}),
    BlogPost.countDocuments({ status: "PUBLISHED" }),
    Review.countDocuments({}),
    Review.countDocuments({ status: "PENDING" }),
    Review.countDocuments({ status: "APPROVED" }),
    Review.countDocuments({ status: "REJECTED" }),
    Review.aggregate<{ _id: null; avg: number; n: number }>([
      { $match: { status: "APPROVED" } },
      { $group: { _id: null, avg: { $avg: "$rating" }, n: { $sum: 1 } } },
    ]),
    Review.aggregate<{ _id: string; n: number }>([
      { $group: { _id: "$authorEmail", n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]),
  ]);

  const rating = ratingRows[0];

  return {
    leads: {
      total: leadsTotal,
      pending: leadsPending,
      recent: leadsRecent,
      attributed: leadsAttributed,
    },
    topSources: sources.map((s) => ({ source: s.key, count: s.count })),
    topLandingPages: landings.map((l) => ({ path: l.key, count: l.count })),
    blog: {
      total: blogTotal,
      published: blogPublished,
      drafts: blogTotal - blogPublished,
    },
    reviews: {
      total: reviewsTotal,
      pending: reviewsPending,
      approved: reviewsApproved,
      rejected: reviewsRejected,
      // Same rule as the public page: an average of one rating is not a
      // rating for the product.
      averageRating:
        rating && rating.n >= 2 ? Math.round(rating.avg * 10) / 10 : null,
    },
    abuse: {
      blockedDomains: DISPOSABLE_DOMAIN_COUNT,
      repeatReviewers: repeatRows.length,
    },
  };
}
