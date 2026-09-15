"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useConfirm } from "@/console/components/confirm-dialog";
import { ADMIN_API, ADMIN_BASE } from "@/console/lib/paths";
import { slugifyTitle } from "@/lib/blog/slug";

/**
 * Blog post editor.
 *
 * The UI decides which buttons to SHOW; the server decides what is allowed.
 * Every guard visible here — slug locked after publication, delete hidden for
 * a published post, publish as a separate action — is enforced again in
 * `@/console/server/services/blog`, because a disabled input is a hint, not a
 * control. Removing `disabled` in devtools changes nothing.
 *
 * Preview is client-side and renders the same components the public page
 * uses, so what an author sees before publishing is what a reader gets. It is
 * NOT a "preview URL": there is no token-gated public route that serves a
 * draft, which would be a second, weaker publication path.
 */

export interface BlogEditorPost {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  body: string;
  coverImageUrl: string | null;
  coverImageAlt: string | null;
  authorName: string;
  tags: string[];
  status: string;
  everPublished: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
}

const field =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm text-slate-100 outline-none focus:border-[var(--accent)]";
const labelCls =
  "block text-[11px] uppercase tracking-wider text-[var(--muted)]";

export function BlogEditor({
  post,
  preview,
}: {
  /** Absent when creating. */
  post?: BlogEditorPost;
  /** Rendered preview of the current body, supplied by the server page. */
  preview?: React.ReactNode;
}) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const isNew = !post;

  const [title, setTitle] = React.useState(post?.title ?? "");
  /**
   * The slug the author typed, or null while they have not touched the field.
   *
   * Held as an override rather than as state synchronised from the title by
   * an effect: the suggestion is DERIVED, so deriving it during render is
   * both simpler and free of the cascading re-render an effect would cause.
   * Once this is non-null the author has taken control and the title stops
   * driving it — which is what keeps a title tweak from silently moving a URL.
   */
  const [slugOverride, setSlugOverride] = React.useState<string | null>(
    post ? post.slug : null,
  );
  const [excerpt, setExcerpt] = React.useState(post?.excerpt ?? "");
  const [body, setBody] = React.useState(post?.body ?? "");
  const [coverImageUrl, setCoverImageUrl] = React.useState(
    post?.coverImageUrl ?? "",
  );
  const [coverImageAlt, setCoverImageAlt] = React.useState(
    post?.coverImageAlt ?? "",
  );
  const [authorName, setAuthorName] = React.useState(post?.authorName ?? "");
  const [tags, setTags] = React.useState((post?.tags ?? []).join(", "));
  const [seoTitle, setSeoTitle] = React.useState(post?.seoTitle ?? "");
  const [seoDescription, setSeoDescription] = React.useState(
    post?.seoDescription ?? "",
  );
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Suggested from the title until the author edits the field.
  const slug = slugOverride ?? slugifyTitle(title);
  const slugLocked = Boolean(post?.everPublished);

  function payload() {
    return {
      slug: slug.trim(),
      title: title.trim(),
      excerpt: excerpt.trim() || null,
      body,
      coverImageUrl: coverImageUrl.trim() || null,
      coverImageAlt: coverImageAlt.trim() || null,
      authorName: authorName.trim() || null,
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      seoTitle: seoTitle.trim() || null,
      seoDescription: seoDescription.trim() || null,
    };
  }

  async function call(
    action: string,
    path: string,
    init: RequestInit,
  ): Promise<Record<string, unknown> | null> {
    if (busy) return null;
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(path, init);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error?.message ?? "Action failed");
      }
      return json?.data ?? {};
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
      return null;
    } finally {
      setBusy(null);
    }
  }

  const save = async () => {
    const json = { "content-type": "application/json" };
    if (isNew) {
      const data = await call("save", `${ADMIN_API}/blog`, {
        method: "POST",
        headers: json,
        body: JSON.stringify(payload()),
      });
      if (data?.id) router.push(`${ADMIN_BASE}/blog/${String(data.id)}`);
      return;
    }
    const data = await call("save", `${ADMIN_API}/blog/${post.id}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify(payload()),
    });
    if (data) router.refresh();
  };

  const publish = () =>
    confirm(
      {
        title: "Publish this post?",
        body: "It becomes readable by anyone with the URL, appears on /blog, and enters the sitemap. The slug becomes permanent.",
        confirmLabel: "Publish",
      },
      async () => {
        // Save first: publishing what is on screen, not what was last saved,
        // is the only behaviour that is not a trap.
        await save();
        await call("publish", `${ADMIN_API}/blog/${post!.id}?action=publish`, {
          method: "POST",
        });
        router.refresh();
      },
    );

  const unpublish = () =>
    confirm(
      {
        title: "Unpublish this post?",
        body: "It disappears from /blog and the sitemap and starts returning 404. The URL stays reserved and the original publication date is kept, so re-publishing restores it exactly.",
        confirmLabel: "Unpublish",
      },
      async () => {
        await call(
          "unpublish",
          `${ADMIN_API}/blog/${post!.id}?action=unpublish`,
          { method: "POST" },
        );
        router.refresh();
      },
    );

  const remove = () =>
    confirm(
      {
        title: "Delete this draft?",
        body: "Permanent. Only drafts that have never been published can be deleted.",
        confirmLabel: "Delete",
        tone: "danger",
      },
      async () => {
        const data = await call("delete", `${ADMIN_API}/blog/${post!.id}`, {
          method: "DELETE",
        });
        if (data) router.push(`${ADMIN_BASE}/blog`);
      },
    );

  return (
    <div className="space-y-4">
      {dialog}

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-[13px] text-red-200"
        >
          {error}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
            <div>
              <label className={labelCls} htmlFor="bp-title">
                Title
              </label>
              <input
                id="bp-title"
                className={`${field} mt-1`}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
              />
            </div>

            <div>
              <label className={labelCls} htmlFor="bp-slug">
                Slug {slugLocked ? "(permanent — post has been published)" : ""}
              </label>
              <input
                id="bp-slug"
                className={`${field} mt-1 font-mono`}
                value={slug}
                onChange={(e) => setSlugOverride(e.target.value)}
                disabled={slugLocked}
                maxLength={80}
              />
              <p className="mt-1 text-[11px] text-[var(--muted)]">
                /blog/{slug || "…"}
              </p>
            </div>

            <div>
              <label className={labelCls} htmlFor="bp-excerpt">
                Excerpt (optional — derived from the body when blank)
              </label>
              <textarea
                id="bp-excerpt"
                className={`${field} mt-1`}
                rows={2}
                value={excerpt}
                onChange={(e) => setExcerpt(e.target.value)}
                maxLength={400}
              />
            </div>

            <div>
              <label className={labelCls} htmlFor="bp-body">
                Body (Markdown)
              </label>
              <textarea
                id="bp-body"
                className={`${field} mt-1 font-mono text-[13px]`}
                rows={26}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={100_000}
              />
              <p className="mt-1 text-[11px] text-[var(--muted)]">
                ## and ### headings, - and 1. lists, &gt; quotes, ```code```,
                **bold**, *italic*, `code`, [links](/path) and
                ![alt](https://image). Raw HTML is not rendered — it appears as
                text.
              </p>
            </div>
          </div>

          {preview ? (
            <details className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
              <summary className="cursor-pointer text-[12px] uppercase tracking-wider text-[var(--muted)]">
                Preview (last saved version)
              </summary>
              <div className="mt-4 rounded-lg bg-white p-6">{preview}</div>
            </details>
          ) : null}
        </div>

        <div className="space-y-4">
          <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
            <button
              onClick={save}
              disabled={Boolean(busy)}
              className="w-full rounded-lg border border-[var(--border)] bg-white/10 px-3 py-2 text-sm text-slate-100 hover:bg-white/15 disabled:opacity-50"
            >
              {busy === "save" ? "Saving…" : isNew ? "Create draft" : "Save"}
            </button>

            {!isNew && post.status !== "PUBLISHED" ? (
              <button
                onClick={publish}
                disabled={Boolean(busy)}
                className="w-full rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50"
              >
                Save &amp; publish
              </button>
            ) : null}

            {!isNew && post.status === "PUBLISHED" ? (
              <button
                onClick={unpublish}
                disabled={Boolean(busy)}
                className="w-full rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
              >
                Unpublish
              </button>
            ) : null}

            {!isNew && !post.everPublished ? (
              <button
                onClick={remove}
                disabled={Boolean(busy)}
                className="w-full rounded-lg border border-red-500/40 px-3 py-2 text-sm text-red-300 hover:bg-red-500/10 disabled:opacity-50"
              >
                Delete draft
              </button>
            ) : null}
          </div>

          <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
            <p className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
              Metadata
            </p>
            <div>
              <label className={labelCls} htmlFor="bp-author">
                Author byline
              </label>
              <input
                id="bp-author"
                className={`${field} mt-1`}
                value={authorName}
                onChange={(e) => setAuthorName(e.target.value)}
                maxLength={120}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="bp-tags">
                Tags (comma separated, max 8)
              </label>
              <input
                id="bp-tags"
                className={`${field} mt-1`}
                value={tags}
                onChange={(e) => setTags(e.target.value)}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="bp-cover">
                Cover image URL (https only)
              </label>
              <input
                id="bp-cover"
                className={`${field} mt-1`}
                value={coverImageUrl}
                onChange={(e) => setCoverImageUrl(e.target.value)}
                placeholder="https://… or /marketing/…"
                maxLength={2048}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="bp-cover-alt">
                Cover alt text (required with an image)
              </label>
              <input
                id="bp-cover-alt"
                className={`${field} mt-1`}
                value={coverImageAlt}
                onChange={(e) => setCoverImageAlt(e.target.value)}
                maxLength={300}
              />
            </div>
          </div>

          <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
            <p className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
              SEO overrides
            </p>
            <div>
              <label className={labelCls} htmlFor="bp-seo-title">
                Title tag (defaults to the post title)
              </label>
              <input
                id="bp-seo-title"
                className={`${field} mt-1`}
                value={seoTitle}
                onChange={(e) => setSeoTitle(e.target.value)}
                maxLength={200}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="bp-seo-desc">
                Meta description (defaults to the excerpt)
              </label>
              <textarea
                id="bp-seo-desc"
                className={`${field} mt-1`}
                rows={3}
                value={seoDescription}
                onChange={(e) => setSeoDescription(e.target.value)}
                maxLength={400}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
