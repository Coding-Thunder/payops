import type { NextRequest } from "next/server";
import { z } from "zod";

import { disposableEmailRefinement } from "@/lib/validation/disposable-email";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { verifyTurnstile } from "@/server/auth/turnstile";
import { submitReview } from "@/server/services/review.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public review submission.
 *
 * Anyone on the internet can call this, so the defences are stacked:
 * Turnstile, a tight rate limit, a small body cap, a disposable-email
 * refusal, and same-origin CSRF checking in `withApi`.
 *
 * None of that is what keeps a hostile submission off the marketing site,
 * though. THAT property comes from the shape of the schema below: there is no
 * `status`, no `approvedAt`, no `moderatedByEmail` and no `id` field, so no
 * request body can express "publish this". Zod strips unknown keys, and
 * `submitReview` hard-codes PENDING. Publishing is an admin action taken by a
 * named operator in the console.
 *
 * The response is constant whatever happens, so submission never reveals
 * whether this address has reviewed before.
 */
const reviewSchema = z.object({
  authorName: z.string().trim().min(2, "Please enter your name").max(120),
  authorEmail: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email")
    .max(254)
    .refine(...disposableEmailRefinement),
  authorTitle: z.string().trim().max(120).optional(),
  authorCompany: z.string().trim().max(160).optional(),
  // Whole stars only. `.int()` rejects 4.5 and NaN before the model sees it.
  rating: z.coerce.number().int().min(1).max(5),
  title: z.string().trim().min(4, "Add a short headline").max(140),
  body: z
    .string()
    .trim()
    .min(40, "Tell us a little more — at least a sentence or two")
    .max(4000),
  cfToken: z.string().max(2048).optional(),
});

export const POST = withApi(
  async (req: NextRequest) => {
    const body = await req.json();
    const input = reviewSchema.parse(body);
    const ctx = await getRequestContext();
    await verifyTurnstile({ token: input.cfToken, remoteIp: ctx.ip });

    await submitReview({
      authorName: input.authorName,
      authorEmail: input.authorEmail,
      authorTitle: input.authorTitle || null,
      authorCompany: input.authorCompany || null,
      rating: input.rating,
      title: input.title,
      body: input.body,
      // Recorded for abuse investigation only. It never influences whether a
      // review is accepted, and it is never shown publicly.
      ip: ctx.ip ?? null,
    });

    return jsonOk({ ok: true });
  },
  {
    // Tighter than the beta form: a review is a once-in-a-relationship act,
    // and three attempts an hour is generous for a person and useless for a
    // script.
    rateLimit: { route: "review-submit", max: 3, windowMs: 60 * 60_000 },
    bodyLimitBytes: 16 * 1024,
  },
);
