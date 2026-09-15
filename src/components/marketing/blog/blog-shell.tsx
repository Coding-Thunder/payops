import Link from "next/link";

import { BrandCtaStrip } from "@/components/marketing/brand-cta-strip";
import { BrandFooter } from "@/components/marketing/brand-footer";
import { BrandNav } from "@/components/marketing/brand-nav";
import { absoluteUrl } from "@/lib/seo";

/**
 * Shared chrome for `/blog` and `/blog/[slug]`.
 *
 * Same reasoning as `LandingShell`: nav, spacing, breadcrumb and CTA are
 * decided once so the two blog routes cannot drift from each other or from
 * the rest of the marketing site. The visible breadcrumb and the
 * BreadcrumbList JSON-LD are built from the same array here, so the markup
 * can never claim a trail the page does not render.
 */

export interface Crumb {
  label: string;
  /**
   * The path this crumb points at.
   *
   * REQUIRED, including on the last crumb. It used to be optional "because the
   * last crumb is the current page", and the JSON-LD builder fell back to
   * `BLOG_INDEX_PATH` when it was missing — so on every article positions 2
   * and 3 carried the identical `/blog` URL. A BreadcrumbList whose last item
   * does not identify the page it is on describes the wrong hierarchy, and
   * Google reports a duplicate-URL breadcrumb. Making it required is what
   * stops that recurring: a new crumb cannot silently inherit the fallback.
   */
  href: string;
  /** Render as plain text rather than a link — the page you are already on. */
  current?: boolean;
}

function breadcrumbJsonLd(crumbs: Crumb[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    // Every item carries its OWN url. The last one is the current page, which
    // is what makes the trail self-identifying.
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.label,
      item: absoluteUrl(c.href),
    })),
  };
}

function Breadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="mx-auto max-w-[1024px] px-6 pt-8 sm:px-10"
    >
      <ol className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted-foreground">
        {crumbs.map((c, i) => (
          <li key={c.label} className="flex items-center gap-1.5">
            {i > 0 ? <span aria-hidden>/</span> : null}
            {/* The current page is named, not linked — a link to the page you
                are on is noise for a reader and a self-referential link for a
                crawler. The JSON-LD still carries its URL. */}
            {c.current ? (
              <span className="text-foreground" aria-current="page">
                {c.label}
              </span>
            ) : (
              <Link href={c.href} className="hover:text-foreground">
                {c.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

interface BlogShellProps {
  crumbs: Crumb[];
  children: React.ReactNode;
  /** Extra JSON-LD for the page (Article, Blog, …), emitted alongside the
   *  breadcrumb graph. */
  jsonLd?: object;
}

export function BlogShell({ crumbs, children, jsonLd }: BlogShellProps) {
  return (
    <div className="min-h-dvh bg-background">
      <BrandNav />
      <script
        type="application/ld+json"
        // Serialised from a locally-built object with no author-supplied
        // markup; `JSON.stringify` escapes the values, and the `<` guard
        // below closes the one hole that leaves (a literal `</script>` inside
        // a string ending the block early).
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(breadcrumbJsonLd(crumbs)).replace(/</g, "\\u003c"),
        }}
      />
      {jsonLd ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
          }}
        />
      ) : null}
      <Breadcrumb crumbs={crumbs} />
      <main>{children}</main>
      <BrandCtaStrip />
      <BrandFooter />
    </div>
  );
}
