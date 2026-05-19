import { env } from "@/lib/env";

/**
 * JSON-LD structured data for the marketing landing.
 *
 * Three top-level objects in a single @graph payload:
 *
 *  1. Organization — entity that publishes the page. Pinned with
 *     `@id` so the other entities can reference it.
 *  2. WebSite — the canonical site, with a SearchAction sitelinks
 *     box (helps Google render the search box in the SERP for
 *     branded queries).
 *  3. SoftwareApplication — the product itself. Pricing model is
 *     "QuotePending" (no fixed price; quote-based) and category is
 *     `BusinessApplication`. Google + Bing both ingest this for
 *     product knowledge panels.
 *
 * One <script> tag with a single graph is the recommended pattern —
 * cleaner than three separate script tags, indexed identically.
 */

interface StructuredDataProps {
  /** Optional override; defaults to the public APP_URL env. */
  baseUrl?: string;
  brand?: string;
  description?: string;
}

export function StructuredData({
  baseUrl,
  brand = env.public.NEXT_PUBLIC_APP_NAME,
  description = "PayOps is the payment operations platform for lifecycle visibility, hashed dispute evidence, and multi-gateway orchestration. Privately deployed on your own domain.",
}: StructuredDataProps) {
  const url = (baseUrl ?? env.public.NEXT_PUBLIC_APP_URL).replace(/\/$/, "");

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
        sameAs: [],
        contactPoint: [
          {
            "@type": "ContactPoint",
            email: "vinaymaheshwari35@gmail.com",
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
        email: "vinaymaheshwari35@gmail.com",
        worksFor: { "@id": `${url}/#organization` },
        knowsAbout: [
          "Payment Operations",
          "Chargeback Defense",
          "Multi-Gateway Orchestration",
          "Webhook Idempotency",
          "Audit-Grade Evidence Chain",
        ],
      },
      {
        "@type": "BreadcrumbList",
        "@id": `${url}/#breadcrumb`,
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: "PayOps",
            item: url,
          },
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
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${url}/#software`,
        name: `${brand} — Payment Operations Platform`,
        description,
        applicationCategory: "BusinessApplication",
        applicationSubCategory: "PaymentOperationsPlatform",
        operatingSystem: "Web, Cloud",
        url,
        screenshot: [
          `${url}/marketing/evidence-chain.webp`,
          `${url}/marketing/dashboard.webp`,
          `${url}/marketing/order-detail.webp`,
          `${url}/marketing/disputes-admin.webp`,
        ],
        featureList: [
          "Lifecycle visibility per order",
          "Hashed evidence chain — SHA-256 chained per-order",
          "Hosted customer consent + signature capture",
          "Multi-gateway orchestration (Stripe live; Razorpay, Authorize.net, Adyen, PayPal adapters)",
          "Idempotent webhook handling",
          "Append-only audit log",
          "Realtime SSE updates",
          "PDF + CSV dispute evidence export",
          "Privately deployed per merchant",
        ],
        offers: {
          "@type": "Offer",
          availability: "https://schema.org/InStock",
          priceCurrency: "USD",
          price: "0",
          priceSpecification: {
            "@type": "PriceSpecification",
            priceCurrency: "USD",
            description: "Quote-based pricing. Contact sales for a tailored proposal.",
          },
          url: `${url}/#quote`,
        },
        publisher: { "@id": `${url}/#organization` },
        creator: { "@id": `${url}/#organization` },
      },
      {
        "@type": "FAQPage",
        "@id": `${url}/#faq`,
        mainEntity: [
          {
            "@type": "Question",
            name: "Is PayOps a multi-tenant SaaS?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "No. PayOps is a privately-deployed SaaS — each customer gets their own instance provisioned on their own domain. No shared tenant, no public sign-up.",
            },
          },
          {
            "@type": "Question",
            name: "Which payment gateways does PayOps support?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "Stripe is fully live today (checkout, webhooks, disputes, refunds). Razorpay and Authorize.net adapters are scaffolded for activation on credentials. Adyen and PayPal are on the roadmap.",
            },
          },
          {
            "@type": "Question",
            name: "How does PayOps help with chargeback disputes?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "Every order persists a hashed, append-only evidence chain — payment intent, charge id, customer consent signature, email correspondence, IP/UA capture, gateway receipts. When a dispute fires, the order auto-flags, the chain freezes, and a one-click PDF export is ready to forward to the bank.",
            },
          },
          {
            "@type": "Question",
            name: "How is pricing structured?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "Quote-based. Each deployment is scoped to your stack, volume, and integration requirements at quotation. Send requirements to vinaymaheshwari35@gmail.com for a tailored proposal.",
            },
          },
          {
            "@type": "Question",
            name: "How long does deployment take?",
            acceptedAnswer: {
              "@type": "Answer",
              text: "After quotation acceptance, deployment is typically 1–2 weeks: branding, role matrix, gateway routing, and DNS provisioning. We respond to quotation requests within one business day.",
            },
          },
        ],
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
