import Link from "next/link";

import { LogoLockup } from "@/components/brand/logo";

/**
 * Brand-v1 footer — calm, operational, no marketing fluff.
 *
 * Three-column structure: brand + tagline on the left, two link
 * columns (Product / Resources) on the right. Hairline dividers,
 * generous whitespace. Single emerald dot on the system-status pill
 * — the only accent in the entire footer.
 *
 * Avoids the "11 columns of footer links" pattern most B2B SaaS sites
 * fall into. We're an ops tool, not a corporate portal.
 */
export function BrandFooter() {
  const year = new Date().getUTCFullYear();
  return (
    <footer className="border-t border-border bg-[color:var(--background)]">
      <div className="mx-auto max-w-[1280px] px-6 py-16 lg:px-10">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="max-w-sm">
            <LogoLockup size="md" />
            <p className="mt-4 text-[13px] leading-relaxed text-muted-foreground">
              The operating system for payment operations. Lifecycle
              visibility, hashed evidence, hosted consent — built so your
              team can resolve disputes faster.
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
              { label: "Evidence chain", href: "/#evidence" },
              { label: "Integrations", href: "/#integrations" },
            ]}
          />
          <FooterColumn
            title="Get started"
            links={[
              { label: "Open a workspace", href: "/signup" },
              { label: "Sign in", href: "/login" },
              { label: "Join waitlist", href: "/waitlist" },
            ]}
          />
          <FooterColumn
            title="Company"
            links={[
              { label: "Security", href: "/security" },
              { label: "Contact", href: "/contact" },
            ]}
          />
        </div>

        <div className="mt-14 flex flex-col gap-3 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground">
            © {year} TraceTxn · All rights reserved
          </p>
          <p className="text-[11px] text-muted-foreground">
            Built for retail, services, agencies, hospitality, and B2B
            commerce that takes money seriously.
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
