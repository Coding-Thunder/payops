import Link from "next/link";
import { notFound } from "next/navigation";

import { BlogContent } from "@/components/marketing/blog/blog-content";
import { BlogEditor } from "@/console/components/blog-editor";
import { Badge, fmtDateTime } from "@/console/components/ui";
import { ADMIN_BASE } from "@/console/lib/paths";
import { getBlogPost } from "@/console/server/services/blog";
import { blogPostPath } from "@/lib/blog/slug";
import { requireAdminPage } from "@/console/server/auth/session";

export const dynamic = "force-dynamic";

/**
 * Edit one post.
 *
 * The preview renders the SAME `BlogContent` the public article page uses, so
 * an author is not reviewing an approximation. It shows the last SAVED body:
 * rendering unsaved keystrokes would need the Markdown parser in the client
 * bundle, and the thing worth verifying before publishing is what is actually
 * stored.
 *
 * Reading a draft here is safe because this route is inside the console's
 * authenticated `(protected)` segment; the public service can never return it.
 */
export default async function EditBlogPostPage({
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
  const post = await getBlogPost(id);
  if (!post) notFound();

  return (
    <div className="space-y-4">
      <Link
        href={`${ADMIN_BASE}/blog`}
        className="text-[12px] text-[var(--muted)] hover:text-slate-200"
      >
        ← Back to blog
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-100">{post.title}</h1>
        <div className="flex items-center gap-3">
          <Badge tone={post.status === "PUBLISHED" ? "good" : "warn"}>
            {post.status}
          </Badge>
          {post.status === "PUBLISHED" ? (
            <a
              href={blogPostPath(post.slug)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[12px] text-[var(--accent)] hover:underline"
            >
              View live ↗
            </a>
          ) : null}
        </div>
      </div>

      <p className="text-[12px] text-[var(--muted)]">
        Published {fmtDateTime(post.publishedAt)} · Updated{" "}
        {fmtDateTime(post.updatedAt)} · {post.readingMinutes} min read
        {post.updatedByEmail ? ` · by ${post.updatedByEmail}` : ""}
      </p>

      <BlogEditor
        post={{
          id: post.id,
          slug: post.slug,
          title: post.title,
          excerpt: post.excerpt,
          body: post.body,
          coverImageUrl: post.coverImageUrl,
          coverImageAlt: post.coverImageAlt,
          authorName: post.authorName,
          tags: post.tags,
          status: post.status,
          everPublished: post.everPublished,
          seoTitle: post.seoTitle,
          seoDescription: post.seoDescription,
        }}
        preview={<BlogContent body={post.body} />}
      />
    </div>
  );
}
