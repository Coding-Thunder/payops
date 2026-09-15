import {
  Schema,
  type HydratedDocument,
  type Model,
  type Types,
} from "mongoose";

import { registerModel } from "./register";

/**
 * A customer review.
 *
 * ── Moderation is the whole design ───────────────────────────────────────
 *
 * Anyone on the internet can submit one of these. Every consequence of that
 * is handled by making PENDING the only state a submission can create:
 *
 *   - `status` is NEVER read from a request body. The public route hard-codes
 *     PENDING; approving is a separate admin-authenticated action. There is
 *     no field a submitter can set that puts text on the marketing site.
 *   - Public reads filter on `status: APPROVED`, so a pending or rejected
 *     review is invisible — not merely unstyled or collapsed.
 *   - The reviewer's email is stored but NEVER returned by a public read. It
 *     exists so a moderator can verify a submission and reach the person; it
 *     is not part of the review.
 *
 * ── What is deliberately absent ──────────────────────────────────────────
 *
 * There is no "verified purchase" flag and no seeded or example review.
 * TraceTxn is a private beta: it has no customers to quote yet, and a review
 * table pre-filled with plausible-sounding entries would be fabricated
 * testimony published under the company's name. The collection starts empty
 * and the public page renders an honest empty state until a real person
 * submits something a moderator approves.
 *
 * That is also why `aggregateRating` JSON-LD is emitted only from genuinely
 * approved reviews, and not at all when there are none — see
 * `review.service.ts`.
 */

export const REVIEW_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const ReviewStatusValue = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
} as const satisfies Record<string, ReviewStatus>;

export const REVIEW_RATING_MIN = 1;
export const REVIEW_RATING_MAX = 5;

export interface ReviewDoc {
  _id: Types.ObjectId;
  /** Display name. Shown publicly once approved. */
  authorName: string;
  /**
   * Contact address for the reviewer. PRIVATE — stored for moderation and
   * never included in any public projection. See `toPublicReview`.
   */
  authorEmail: string;
  /** Optional "Founder, Studio X" line. Shown publicly. */
  authorTitle: string | null;
  authorCompany: string | null;
  /** Whole number, 1–5. */
  rating: number;
  title: string;
  body: string;
  status: ReviewStatus;
  /** Set when a moderator approves; the public sort key. */
  approvedAt: Date | null;
  moderatedByEmail: string | null;
  moderatedAt: Date | null;
  /** Internal only. Never public. */
  moderationNote: string | null;
  /**
   * Submitting IP, for abuse investigation only. Never public, never used to
   * make an automatic decision.
   */
  submittedIp: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ReviewDocument = HydratedDocument<ReviewDoc>;

const reviewSchema = new Schema<ReviewDoc>(
  {
    authorName: { type: String, required: true, trim: true, maxlength: 120 },
    authorEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
    },
    authorTitle: { type: String, default: null, trim: true, maxlength: 120 },
    authorCompany: { type: String, default: null, trim: true, maxlength: 160 },
    rating: {
      type: Number,
      required: true,
      min: REVIEW_RATING_MIN,
      max: REVIEW_RATING_MAX,
      // Rejects 4.5, NaN and Infinity at the schema level, so a half-star
      // cannot arrive through any path that skips the route's validation.
      validate: {
        validator: (v: number) => Number.isInteger(v),
        message: "Rating must be a whole number of stars",
      },
    },
    title: { type: String, required: true, trim: true, maxlength: 140 },
    body: { type: String, required: true, trim: true, maxlength: 4000 },
    status: {
      type: String,
      required: true,
      enum: REVIEW_STATUSES,
      // The important default. A document created without an explicit status
      // is pending, never public.
      default: ReviewStatusValue.PENDING,
    },
    approvedAt: { type: Date, default: null },
    moderatedByEmail: { type: String, default: null, trim: true, maxlength: 254 },
    moderatedAt: { type: Date, default: null },
    moderationNote: { type: String, default: null, trim: true, maxlength: 2000 },
    submittedIp: { type: String, default: null, trim: true, maxlength: 64 },
  },
  { timestamps: true, versionKey: false, collection: "reviews" },
);

/** The public read: approved reviews, newest approval first. */
reviewSchema.index({ status: 1, approvedAt: -1 });

/** The moderation queue. */
reviewSchema.index({ status: 1, createdAt: -1 });

/**
 * One review per email. Not a unique constraint — a genuine customer may have
 * more to say later — but the index makes the "has this person submitted
 * before?" check a moderator needs cheap.
 */
reviewSchema.index({ authorEmail: 1, createdAt: -1 });

export const Review = registerModel<ReviewDoc>("Review", reviewSchema);
