import Link from "next/link";

import { SiteWordmark } from "@/components/brand/site-wordmark";

/**
 * Site footer.
 *
 * Reuses the existing production routes (features / pricing / security /
 * legal / auth) so nothing 404s — it is the real site map, not a new one.
 *
 * Light, like the rest of the site. It used to be `bg-[#08090b]`, which was
 * correct only while the homepage was dark; on /pricing, /blog and the
 * client-management cluster it put a near-black slab under a white page.
 */

import { LINKEDIN_URL } from "@/components/marketing/seo/structured-data";

const COLUMNS: { title: string; links: { href: string; label: string }[] }[] = [
  {
    title: "Product",
    links: [
      { href: "/#demo", label: "How it works" },
      { href: "/#use-cases", label: "Use cases" },
      { href: "/features", label: "Features" },
      { href: "/pricing", label: "Pricing" },
    ],
  },
  {
    // The client-management cluster. The homepage must link to the pillar
    // (see the internal-linking requirement); putting the spokes here too
    // makes the cluster reachable from every page that renders this footer,
    // with each link carrying its own descriptive anchor rather than one
    // phrase repeated.
    title: "Client management",
    links: [
      { href: "/client-management", label: "Client management" },
      {
        href: "/client-management-software",
        label: "Client management software",
      },
      { href: "/agency-client-management", label: "For agencies" },
      {
        href: "/client-communication-management",
        label: "Client communication",
      },
      { href: "/client-record-management", label: "Client records" },
      { href: "/blog", label: "Blog" },
      { href: "/reviews", label: "Reviews" },
    ],
  },
  {
    title: "Company",
    links: [
      { href: "/security", label: "Security" },
      { href: "/contact", label: "Contact" },
      // Official company page. Same URL as Organization.sameAs in
      // `seo/structured-data`; kept in one place there.
      { href: LINKEDIN_URL, label: "LinkedIn" },
      // /signup redirects to /waitlist without an invite, so link the
      // destination directly rather than bouncing the visitor.
      { href: "/waitlist", label: "Join the beta" },
      { href: "/login", label: "Sign in" },
    ],
  },
  {
    title: "Legal",
    links: [
      { href: "/privacy", label: "Privacy" },
      { href: "/terms", label: "Terms" },
      { href: "/dpa", label: "DPA" },
      { href: "/refunds", label: "Refunds" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-[#E2E8F0] bg-white">
      <div className="mx-auto max-w-[1180px] px-6 py-16 lg:px-8">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <SiteWordmark textClassName="text-[#0A1128]" />
            <p className="mt-4 max-w-xs text-[13.5px] leading-relaxed text-[#4A5568]">
              One permanent, searchable record for every client. Built for
              agencies and freelancers who are done reconstructing what
              happened.
            </p>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.title}>
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#64748B]">
                {col.title}
              </div>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    {/* An absolute href is an external profile (LinkedIn today): render a
    plain anchor so the router does not prefetch it, and keep the
    referrer off. Generic so the next external link is handled too. */}
                    {l.href.startsWith("http") ? (
                      <a
                        href={l.href}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[13.5px] text-[#4A5568] transition-colors hover:text-[#0A1128]"
                      >
                        {l.label}
                      </a>
                    ) : (
                      <Link
                        href={l.href}
                        className="text-[13.5px] text-[#4A5568] transition-colors hover:text-[#0A1128]"
                      >
                        {l.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col items-start justify-between gap-3 border-t border-[#E9EFF6] pt-6 sm:flex-row sm:items-center">
          <p className="text-[12.5px] text-[#64748B]">
            © {new Date().getFullYear()} TraceTxn. All rights reserved.
          </p>
          {/* This used to read "All systems operational" next to a green dot,
              hardcoded — so it stayed green through an outage, which is worse
              than saying nothing. Replaced with a fact that needs no runtime
              check; real status belongs behind /api/health, not in a footer
              string. */}
          <p className="text-[12.5px] text-[#64748B]">
            Private beta · client management for service businesses
          </p>
        </div>
      </div>
    </footer>
  );
}
