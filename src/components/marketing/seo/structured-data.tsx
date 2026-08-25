import { SCHEMA_FAQS } from "@/components/marketing/home/faq-content";
import { DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/seo";

/**
 * JSON-LD structured data for the marketing landing.
 *
 * Emits one `@graph` with four entities:
 *
 *  1. Organization — the publisher, pinned with `@id` so the others reference
 *     it rather than repeating themselves.
 *  2. Person — the founder, referenced by the Organization.
 *  3. WebSite — the canonical site.
 *  4. SoftwareApplication — the product.
 *  5. FAQPage — mirrored from the FAQ the page actually renders.
 *
 * WHAT CHANGED AND WHY
 *
 * This graph used to declare the product as
 * `"TraceTxn, Payment Operations Platform"` with
 * `applicationSubCategory: "PaymentOperationsPlatform"`, a founder who
 * `knowsAbout` "Chargeback Defense", and a hand-written FAQ whose entries did
 * not match the page. Structured data is the single strongest machine-readable
 * statement of what a product IS, so that graph — not the visible copy, which
 * had already moved on — was what kept classifying TraceTxn as dispute
 * software.
 *
 * Three things were REMOVED rather than reworded, because each was incorrect
 * rather than merely off-message:
 *
 *  - `offers` declared `price: "0"` with `availability: "InStock"` while also
 *    describing quote-based pricing. Those contradict each other, and neither
 *    matches reality: the product is a closed private beta with no purchasable
 *    plan (/pricing renders no tier table). Emitting a zero-price Offer for
 *    something you cannot buy is a misrepresentation, so the product carries
 *    no pricing claim at all until plans exist.
 *
 *  - `screenshot` pointed at four files under /public/marketing. Those images
 *    still show the pre-rename "PayOps · OPS CONSOLE" chrome and a car-rental
 *    demo vertical. Feeding a crawler screenshots of a differently-branded
 *    product is worse than feeding it none.
 *
 *  - `BreadcrumbList` contained exactly one item pointing at the site root. A
 *    single-item breadcrumb describes no trail and is rejected as invalid;
 *    it will return when there are real nested pages to describe.
 *
 * CLAIM DISCIPLINE: `featureList` names only capability reachable by a
 * signed-in user today. Client files and links were withheld while they were
 * backend-only; they now render as Files and Links tabs on
 * /app/customers/[id] and are listed. Approvals still do not exist as a
 * feature — "Approve" is only a configurable workflow-transition label
 * (workflow.model.ts) — and are still not claimed. See faq-content.ts for the
 * same rule applied to the FAQ.
 */

interface StructuredDataProps {
  /** Optional override; defaults to the public APP_URL env. */
  baseUrl?: string;
  brand?: string;
  description?: string;
}

export function StructuredData({
  baseUrl,
  brand = SITE_NAME,
  description = DESCRIPTION,
}: StructuredDataProps) {
  const url = (baseUrl ?? SITE_URL).replace(/\/$/, "");

  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${url}/#organization`,
        name: brand,
        url,
        logo: {
          "@type": "ImageObject",
          url: `${url}/icon.svg`,
          width: 64,
          height: 64,
        },
        description,
        foundingDate: "2025",
        founder: { "@id": `${url}/#founder` },
        contactPoint: [
          {
            "@type": "ContactPoint",
            email: "hello@tracetxn.com",
            contactType: "sales",
            areaServed: "Worldwide",
            availableLanguage: ["en"],
          },
        ],
      },
      {
        "@type": "Person",
        "@id": `${url}/#founder`,
        name: "Vinay Maheshwari",
        jobTitle: "Founder · Principal Engineer",
        email: "hello@tracetxn.com",
        worksFor: { "@id": `${url}/#organization` },
        // Was: Payment Operations, Chargeback Defense, Multi-Gateway
        // Orchestration, Webhook Idempotency, Audit-Grade Evidence Chain.
        knowsAbout: [
          "Client Management",
          "Service Business Operations",
          "Invoicing and Payments",
        ],
      },
      {
        "@type": "WebSite",
        "@id": `${url}/#website`,
        url,
        name: brand,
        description,
        publisher: { "@id": `${url}/#organization` },
        inLanguage: "en-US",
        // No SearchAction: the sitelinks search box requires a real,
        // crawlable site-search endpoint, and there isn't one. The previous
        // docstring claimed this was emitted; it never was.
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${url}/#software`,
        name: brand,
        description,
        applicationCategory: "BusinessApplication",
        applicationSubCategory: "Client Management",
        operatingSystem: "Web",
        url,
        // Every line below maps to a route a signed-in user can open.
        featureList: [
          // /app/customers, /app/customers/[id]
          "One searchable record per client",
          // ClientTimeline on /app/customers/[id]
          "Client timeline of every order, invoice, payment and email",
          // /app/orders, /app/orders/create, /app/admin/workflow
          "Orders with a configurable status workflow",
          // document.model.ts — INVOICE and RECEIPT, numbered per workspace
          "Numbered invoices and receipts",
          // Stripe is the live gateway; the others are scaffolded adapters
          // and are deliberately not named here.
          "Card payments through Stripe with hosted checkout",
          // /consent/[token], payment-consent.model.ts
          "Hosted customer consent capture",
          // FilesPanel on /app/customers/[id] -> /api/files, stored in GridFS
          "Contracts and files attached to the client and their timeline",
          // LinksPanel on /app/customers/[id] -> /api/links
          "Shared links kept on the client record",
          // /app/orders/[id]/email, /app/admin/email-templates
          "Templated client email, recorded against the client",
          // audit-log.model.ts, /app/admin/audit
          "Tamper-evident audit trail",
          // organization + org-member models, permissions.ts
          "Shared team workspaces with role-based access",
          // The supporting use case, stated as one capability among many
          // rather than as the product's identity.
          "Per-order evidence chain, for when a payment is disputed",
        ],
        publisher: { "@id": `${url}/#organization` },
        creator: { "@id": `${url}/#organization` },
      },
      {
        "@type": "FAQPage",
        "@id": `${url}/#faq`,
        // Mirrors the rendered FAQ. Google requires the answer text to be
        // visible on the page, so this is derived from the same array the
        // component maps over — minus the entries withheld for making claims
        // the app cannot yet honour.
        mainEntity: SCHEMA_FAQS.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      },
    ],
  };

  return (
    <script
      type="application/ld+json"
      // The schema graph is server-rendered as a string; no runtime
      // mutation. dangerouslySetInnerHTML is the standard way to ship
      // JSON-LD with Next.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(graph) }}
    />
  );
}
