import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BlogContent } from "@/components/marketing/blog/blog-content";
import { BlogShell } from "@/components/marketing/blog/blog-shell";
import { tableOfContents } from "@/lib/blog/markdown";
import { BLOG_INDEX_PATH, blogPostPath } from "@/lib/blog/slug";
import {
  CLIENT_MANAGEMENT_PATH,
  SITE_NAME,
  absoluteUrl,
  pageMetadata,
} from "@/lib/seo";
import {
  getPublishedPost,
  listRelatedPosts,
  type PublicBlogPost,
} from "@/server/services/blog.service";

export const dynamic = "force-dynamic";

/**
 * `/blog/[slug]` — one article.
 *
 * THE DRAFT BOUNDARY IS A 404, NOT A 403. `getPublishedPost` returns null for
 * a draft, a future publication date, and a slug that does not exist, and all
 * three render the same not-found page. A 403 would confirm that an
 * unpublished slug exists, which is exactly the thing an unpublished post
 * should not reveal.
 *
 * The same rule governs `generateMetadata`: it calls the same gated read, so
 * a draft cannot leak its title through a `<title>` tag on a 404 page.
 */

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPublishedPost(slug).catch(() => null);
  if (!post) {
    // Deliberately generic. Metadata for a URL that will render a 404 must
    // not describe what would have been there.
    return pageMetadata({
      title: "Article not found",
      description: "This article isn't available.",
      path: blogPostPath(slug),
      noindex: true,
    });
  }

  const meta = pageMetadata({
    title: post.seoTitle || post.title,
    description: post.seoDescription || post.excerpt,
    path: blogPostPath(post.slug),
  });

  return {
    ...meta,
    openGraph: {
      ...meta.openGraph,
      // `article`, not `website`: it is what makes a share card render a
      // byline and a date rather than a generic site preview.
      type: "article",
      publishedTime: post.publishedAt,
      modifiedTime: post.updatedAt,
      authors: [post.authorName],
      tags: post.tags,
      ...(post.coverImageUrl
        ? { images: [{ url: post.coverImageUrl, alt: post.coverImageAlt ?? post.title }] }
        : {}),
    },
    ...(post.coverImageUrl
      ? { twitter: { ...meta.twitter, images: [post.coverImageUrl] } }
      : {}),
  };
}

function articleJsonLd(post: PublicBlogPost) {
  const url = absoluteUrl(blogPostPath(post.slug));
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "@id": `${url}#article`,
    headline: post.title.slice(0, 110), // Google truncates beyond ~110
    description: post.seoDescription || post.excerpt,
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    datePublished: post.publishedAt,
    dateModified: post.updatedAt,
    author: { "@type": "Person", name: post.authorName },
    /**
     * The publisher is INLINED, not referenced by `@id`.
     *
     * It used to be `{ "@id": "<site>/#organization" }`, which resolves only
     * on the homepage. Structured-data consumers evaluate one page at a time,
     * so on the article itself that reference pointed at nothing and the
     * publisher had no name and no url — which is the field Google uses for
     * article attribution. The `@id` is kept so the node still merges with
     * the homepage graph for consumers that do crawl both.
     */
    publisher: {
      "@type": "Organization",
      "@id": `${absoluteUrl("/")}#organization`,
      name: SITE_NAME,
      url: absoluteUrl("/"),
    },
    ...(post.coverImageUrl ? { image: [post.coverImageUrl] } : {}),
    ...(post.tags.length ? { keywords: post.tags.join(", ") } : {}),
    inLanguage: "en-US",
    // Same reasoning: name the collection rather than only pointing at it.
    isPartOf: {
      "@type": "Blog",
      "@id": `${absoluteUrl(BLOG_INDEX_PATH)}#blog`,
      name: `${SITE_NAME} Blog`,
      url: absoluteUrl(BLOG_INDEX_PATH),
    },
  };
}

