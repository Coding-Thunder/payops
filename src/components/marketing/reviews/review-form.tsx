"use client";

import { useState } from "react";
import { CheckCircle2Icon, StarIcon } from "lucide-react";

import { TurnstileWidget } from "@/components/common/turnstile-widget";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingButton } from "@/components/ui/loading-button";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiClientError } from "@/lib/api-client";
import {
  DATA_LAYER_EVENTS,
  pushDataLayerEvent,
} from "@/lib/analytics/data-layer";

/**
 * Review submission form.
 *
 * Posts to /api/reviews, which stores a PENDING review. Nothing written here
 * appears on the site until a moderator approves it, and the copy says so —
 * a form that implies instant publication and then silently queues the
 * submission reads as a broken site.
 *
 * The whole form carries `data-clarity-mask`: it collects a name, a work
 * email, a job title, a company and free text about someone's business. The
 * shared `Input`/`Textarea` primitives already mask, but the star control is
 * a set of raw buttons, and masking the region covers anything added later.
 */

interface ReviewFormProps {
  turnstileSiteKey: string | null;
}

const STARS = [1, 2, 3, 4, 5] as const;

export function ReviewForm({ turnstileSiteKey }: ReviewFormProps) {
  const [authorName, setAuthorName] = useState("");
  const [authorEmail, setAuthorEmail] = useState("");
  const [authorTitle, setAuthorTitle] = useState("");
  const [authorCompany, setAuthorCompany] = useState("");
  const [rating, setRating] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [cfToken, setCfToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const requiresToken = Boolean(turnstileSiteKey);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!rating) {
      setError("Please choose a rating.");
      return;
    }
    if (requiresToken && !cfToken) {
      setError("Please complete the verification challenge first.");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/api/reviews", {
        authorName: authorName.trim(),
        authorEmail: authorEmail.trim(),
        authorTitle: authorTitle.trim() || undefined,
        authorCompany: authorCompany.trim() || undefined,
        rating,
        title: title.trim(),
        body: body.trim(),
        cfToken: cfToken ?? undefined,
      });
      // Fires on a stored submission, not on a published review — the two are
      // different events and only this one happens here. `rating` is a number
      // 1–5; nothing identifying is pushed.
      pushDataLayerEvent(DATA_LAYER_EVENTS.REVIEW_SUBMITTED, { rating });
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Couldn't submit, please retry.",
      );
      setCfToken(null);
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-2xl border border-border bg-white p-8 text-center shadow-sm">
        <span
          className="mx-auto inline-flex size-12 items-center justify-center rounded-full"
          style={{
            background: "color-mix(in oklch, var(--brand-emerald) 14%, white)",
            color: "var(--brand-emerald-strong)",
          }}
        >
          <CheckCircle2Icon className="size-6" />
        </span>
        <h2 className="mt-5 font-display text-[20px] font-semibold tracking-tight">
          Thank you — it&apos;s with us.
        </h2>
        <p className="mt-3 text-[13.5px] leading-relaxed text-muted-foreground">
          Every review is read by a person before it goes up, so it won&apos;t
          appear straight away. We don&apos;t edit reviews — we either publish
          them as written or we don&apos;t publish them.
        </p>
      </div>
    );
  }

  const shown = hovered || rating;

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      data-clarity-mask="true"
      className="space-y-5 rounded-2xl border border-border bg-white p-7 shadow-sm"
    >
      <fieldset>
        <legend className="text-[12px] font-medium text-foreground">
          Your rating
        </legend>
        {/* A radio group, not five buttons: it is keyboard-operable, exposes a
            single value to assistive technology, and submits a real value if
            JavaScript fails. The stars are the label, not the control. */}
        <div className="mt-2 flex items-center gap-1" role="radiogroup">
          {STARS.map((star) => (
            <label
              key={star}
              className="cursor-pointer p-0.5"
              onMouseEnter={() => setHovered(star)}
              onMouseLeave={() => setHovered(0)}
            >
              <input
                type="radio"
                name="rating"
                value={star}
                checked={rating === star}
                onChange={() => setRating(star)}
                className="sr-only"
              />
              <span className="sr-only">
                {star} star{star === 1 ? "" : "s"}
              </span>
              <StarIcon
                aria-hidden
                className={`size-7 transition-colors ${
                  star <= shown
                    ? "fill-amber-400 text-amber-400"
                    : "text-muted-foreground/30"
                }`}
              />
            </label>
          ))}
          {rating ? (
            <span className="ml-2 text-[13px] text-muted-foreground">
              {rating} of 5
            </span>
          ) : null}
        </div>
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor="rv-title" className="text-[12px]">
          Headline
        </Label>
        <Input
          id="rv-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={140}
          placeholder="One line that sums it up"
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="rv-body" className="text-[12px]">
          Your review
        </Label>
        <Textarea
          id="rv-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          maxLength={4000}
          placeholder="What were you doing before, what changed, and what would you tell someone considering it?"
          required
        />
        <p className="text-[11.5px] text-muted-foreground">
          {body.trim().length < 40
            ? "At least a sentence or two, please."
            : `${body.length} / 4000`}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="rv-name" className="text-[12px]">
            Your name
          </Label>
          <Input
            id="rv-name"
            value={authorName}
            onChange={(e) => setAuthorName(e.target.value)}
            maxLength={120}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rv-email" className="text-[12px]">
            Work email
          </Label>
          <Input
            id="rv-email"
            type="email"
            value={authorEmail}
            onChange={(e) => setAuthorEmail(e.target.value)}
            maxLength={254}
            required
          />
          {/* Say what happens to it, at the point it is asked for. */}
          <p className="text-[11.5px] text-muted-foreground">
            Never published. We use it only to check the review is genuine.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rv-role" className="text-[12px]">
            Role (optional)
          </Label>
          <Input
            id="rv-role"
            value={authorTitle}
            onChange={(e) => setAuthorTitle(e.target.value)}
            maxLength={120}
            placeholder="Founder"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rv-company" className="text-[12px]">
            Business (optional)
          </Label>
          <Input
            id="rv-company"
            value={authorCompany}
            onChange={(e) => setAuthorCompany(e.target.value)}
            maxLength={160}
          />
        </div>
      </div>

      <TurnstileWidget
        siteKey={turnstileSiteKey}
        onVerify={(t) => setCfToken(t)}
        onExpire={() => setCfToken(null)}
        onError={() => setCfToken(null)}
        className="flex justify-center"
      />

      {error ? (
        <p role="alert" className="text-[13px] text-red-600">
          {error}
        </p>
      ) : null}

      <LoadingButton type="submit" loading={submitting} className="w-full">
        Submit review
      </LoadingButton>

      <p className="text-[11.5px] leading-relaxed text-muted-foreground">
        Reviews are moderated before they appear. We publish critical reviews
        as readily as positive ones — we only reject submissions that are
        abusive, off-topic, or not from someone who has used TraceTxn.
      </p>
    </form>
  );
}
