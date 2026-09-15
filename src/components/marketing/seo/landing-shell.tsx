import Link from "next/link";

import { BrandCtaStrip } from "@/components/marketing/brand-cta-strip";
import { BrandFooter } from "@/components/marketing/brand-footer";
import { BrandNav } from "@/components/marketing/brand-nav";
import {
  CLIENT_MANAGEMENT_PATH,
  SITE_NAME,
  absoluteUrl,
  landingPage,
  type SeoLandingPage,
} from "@/lib/seo";

/**
 * Shared shell for the client-management SEO cluster.
 *
 * Five routes, one layout. Each page supplies its own content — the whole
 * point of the cluster is that the pages are genuinely different — but none
 * of them should be re-deciding nav, spacing, breadcrumb markup or the CTA.
 * Keeping that here is also what stops the pages drifting apart visually from
 * `/features` and `/security`, which use the same BrandNav/BrandCtaStrip/
 * BrandFooter chrome.
 *
 * The BreadcrumbList JSON-LD is emitted here rather than per page for the
 * same reason: it is derived from the registry, so it cannot disagree with
 * the route it describes.
 */

interface LandingShellProps {
  /** Registry path; drives the breadcrumb and the canonical it must match. */
  path: string;
  /** Small uppercase label above the H1. */
  eyebrow: string;
  /** The page's single H1. */
  h1: React.ReactNode;
  /** The opening paragraph — the page's search-intent answer, in plain words. */
  lede: string;
  children: React.ReactNode;
}

/**
 * BreadcrumbList for a spoke: Home → Client management → this page. The
 * pillar itself is Home → Client management, two items, which is valid and
 * is what Google expects for a top-level hub.
 */
function breadcrumbJsonLd(page: SeoLandingPage) {
  const pillar = landingPage(CLIENT_MANAGEMENT_PATH);
  const isPillar = page.path === CLIENT_MANAGEMENT_PATH;

  const items = [
    { name: "Home", item: absoluteUrl("/") },
    { name: pillar.breadcrumb, item: absoluteUrl(pillar.path) },
    ...(isPillar
      ? []
      : [{ name: page.breadcrumb, item: absoluteUrl(page.path) }]),
  ];

  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((entry, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: entry.name,
      item: entry.item,
    })),
  };
}

/** Visible breadcrumb. Mirrors the JSON-LD so the markup is not a claim the
 *  page does not actually make to a human reader. */
function Breadcrumb({ page }: { page: SeoLandingPage }) {
  const pillar = landingPage(CLIENT_MANAGEMENT_PATH);
  const isPillar = page.path === CLIENT_MANAGEMENT_PATH;
  return (
    <nav
      aria-label="Breadcrumb"
      className="mx-auto max-w-[1024px] px-6 pt-8 sm:px-10"
    >
      <ol className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted-foreground">
        <li>
          <Link href="/" className="hover:text-foreground">
            Home
          </Link>
        </li>
        <li aria-hidden>/</li>
        <li>
          {isPillar ? (
            <span className="text-foreground">{pillar.breadcrumb}</span>
          ) : (
            <Link href={pillar.path} className="hover:text-foreground">
              {pillar.breadcrumb}
            </Link>
          )}
        </li>
        {!isPillar && (
          <>
            <li aria-hidden>/</li>
            <li className="text-foreground">{page.breadcrumb}</li>
          </>
        )}
      </ol>
    </nav>
  );
}

export function LandingShell({
  path,
  eyebrow,
  h1,
  lede,
  children,
}: LandingShellProps) {
  const page = landingPage(path);

  return (
    <div className="bg-background text-foreground">
      <script
        type="application/ld+json"
        // Server-rendered from a literal registry; no user input reaches this.
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(breadcrumbJsonLd(page)),
        }}
      />
      <BrandNav />
      <Breadcrumb page={page} />

      <section className="relative overflow-hidden border-b border-border">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{ background: "linear-gradient(180deg,#F8FAFC 0%,#FFFFFF 100%)" }}
        />
        <div className="mx-auto max-w-[1024px] px-6 pt-10 pb-14 sm:px-10">
          <p className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-3 py-1 font-display text-[10.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ background: "var(--brand-emerald)" }}
            />
            {eyebrow}
          </p>
          <h1 className="mt-6 max-w-3xl font-display text-[clamp(2rem,5vw,3.4rem)] font-medium leading-[1.06] tracking-[-0.025em]">
            {h1}
          </h1>
          <p className="mt-5 max-w-2xl text-[16px] leading-relaxed text-muted-foreground">
            {lede}
          </p>
        </div>
      </section>

      <main>{children}</main>

      <BrandCtaStrip />
      <BrandFooter />
    </div>
  );
}

/* ── Small content primitives, so pages read as content and not as markup ── */

export function Section({
  title,
  children,
  tint = false,
}: {
  title: string;
  children: React.ReactNode;
  tint?: boolean;
}) {
  return (
    <section
      className={
        tint
          ? "border-t border-border bg-white py-16"
          : "border-t border-border py-16"
      }
    >
      <div className="mx-auto max-w-[1024px] px-6 sm:px-10">
        <h2 className="font-display text-[clamp(1.5rem,3vw,2.1rem)] font-medium leading-[1.15] tracking-[-0.015em]">
          {title}
        </h2>
        <div className="mt-5 space-y-4 text-[15.5px] leading-relaxed text-muted-foreground">
          {children}
        </div>
      </div>
    </section>
  );
}

export function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="mt-4 space-y-2.5">
      {items.map((item) => (
        <li key={item} className="flex gap-2.5">
          <span
            aria-hidden
            className="mt-[0.55rem] size-1.5 shrink-0 rounded-full"
            style={{ background: "var(--brand-emerald)" }}
          />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The cluster's internal links, rendered from the registry.
 *
 * `exclude` drops the current page so no page links to itself, and the anchor
 * text is each page's own breadcrumb label rather than one repeated phrase —
 * varied, descriptive anchors, which is the point of linking at all.
 */
export function ClusterLinks({
  exclude,
  heading = "Keep reading",
  pages,
}: {
  exclude: string;
  heading?: string;
  pages: readonly SeoLandingPage[];
}) {
  const links = pages.filter((p) => p.path !== exclude);
  if (links.length === 0) return null;

  return (
    <section className="border-t border-border bg-white py-16">
      <div className="mx-auto max-w-[1024px] px-6 sm:px-10">
        <h2 className="font-display text-[clamp(1.4rem,2.6vw,1.9rem)] font-medium tracking-[-0.015em]">
          {heading}
        </h2>
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {links.map((p) => (
            <Link
              key={p.path}
              href={p.path}
              className="group rounded-xl border border-border bg-[color:var(--background)] p-5 transition-colors hover:border-foreground/25"
            >
              <p className="font-display text-[15px] font-medium text-foreground">
                {p.title}
              </p>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">
                {p.description}
              </p>
            </Link>
          ))}
        </div>
        <p className="mt-6 text-[13.5px] text-muted-foreground">
          Or see what {SITE_NAME} does in full on the{" "}
          <Link
            href="/features"
            className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
          >
            features page
          </Link>
          .
        </p>
      </div>
    </section>
  );
}