export default async function BlogPostPage({ params }: Params) {
  const { slug } = await params;
  const post = await getPublishedPost(slug).catch(() => null);
  if (!post) notFound();

  const [related, toc] = await Promise.all([
    listRelatedPosts(post.slug, post.tags, 3).catch(() => []),
    Promise.resolve(tableOfContents(post.body)),
  ]);

  const published = new Date(post.publishedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  return (
    <BlogShell
      crumbs={[
        { label: "Home", href: "/" },
        { label: "Blog", href: BLOG_INDEX_PATH },
        // The article's OWN url, so the last breadcrumb identifies this page
        // rather than repeating the index.
        { label: post.title, href: blogPostPath(post.slug), current: true },
      ]}
      jsonLd={articleJsonLd(post)}
    >
      <article className="mx-auto max-w-[1024px] px-6 py-12 sm:px-10">
        <header className="max-w-[72ch]">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
            <time dateTime={post.publishedAt}>{published}</time>
            <span aria-hidden>·</span>
            <span>{post.readingMinutes} min read</span>
            {post.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-border px-2 py-0.5 text-[11px] capitalize"
              >
                {tag}
              </span>
            ))}
          </div>

          {/* The page's single H1 — the article title. The body parser only
              emits H2/H3 precisely so a post cannot introduce a second one. */}
          <h1 className="mt-4 font-display text-[32px] font-semibold leading-[1.15] tracking-tight sm:text-[40px]">
            {post.title}
          </h1>
          <p className="mt-5 text-[16.5px] leading-relaxed text-muted-foreground">
            {post.excerpt}
          </p>
          <p className="mt-5 text-[13px] text-muted-foreground">
            By <span className="text-foreground">{post.authorName}</span>
          </p>
        </header>

        {post.coverImageUrl ? (
          <figure className="mt-10">
            {/* Plain <img> with reserved dimensions — see the note in
                `BlogContent`. `alt` falls back to the title rather than to an
                empty string: a decorative cover on an article is still worth
                describing. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={post.coverImageUrl}
              alt={post.coverImageAlt || post.title}
              width={1200}
              height={630}
              // The cover is the largest element above the fold, so it is the
              // LCP candidate: eager + high priority, unlike body images.
              loading="eager"
              fetchPriority="high"
              decoding="async"
              className="aspect-[1200/630] w-full rounded-2xl border border-border object-cover"
            />
          </figure>
        ) : null}

        <div className="mt-10 grid gap-12 lg:grid-cols-[minmax(0,72ch)_220px]">
          <div className="min-w-0">
            <BlogContent body={post.body} />

            <div className="mt-14 rounded-2xl border border-border bg-card p-7">
              <h2 className="font-display text-[18px] font-semibold tracking-tight">
                One record per client, in TraceTxn
              </h2>
              <p className="mt-2.5 max-w-[58ch] text-[14px] leading-relaxed text-muted-foreground">
                Orders, invoices, payments and the email you sent about them,
                on one timeline per client.{" "}
                <Link
                  href={CLIENT_MANAGEMENT_PATH}
                  className="font-medium text-primary hover:underline"
                >
                  See how client management works
                </Link>
                .
              </p>
            </div>
          </div>

          {toc.length > 2 ? (
            <nav
              aria-label="On this page"
              className="hidden self-start lg:sticky lg:top-24 lg:block"
            >
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                On this page
              </p>
              <ul className="mt-3 space-y-2 text-[13px]">
                {toc.map((h) => (
                  <li key={h.id} className={h.level === 3 ? "pl-3" : undefined}>
                    <a
                      href={`#${h.id}`}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      {h.text}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
        </div>

        {related.length ? (
          <section className="mt-16 border-t border-border pt-10">
            <h2 className="font-display text-[20px] font-semibold tracking-tight">
              Keep reading
            </h2>
            <ul className="mt-6 grid gap-6 sm:grid-cols-3">
              {related.map((r) => (
                <li key={r.slug}>
                  <Link href={blogPostPath(r.slug)} className="group block">
                    <p className="text-[15px] font-medium leading-snug text-foreground group-hover:text-primary">
                      {r.title}
                    </p>
                    <p className="mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-muted-foreground">
                      {r.excerpt}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <p className="mt-12 text-[13.5px]">
          <Link href={BLOG_INDEX_PATH} className="text-primary hover:underline">
            ← All articles
          </Link>
        </p>
      </article>
    </BlogShell>
  );
}
