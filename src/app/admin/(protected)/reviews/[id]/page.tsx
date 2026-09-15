import Link from "next/link";
import { notFound } from "next/navigation";

import { ReviewActions } from "@/console/components/review-actions";
import { Badge, Field, fmtDateTime } from "@/console/components/ui";
import { ADMIN_BASE } from "@/console/lib/paths";
import { getReview, otherReviewsByAuthor } from "@/console/server/services/reviews";
import { requireAdminPage } from "@/console/server/auth/session";

export const dynamic = "force-dynamic";

function tone(status: string): "good" | "warn" | "bad" | "default" {
  if (status === "APPROVED") return "good";
  if (status === "PENDING") return "warn";
  if (status === "REJECTED") return "bad";
  return "default";
}

/**
 * One review, with the context a moderation decision actually needs: the full
 * text as submitted, who sent it, and what else that address has sent.
 *
 * The body is rendered as a plain text node. It is public submission text and
 * is never parsed as markdown or HTML anywhere in the app — not on the public
 * page and not here, where the reader is an authenticated admin and the cost
 * of a mistake is correspondingly higher.
 */
export default async function ReviewDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Defence in depth. `src/proxy.ts` already refuses this request without a
  // valid admin session, so nothing should reach here unauthenticated — but a
  // layout `redirect()` does NOT stop a page rendering (the App Router runs
  // them concurrently and attaches the rendered payload to the 307), so the
  // guard has to be awaited HERE, before any data is read, for this page to be
  // safe on its own. Awaiting it first is the whole point: it must precede
  // every query below.
  await requireAdminPage();
  const { id } = await params;
  const review = await getReview(id);
  if (!review) notFound();

  const others = await otherReviewsByAuthor(review.authorEmail, review.id);

  return (
    <div className="space-y-4">
      <Link
        href={`${ADMIN_BASE}/reviews`}
        className="text-[12px] text-[var(--muted)] hover:text-slate-200"
      >
        ← Back to reviews
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-100">{review.title}</h1>
        <div className="flex items-center gap-3">
          <span className="text-amber-300">
            {"★".repeat(review.rating)}
            <span className="text-[var(--muted)]">
              {"★".repeat(5 - review.rating)}
            </span>
          </span>
          <Badge tone={tone(review.status)}>{review.status}</Badge>
        </div>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5">
        <div className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
          The review, as submitted
        </div>
        <p className="mt-3 whitespace-pre-wrap text-[14px] leading-relaxed text-slate-200">
          {review.body}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 sm:grid-cols-3">
        <Field label="Name" value={review.authorName} />
        <Field label="Email (never public)" value={review.authorEmail} />
        <Field label="Role" value={review.authorTitle ?? "—"} />
        <Field label="Business" value={review.authorCompany ?? "—"} />
        <Field label="Submitted" value={fmtDateTime(review.createdAt)} />
        <Field label="Published" value={fmtDateTime(review.approvedAt)} />
        <Field label="Moderated" value={fmtDateTime(review.moderatedAt)} />
        <Field label="Moderated by" value={review.moderatedByEmail ?? "—"} />
        {/* Recorded for abuse investigation only. It never drives an
            automatic decision, and it is never public. */}
        <Field label="Submitted from" value={review.submittedIp ?? "—"} />
      </div>

      {others.length ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="text-[11px] uppercase tracking-wider text-amber-200/80">
            {others.length} other submission
            {others.length === 1 ? "" : "s"} from this address
          </div>
          <p className="mt-1 text-[12px] text-[var(--muted)]">
            Context, not a verdict — a returning customer with more to say
            looks the same here as a scripted submitter.
          </p>
          <ul className="mt-3 space-y-2">
            {others.map((o) => (
              <li key={o.id} className="text-[13px]">
                <Link
                  href={`${ADMIN_BASE}/reviews/${o.id}`}
                  prefetch={false}
                  className="text-slate-200 hover:text-[var(--accent)]"
                >
                  {"★".repeat(o.rating)} {o.title}
                </Link>
                <span className="ml-2 text-[11px] text-[var(--muted)]">
                  {o.status} · {fmtDateTime(o.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ReviewActions
        id={review.id}
        status={review.status}
        note={review.moderationNote ?? ""}
      />
    </div>
  );
}
