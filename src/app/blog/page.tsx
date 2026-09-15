import type { Metadata } from "next";
import Link from "next/link";

import { BlogShell } from "@/components/marketing/blog/blog-shell";
import { BLOG_INDEX_PATH, blogPostPath } from "@/lib/blog/slug";
import { SITE_NAME, absoluteUrl, pageMetadata } from "@/lib/seo";
import { listPublishedPosts, type BlogSummary } from "@/server/services/blog.service";

export const dynamic = "force-dynamic";

const TITLE = "Client management guides for agencies and freelancers";
const DESCRIPTION =
  "Practical writing on running client work: what belongs in a client record, how to chase an unpaid invoice, and how to keep a client history that survives staff turnover.";

export const metadata: Metadata = pageMetadata({
  title: "Blog",
  description: DESCRIPTION,
  path: BLOG_INDEX_PATH,
  socialTitle: `${TITLE} • ${SITE_NAME}`,
});

/**
 * `/blog` — the article index.
 *
 * `force-dynamic` rather than a revalidating cache: publishing is an editorial
 * action taken in the admin console, and an author who clicks Publish and then
 * checks the public page must see the post. A stale index would read as the
 * publish having failed, and the query is a single indexed find with the body
 * projected away.
 *
 * A database that is unreachable renders the empty state rather than a 500 —
 * see the note on the catch below.
 */

function PostCard({ post }: { post: BlogSummary }) {
  return (
    <article className="group border-b border-border py-8 first:pt-0 last:border-0">
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
        <time dateTime={post.publishedAt}>
          {new Date(post.publishedAt).toLocaleDateString("en-US", {
            year: "numeric",
            month: "long",
            day: "numeric",
            timeZone: "UTC",
          })}
        </time>
        <span aria-hidden>·</span>
        <span>{post.readingMinutes} min read</span>
        {post.tags.slice(0, 2).map((tag) => (
          <span
            key={tag}
            className="rounded-full border border-border px-2 py-0.5 text-[11px] capitalize"
          >
            {tag}
          </span>
        ))}
      </div>

      <h2 className="mt-3 font-display text-[22px] font-semibold leading-snug tracking-tight">
        <Link
          href={blogPostPath(post.slug)}
          className="text-foreground hover:text-primary"
        >
          {post.title}
        </Link>
      </h2>

      <p className="mt-2.5 max-w-[70ch] text-[15px] leading-relaxed text-muted-foreground">
        {post.excerpt}
      </p>

      <Link
        href={blogPostPath(post.slug)}
        className="mt-4 inline-flex text-[13.5px] font-medium text-primary hover:underline"
      >
        Read the article →
      </Link>
    </article>
  );
}

export default async function BlogIndexPage() {
  let posts: BlogSummary[] = [];
  try {
    posts = await listPublishedPosts({ limit: 50 });
  } catch {
    // A marketing page must not 500 because Mongo is briefly unreachable.
    // An empty index is a worse page; a 500 on a crawled, indexed URL is a
    // worse SITE. The empty state below is honest about there being nothing
    // to show, and the next request retries.
    posts = [];
  }

  /**
   * `Blog` + `ItemList` rather than a bare list of Articles: it tells a
   * crawler this URL is the collection and each entry has its own page,
   * which is what earns the individual posts their own listings.
   */
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Blog",
    "@id": `${absoluteUrl(BLOG_INDEX_PATH)}#blog`,
    url: absoluteUrl(BLOG_INDEX_PATH),
    name: `${SITE_NAME} Blog`,
    description: DESCRIPTION,
    publisher: { "@id": `${absoluteUrl("/")}#organization` },
    blogPost: posts.slice(0, 20).map((p) => ({
      "@type": "BlogPosting",
      headline: p.title,
      description: p.excerpt,
      url: absoluteUrl(blogPostPath(p.slug)),
      datePublished: p.publishedAt,
      dateModified: p.updatedAt,
      author: { "@type": "Person", name: p.authorName },
    })),
  };

  return (
    <BlogShell
      crumbs={[
        { label: "Home", href: "/" },
        { label: "Blog", href: BLOG_INDEX_PATH, current: true },
      ]}
      jsonLd={jsonLd}
    >
      <div className="mx-auto max-w-[1024px] px-6 py-12 sm:px-10">
        <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Blog
        </p>
        <h1 className="mt-3 max-w-[24ch] font-display text-[34px] font-semibold leading-[1.12] tracking-tight sm:text-[42px]">
          {TITLE}
        </h1>
        <p className="mt-5 max-w-[68ch] text-[16px] leading-relaxed text-muted-foreground">
          {DESCRIPTION}
        </p>

        <div className="mt-12 max-w-[76ch]">
          {posts.length ? (
            posts.map((post) => <PostCard key={post.slug} post={post} />)
          ) : (
            <div className="rounded-2xl border border-border bg-card p-10 text-center">
              <h2 className="font-display text-[18px] font-semibold tracking-tight">
                Nothing published yet.
              </h2>
              <p className="mx-auto mt-2 max-w-[46ch] text-[14px] leading-relaxed text-muted-foreground">
                We&apos;re writing. In the meantime, the{" "}
                <Link
                  href="/client-management"
                  className="font-medium text-primary hover:underline"
                >
                  client management guide
                </Link>{" "}
                covers how we think about keeping a client record.
              </p>
            </div>
          )}
        </div>
      </div>
    </BlogShell>
  );
}
