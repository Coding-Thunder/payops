import Link from "next/link";

import { LogoLockup } from "@/components/brand/logo";

/**
 * Brand-v1 footer, calm, understated, no marketing fluff.
 *
 * Brand + tagline on the left, then four short link columns (Product /
 * Get started / Company / Legal). Hairline dividers, generous
 * whitespace. Single emerald dot on the system-status pill, the only
 * accent in the entire footer.
 *
 * Avoids the "11 columns of footer links" pattern most B2B SaaS sites
 * fall into. We keep it to the few links that matter.
 *
 * NOTE: /refunds is intentionally not linked here while TraceTxn is a
 * free private beta (see the Terms manual-review flags). Re-add it to
 * the Legal column if paid plans / paying customers exist.
 */
export function BrandFooter() {
  const year = new Date().getUTCFullYear();
  return (
    <footer className="border-t border-border bg-[color:var(--background)]">
      <div className="mx-auto max-w-[1280px] px-6 py-16 lg:px-10">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1.4fr_1fr_1fr_1fr_1fr]">
          <div className="max-w-sm">
            <LogoLockup size="md" />
            <p className="mt-4 text-[13px] leading-relaxed text-muted-foreground">
              One permanent, searchable record for every client. Built
              for agencies and freelancers.
            </p>
            <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-border bg-white px-3 py-1 text-[11px] text-muted-foreground">
              <span
                aria-hidden
                className="size-1.5 rounded-full"
                style={{ background: "var(--brand-emerald)" }}
              />
              <span className="font-mono uppercase tracking-[0.12em]">
                All systems operational
              </span>
            </div>
          </div>

          <FooterColumn
            title="Product"
            links={[
              { label: "Features", href: "/features" },
              { label: "Pricing", href: "/pricing" },
            ]}
          />
          <FooterColumn
            title="Get started"
            links={[
              { label: "Join the beta", href: "/waitlist" },
              { label: "Sign in", href: "/login" },
            ]}
          />
          <FooterColumn
            title="Company"
            links={[
              { label: "Security", href: "/security" },
              { label: "Contact", href: "/contact" },
            ]}
          />
          <FooterColumn
            title="Legal"
            links={[
              { label: "Terms", href: "/terms" },
              { label: "Privacy", href: "/privacy" },
              { label: "DPA", href: "/dpa" },
              { label: "Refunds", href: "/refunds" },
            ]}
          />
        </div>

        <div className="mt-14 flex flex-col gap-3 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground">
            © {year} TraceTxn · All rights reserved
          </p>
          <p className="text-[11px] text-muted-foreground">
            Built for agencies, freelancers, and studios that keep every
            client in one place.
          </p>
        </div>
      </div>
    </footer>
  );
}

interface FooterColumnProps {
  title: string;
  links: Array<{ label: string; href: string }>;
}

function FooterColumn({ title, links }: FooterColumnProps) {
  return (
    <div>
      <div className="font-display text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {title}
      </div>
      <ul className="mt-4 space-y-2.5">
        {links.map((l) => (
          <li key={l.label}>
            <Link
              href={l.href}
              className="text-[13px] text-foreground/85 transition-colors hover:text-foreground"
            >
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
