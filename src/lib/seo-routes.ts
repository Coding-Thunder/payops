/**
 * Public SEO route registry — deliberately dependency-free.
 *
 * Split out of `@/lib/seo` because `src/proxy.ts` needs these paths to mark
 * them public, and the proxy runs on every request: importing `@/lib/seo`
 * there would drag `@/lib/env` and its zod parse into the edge path. This
 * module imports nothing, so both the proxy and the SEO helpers can share one
 * definition instead of keeping two lists in step by hand.
 *
 * That mattering is not hypothetical: the first version of these pages 307'd
 * to /login because the proxy gates any route it does not recognise, which
 * made five brand-new landing pages uncrawlable.
 */

/*
 * Client-management SEO cluster.
 *
 * One registry, because five things have to agree and used to be edited
 * separately: the route's own metadata, the sitemap, the internal links that
 * make the cluster a cluster, the BreadcrumbList JSON-LD, and the tests that
 * hold all of it still. Adding a page here is what publishes it — the sitemap
 * derives from this array, so a new entry cannot be forgotten in `sitemap.ts`.
 *
 * `/client-management` is the pillar. The other four are its spokes and each
 * links back to it; the pillar links out to all four. That shape is the whole
 * point of the cluster, so it is expressed in data rather than in prose that
 * can drift.
 *
 * Claim discipline applies here as much as anywhere: every capability named
 * in these descriptions is reachable in the product today. Notably ABSENT is
 * "approvals" — there is no approvals model, service, route or UI, and
 * `seo-claims.test.ts` guards that. See NOT_CLAIMED at the end of this file.
 * ══════════════════════════════════════════════════════════════════════ */

export interface SeoLandingPage {
  /** Route path, lowercase, hyphenated, no trailing slash. Permanent. */
  path: string;
  /** Document title, WITHOUT the site-name suffix. */
  title: string;
  description: string;
  /** Short label used in BreadcrumbList and in internal link text. */
  breadcrumb: string;
  /** Sitemap priority. The pillar outranks its spokes. */
  priority: number;
}

/** The pillar every spoke links back to. */
export const CLIENT_MANAGEMENT_PATH = "/client-management";

export const SEO_LANDING_PAGES: readonly SeoLandingPage[] = [
  {
    path: CLIENT_MANAGEMENT_PATH,
    title: "Client Management",
    description:
      "What client management means for an agency or service business, how it differs from a CRM, and how to keep every client's orders, invoices, payments and email in one record.",
    breadcrumb: "Client management",
    priority: 0.9,
  },
  {
    path: "/client-management-software",
    title: "Client Management Software",
    description:
      "Client management software that keeps the whole relationship in one place: a searchable record per client with orders, invoices and receipts, payments, files, and every email you have sent them.",
    breadcrumb: "Client management software",
    priority: 0.9,
  },
  {
    path: "/agency-client-management",
    title: "Agency Client Management",
    description:
      "Client management software for agencies: one record per client that survives staff changes, so anyone on the team can answer what was agreed, what was invoiced, and what was paid.",
    breadcrumb: "Agency client management",
    priority: 0.9,
  },
  {
    path: "/client-communication-management",
    title: "Client Communication Management",
    description:
      "Manage client communication without losing the thread. TraceTxn keeps every email you send a client, with the order and invoice it relates to, on that client's permanent timeline.",
    breadcrumb: "Client communication",
    priority: 0.8,
  },
  {
    path: "/client-record-management",
    title: "Client Record Management",
    description:
      "Client records management that keeps client information and history in one place: contact details, orders, documents, files, payments and a dated timeline of everything that happened.",
    breadcrumb: "Client records",
    priority: 0.8,
  },
] as const;

/** The four spokes, in the order the pillar should link to them. */
export const CLIENT_MANAGEMENT_SPOKES: readonly SeoLandingPage[] =
  SEO_LANDING_PAGES.filter((p) => p.path !== CLIENT_MANAGEMENT_PATH);

/** Look one up by path. Throws rather than returning undefined: a page that
 *  asks for metadata it has no registry entry for is a wiring bug. */
export function landingPage(path: string): SeoLandingPage {
  const found = SEO_LANDING_PAGES.find((p) => p.path === path);
  if (!found) throw new Error(`No SEO landing page registered for ${path}`);
  return found;
}


/** Just the paths, for the proxy's public allow-list. */
export const SEO_LANDING_PATHS: readonly string[] = SEO_LANDING_PAGES.map(
  (p) => p.path,
);
