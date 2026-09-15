import type { Metadata } from "next";
import Link from "next/link";
import { StarIcon } from "lucide-react";

import { BrandFooter } from "@/components/marketing/brand-footer";
import { BrandNav } from "@/components/marketing/brand-nav";
import { ReviewForm } from "@/components/marketing/reviews/review-form";
import { env } from "@/lib/env";
import { SITE_NAME, absoluteUrl, pageMetadata } from "@/lib/seo";
import {
  aggregateRatingJsonLd,
  getReviewSummary,
  listApprovedReviews,
  type PublicReview,
  type ReviewSummary,
} from "@/server/services/review.service";

export const dynamic = "force-dynamic";

const PATH = "/reviews";
const DESCRIPTION =
  "Reviews of TraceTxn from the agencies and freelancers using it. Every review is moderated before it appears, published as written, and never edited.";

export const metadata: Metadata = pageMetadata({
  title: "Reviews",
  description: DESCRIPTION,
  path: PATH,
});

/**
 * `/reviews` — real reviews, or an honest absence of them.
 *
 * ── The rule this page exists to keep ────────────────────────────────────
 *
 * TraceTxn is a private beta. It has no case studies and, at the time this
 * shipped, no approved reviews. Every convention of a reviews page — a big
 * average, a star bar, a wall of quotes, `aggregateRating` in the structured
 * data — is therefore something this page must be capable of NOT doing.
 *
 * So nothing here is seeded, illustrative or placeholder. With no approved
 * reviews the page renders an empty state and emits no rating markup at all;
 * `aggregateRatingJsonLd()` returns null below two reviews, and the `Review`
 * nodes are built from stored rows or omitted entirely.
 *
 * The reason to be strict rather than tasteful about it: fabricated review
 * markup is a manual-action offence at Google and a false statement about
 * other people's opinions everywhere else. There is no small amount of it
 * that is fine.
 */

function Stars({ value, label }: { value: number; label?: string }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={label ?? `${value} out of 5`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <StarIcon
          key={star}
          aria-hidden
          className={`size-4 ${
            star <= Math.round(value)
              ? "fill-amber-400 text-amber-400"
              : "text-muted-foreground/25"
          }`}
        />
      ))}
    </span>
  );
}

function ReviewCard({ review }: { review: PublicReview }) {
  const attribution = [review.authorTitle, review.authorCompany]
    .filter(Boolean)
    .join(", ");
  return (
    <li className="rounded-2xl border border-border bg-card p-6">
      <Stars value={review.rating} label={`Rated ${review.rating} out of 5`} />
      <h3 className="mt-3 font-display text-[16px] font-semibold tracking-tight">
        {review.title}
      </h3>
      {/* Plain text in a text node. Review bodies are public submissions and
          are never parsed as markdown or HTML — React escapes them and that
          is the whole of the rendering story. `whitespace-pre-line` keeps the
          author's paragraph breaks without interpreting anything. */}
      <p className="mt-2.5 whitespace-pre-line text-[14.5px] leading-relaxed text-muted-foreground">
        {review.body}
      </p>
      <p className="mt-4 text-[12.5px] text-foreground">
        {review.authorName}
        {attribution ? (
          <span className="text-muted-foreground"> · {attribution}</span>
        ) : null}
      </p>
    </li>
  );
}

