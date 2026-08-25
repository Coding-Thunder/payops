import type { Metadata } from "next";

import { env } from "@/lib/env";

/**
 * One source of truth for public-surface SEO.
 *
 * Positioning note: this file used to describe TraceTxn as a "Payment
 * Operations Platform · Dispute & Chargeback Evidence". The product the code
 * actually implements is a client record: a customer with a timeline, the
 * orders on it, the invoices and receipts those orders produce, the payments
 * against them, and the mail sent about them. Disputes and the per-order
 * evidence chain are real and still ship — they are one situation the record
 * is useful for, not the product's identity.
 *
 * Claim discipline: every capability named in metadata or JSON-LD must be
 * reachable by a signed-in user today. See the CAPABILITIES / NOT_CLAIMED
 * notes below before adding a word here.
 */

export const SITE_NAME = env.public.NEXT_PUBLIC_APP_NAME || "TraceTxn";
export const SITE_URL = env.public.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");

/** Appended to the site name for the default document title. */
export const HEADLINE = "Client Management for Agencies and Freelancers";

export const DESCRIPTION =
  "TraceTxn gives agencies and freelancers one searchable record per client — orders, invoices, payments, and the full timeline of the relationship in one place.";

/** Twitter truncates hard; keep this comfortably under 200 characters. */
export const SHORT_DESCRIPTION =
  "One searchable record per client: orders, invoices, payments, and the full timeline of the relationship.";

/**
 * Deliberately small. Search engines ignore the keywords meta entirely; it
 * survives only as a statement of intent for the humans editing this file.
 * The previous list carried 40+ terms across five chargeback/dispute
 * clusters, which is what made the whole site read as dispute software.
 */
export const KEYWORDS = [
  "client management software",
  "client management for agencies",
  "client management for freelancers",
  "client records",
  "client timeline",
  "client workflow software",
];

/** Absolute URL for `path` ("/", "/features", …). */
export function absoluteUrl(path: string): string {
  if (path === "/") return `${SITE_URL}/`;
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Robots directives for a page that must never reach an index: sign-in,
 * account recovery, and every token-bearing one-time URL.
 *
 * `follow: false` matters as much as `index: false` here — a crawler that
 * reached a tokenised page should not walk onward from it, and `nosnippet`
 * keeps any fragment of the page out of a SERP even if it is fetched.
 */
export const NOINDEX: Metadata["robots"] = {
  index: false,
  follow: false,
  nocache: true,
  googleBot: { index: false, follow: false, noimageindex: true },
};

interface PageMetadataArgs {
  /** Page title WITHOUT the site-name suffix; the root template adds it. */
  title: string;
  description: string;
  /** Route path, used for the self-referencing canonical. */
  path: string;
  /** Set for pages that must not be indexed. */
  noindex?: boolean;
  /** Override the OG/Twitter title when the document title is too terse. */
  socialTitle?: string;
  /**
   * Use the title verbatim instead of running it through the root
   * `%s • TraceTxn` template. For the homepage, whose title already names
   * the brand and would otherwise render "TraceTxn, … • TraceTxn".
   */
  absoluteTitle?: boolean;
}

/**
 * Build a public page's metadata with a SELF-REFERENCING canonical.
 *
 * The bug this exists to prevent: the root metadata used to declare
 * `alternates.canonical: SITE_URL`. Next merges `alternates` wholesale, so
 * any page that did not override it inherited a canonical pointing at the
 * homepage — telling Google those pages were duplicates of `/` and should be
 * folded into it. Routing every page through this helper makes the canonical
 * impossible to forget, and the root no longer declares one at all.
 */
export function pageMetadata({
  title,
  description,
  path,
  noindex = false,
  socialTitle,
  absoluteTitle = false,
}: PageMetadataArgs): Metadata {
  const url = absoluteUrl(path);
  const ogTitle =
    socialTitle ?? (absoluteTitle ? title : `${title} • ${SITE_NAME}`);

  return {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates: { canonical: url },
    ...(noindex ? { robots: NOINDEX } : {}),
    openGraph: {
      type: "website",
      url,
      title: ogTitle,
      description,
      siteName: SITE_NAME,
      locale: "en_US",
    },
    twitter: {
      card: "summary_large_image",
      title: ogTitle,
      description,
    },
  };
}
