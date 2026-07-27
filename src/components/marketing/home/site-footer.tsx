import Link from "next/link";

import { SiteWordmark } from "@/components/brand/site-wordmark";

/**
 * Dark footer for the redesigned marketing surface. Reuses the existing
 * production routes (features/pricing/security/legal/auth) so nothing
 * 404s — it's a re-skin of the site map, not a new one.
 */

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
    title: "Company",
    links: [
      { href: "/security", label: "Security" },
      { href: "/contact", label: "Contact" },
      { href: "/signup", label: "Join the beta" },
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
    <footer className="border-t border-white/8 bg-[#08090b]">
      <div className="mx-auto max-w-[1140px] px-6 py-16 lg:px-8">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <SiteWordmark />
            <p className="mt-4 max-w-xs text-[13.5px] leading-relaxed text-white/45">
              One permanent, searchable record for every client. Built for
              agencies and freelancers who are done reconstructing what
              happened.
            </p>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.title}>
              <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-white/35">
                {col.title}
              </div>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link
                      href={l.href}
                      className="text-[13.5px] text-white/55 transition-colors hover:text-white"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col items-start justify-between gap-3 border-t border-white/8 pt-6 sm:flex-row sm:items-center">
          <p className="text-[12.5px] text-white/35">
            © {new Date().getFullYear()} TraceTxn. All rights reserved.
          </p>
          <div className="flex items-center gap-2 text-[12.5px] text-white/40">
            <span className="size-1.5 rounded-full bg-emerald-400" />
            All systems operational
          </div>
        </div>
      </div>
    </footer>
  );
}