function Distribution({ summary }: { summary: ReviewSummary }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6">
      <div className="flex items-baseline gap-3">
        <span className="font-display text-[36px] font-semibold leading-none tracking-tight">
          {summary.average?.toFixed(1)}
        </span>
        <Stars value={summary.average ?? 0} />
        <span className="text-[13px] text-muted-foreground">
          {summary.count} review{summary.count === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="mt-5 space-y-1.5">
        {[5, 4, 3, 2, 1].map((star) => {
          const n = summary.distribution[star] ?? 0;
          const pct = summary.count ? (n / summary.count) * 100 : 0;
          return (
            <li key={star} className="flex items-center gap-3 text-[12px]">
              <span className="w-8 text-muted-foreground">{star}★</span>
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-amber-400"
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="w-6 text-right text-muted-foreground">{n}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default async function ReviewsPage() {
  // A database blip must not 500 a public, indexable page. The empty state
  // below is the correct rendering of "we have nothing to show right now".
  const [reviews, summary, aggregate] = await Promise.all([
    listApprovedReviews(24).catch(() => [] as PublicReview[]),
    getReviewSummary().catch(
      () =>
        ({
          count: 0,
          average: null,
          distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
        }) as ReviewSummary,
    ),
    aggregateRatingJsonLd().catch(() => null),
  ]);

  /**
   * Structured data. Note what is CONDITIONAL:
   *  - `aggregateRating` only when two or more real reviews exist.
   *  - `review` only for reviews that are actually stored and approved.
   * With an empty collection the node carries neither, which is the correct
   * statement: a product with no ratings.
   */
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${absoluteUrl("/")}#software`,
    name: SITE_NAME,
    applicationCategory: "BusinessApplication",
    ...(aggregate ? { aggregateRating: aggregate } : {}),
    ...(reviews.length
      ? {
          review: reviews.slice(0, 12).map((r) => ({
            "@type": "Review",
            reviewRating: {
              "@type": "Rating",
              ratingValue: r.rating,
              bestRating: 5,
              worstRating: 1,
            },
            name: r.title,
            reviewBody: r.body,
            datePublished: r.approvedAt,
            author: { "@type": "Person", name: r.authorName },
          })),
        }
      : {}),
  };

  return (
    <div className="min-h-dvh bg-background">
      <BrandNav />
      {/* Escaped `<` so a review body containing `</script>` cannot end the
          block early. Unlike the rest of the site's JSON-LD, this graph
          carries text written by the public. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
        }}
      />

      <main className="mx-auto max-w-[1024px] px-6 py-14 sm:px-10">
        <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Reviews
        </p>
        <h1 className="mt-3 max-w-[22ch] font-display text-[34px] font-semibold leading-[1.12] tracking-tight sm:text-[42px]">
          What people using TraceTxn say
        </h1>
        <p className="mt-5 max-w-[64ch] text-[16px] leading-relaxed text-muted-foreground">
          {DESCRIPTION}
        </p>

        <div className="mt-12 grid gap-10 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div>
            {summary.count > 0 ? (
              <Distribution summary={summary} />
            ) : (
              <div className="rounded-2xl border border-border bg-card p-8">
                <h2 className="font-display text-[18px] font-semibold tracking-tight">
                  No reviews published yet.
                </h2>
                <p className="mt-2.5 max-w-[52ch] text-[14px] leading-relaxed text-muted-foreground">
                  TraceTxn is in a private beta, and we would rather show
                  nothing than show something we wrote ourselves. When people
                  using it send reviews, they will appear here as written.
                </p>
                <p className="mt-4 max-w-[52ch] text-[14px] leading-relaxed text-muted-foreground">
                  In the meantime,{" "}
                  <Link
                    href="/client-management"
                    className="font-medium text-primary hover:underline"
                  >
                    see what the product actually does
                  </Link>{" "}
                  and judge it on that.
                </p>
              </div>
            )}

            {reviews.length ? (
              <ul className="mt-8 space-y-5">
                {reviews.map((review) => (
                  <ReviewCard key={review.id} review={review} />
                ))}
              </ul>
            ) : null}
          </div>

          <div>
            <h2 className="font-display text-[18px] font-semibold tracking-tight">
              Used TraceTxn? Tell us how it went.
            </h2>
            <p className="mt-2 max-w-[46ch] text-[13.5px] leading-relaxed text-muted-foreground">
              Critical reviews are as welcome as positive ones. We publish them
              as written or not at all.
            </p>
            <div className="mt-5">
              <ReviewForm
                turnstileSiteKey={
                  env.public.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null
                }
              />
            </div>
          </div>
        </div>
      </main>

      <BrandFooter />
    </div>
  );
}
