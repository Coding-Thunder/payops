import type { Metadata } from "next";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  DatabaseIcon,
  FileCheckIcon,
  KeyRoundIcon,
  LockIcon,
  ShieldCheckIcon,
  UserCheckIcon,
} from "lucide-react";

import { BrandCtaStrip } from "@/components/marketing/brand-cta-strip";
import { BrandFooter } from "@/components/marketing/brand-footer";
import { BrandNav } from "@/components/marketing/brand-nav";

export const metadata: Metadata = {
  title: "Security, Operational trust",
  description:
    "How TraceTxn protects your tenant data: encrypted Stripe credentials, hashed evidence chain, tenant-isolated collections, webhook signing-secret verification, bot protection.",
  alternates: { canonical: "/security" },
};

/* ────────────────────────── Pillars ─────────────────────────────────
 * Reads as a shipped-state security posture, NOT a roadmap. Honest
 * about what we have + what we don't (no SOC certification today;
 * single-region; no third-party pentests yet). Operators reading a
 * security page can smell aspirational copy a mile off.
 * ────────────────────────────────────────────────────────────────── */

interface Pillar {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  points: string[];
}

const PILLARS: Pillar[] = [
  {
    icon: KeyRoundIcon,
    title: "Encrypted credentials",
    body: "Your Stripe secret key never sits in plaintext at rest. AES-256 envelope encryption with a per-deployment master key, TraceTxn operators can't read your Stripe key from the database, full stop.",
    points: [
      "Per-org `gateway_credentials` row, your key never mingles with another tenant's",
      "Webhook signing-secret captured at registration time + stored encrypted",
      "Decryption only at request scope, never logged",
      "Loss of the master key locks all encrypted rows, rotation is documented",
    ],
  },
  {
    icon: ShieldCheckIcon,
    title: "Hashed evidence chain",
    body: "Every state change on every order appends a SHA-256-linked event. The chain is append-only at the model layer, service-layer bugs can't silently rewrite history.",
    points: [
      "Each event hash includes the previous event's hash (Merkle-style)",
      "Update hooks throw on any `findOneAndUpdate` against evidence",
      "Chain verification surfaced in-product on every order detail",
      "Tamper-evident exports the cardholder's bank can re-verify",
    ],
  },
  {
    icon: DatabaseIcon,
    title: "Tenant isolation",
    body: "Every business-data row carries `orgId`. Lookup-by-id pins both `_id` AND `orgId` at the query layer, so a Tenant-A actor holding a guessed Tenant-B id gets a clean 404, not a real document.",
    points: [
      "11 collections hardened: orders, items, item-types, branding, etc.",
      "Child models (disputes, evidence, consent, drafts, outbox) all carry orgId",
      "Cross-tenant tests in CI prove id-guesses fail",
      "Per-tenant indexes on every business collection",
    ],
  },
  {
    icon: UserCheckIcon,
    title: "Auth + access control",
    body: "Firebase Auth for sign-in (Google + email/password), short-lived signed JWT cookie for the session. Every protected route runs through a proxy that verifies the JWT signature, role, and org membership before the handler sees the request.",
    points: [
      "Firebase ID-token → server-verified → minted JWT (jose, HS256, 12h)",
      "Strict same-site cookies, HttpOnly, Secure in prod",
      "RBAC: SUPER_ADMIN → ADMIN → STAFF, granted via the permission matrix",
      "Tenant-aware: every request resolves the actor's active org before the handler runs",
    ],
  },
  {
    icon: FileCheckIcon,
    title: "Webhook integrity",
    body: "Stripe webhooks are verified against your per-org signing secret BEFORE the handler runs. Replays + double-deliveries dedupe against a durable `processed_webhook_events` collection, not the order doc.",
    points: [
      "Per-org signing secret captured at Stripe connect, encrypted at rest",
      "Idempotent on three axes: event id, processed-marker, and status guard",
      "Concurrent webhook + reconcile races collapse at the unique index",
      "Webhook health check + repair surfaced in the admin Gateways page",
    ],
  },
  {
    icon: LockIcon,
    title: "Bot protection + abuse defense",
    body: "Cloudflare Turnstile gates every public form (login, signup, quotation, contact). Rate-limits at the request layer protect the auth + payment-exchange endpoints from credential-stuffing.",
    points: [
      "Turnstile-required on login + signup + waitlist forms",
      "Per-route rate limits with IP-derived keys",
      "Session-cookie hash mixed into rate-limit keys for finer-grained control",
      "CSP locked down to `self` + explicitly whitelisted third parties",
    ],
  },
];

/* Honesty section, what we DON'T have. Saying it out loud is the
 * single highest-signal trust move on a startup security page. */
const HONEST: Array<{ label: string; body: string }> = [
  {
    label: "Not SOC 2 certified yet",
    body: "We're early. We don't have a SOC 2 Type II report, and we won't claim we do. Compliance pursuit starts when we have the customer volume to justify the audit cost.",
  },
  {
    label: "Single-region deployment",
    body: "Today we run in one DigitalOcean region with daily Mongo Atlas snapshots. Multi-region failover is on the roadmap when paying tenant density crosses the threshold that justifies the operational overhead.",
  },
  {
    label: "No third-party pentest yet",
    body: "We've done internal threat modelling + code review. A formal third-party penetration test is scheduled before we open the Scale tier to enterprise customers.",
  },
  {
    label: "PCI scope: we never touch card data",
    body: "TraceTxn is BYOS-Stripe, Stripe takes the card data, not us. We never see, store, or process card numbers. PCI scope sits with Stripe and your business directly, not TraceTxn.",
  },
];

export default function SecurityPage() {
  return (
    <div className="bg-background text-foreground">
      <BrandNav />

      {/* ─── Hero ────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b border-border bg-[color:var(--background)]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{
            background:
              "linear-gradient(180deg, #F8FAFC 0%, #FFFFFF 100%)",
          }}
        />
        <div className="mx-auto max-w-[1024px] px-6 pt-20 pb-12 text-center sm:px-10 sm:pt-24">
          <p className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-3 py-1 font-display text-[10.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ background: "var(--brand-emerald)" }}
            />
            Security
          </p>
          <h1 className="mx-auto mt-6 max-w-3xl font-display text-[clamp(2rem,5vw,3.6rem)] font-medium leading-[1.05] tracking-[-0.025em]">
            Built for{" "}
            <span className="font-semibold text-[color:var(--brand-emerald)]">
              operational trust.
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
            What we protect, how we protect it, and, honestly, what we
            don&apos;t have yet. Updated as the posture evolves.
          </p>
        </div>
      </section>

      {/* ─── Six pillars grid ───────────────────────────────────── */}
      <section className="mx-auto max-w-[1280px] px-6 py-16 lg:px-10">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {PILLARS.map((p) => (
            <PillarCard key={p.title} pillar={p} />
          ))}
        </div>
      </section>

      {/* ─── Honesty section ────────────────────────────────────── */}
      <section className="border-t border-border bg-white py-20">
        <div className="mx-auto max-w-[1024px] px-6 lg:px-10">
          <div className="text-center">
            <p className="font-display text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              What we don&apos;t have yet
            </p>
            <h2 className="mt-3 font-display text-[clamp(1.6rem,3vw,2.2rem)] font-medium leading-[1.15] tracking-[-0.015em]">
              Honest about the gaps.
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-[13.5px] leading-relaxed text-muted-foreground">
              Most startup security pages claim certifications they don&apos;t
              have. We&apos;d rather just tell you.
            </p>
          </div>

          <ul className="mt-12 space-y-4">
            {HONEST.map((item) => (
              <li
                key={item.label}
                className="flex items-start gap-4 rounded-xl border border-border bg-[color:var(--background)] p-5"
              >
                <CircleAlertIcon
                  className="mt-0.5 size-4 shrink-0 text-amber-600"
                  aria-hidden
                />
                <div>
                  <div className="font-display text-[14px] font-semibold tracking-tight">
                    {item.label}
                  </div>
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">
                    {item.body}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ─── Responsible disclosure ─────────────────────────────── */}
      <section className="border-t border-border bg-[color:var(--background)] py-20">
        <div className="mx-auto max-w-[1024px] px-6 lg:px-10">
          <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[1.4fr_1fr]">
            <div>
              <p className="font-display text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Responsible disclosure
              </p>
              <h2 className="mt-3 font-display text-[clamp(1.6rem,3vw,2.2rem)] font-medium leading-[1.15] tracking-[-0.015em]">
                Found something? Tell us first.
              </h2>
              <p className="mt-4 text-[14px] leading-relaxed text-muted-foreground">
                If you believe you&apos;ve found a security vulnerability in
                TraceTxn, please email us before disclosing publicly. We
                acknowledge within 48 hours and ship the fix as soon as
                it&apos;s validated. We don&apos;t run a paid bug-bounty yet -
                public hall-of-fame credit is the recognition path today.
              </p>
              <ul className="mt-6 space-y-2 text-[13.5px]">
                {[
                  "Acknowledgement within 48h",
                  "No legal action against good-faith research",
                  "Coordinated public disclosure once the fix ships",
                ].map((line) => (
                  <li key={line} className="flex items-start gap-2">
                    <CheckCircle2Icon
                      className="mt-[3px] size-3.5 shrink-0"
                      style={{ color: "var(--brand-emerald)" }}
                    />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>

            <a
              href="mailto:security@tracetxn.com"
              className="group block overflow-hidden rounded-2xl p-7 text-white transition-transform hover:-translate-y-0.5"
              style={{ background: "var(--ink-navy)" }}
            >
              <div
                className="font-display text-[10.5px] font-semibold uppercase tracking-[0.16em]"
                style={{ color: "var(--brand-emerald)" }}
              >
                Email security
              </div>
              <div className="mt-3 font-display text-[22px] font-medium tracking-tight">
                security@tracetxn.com
              </div>
              <p className="mt-3 text-[12.5px] text-white/72">
                PGP key on request. Include reproduction steps, affected
                endpoint, and your preferred name for disclosure credit.
              </p>
              <div className="mt-5 inline-flex items-center gap-1.5 text-[12px] text-white/85 transition-colors group-hover:text-white">
                Open mail client →
              </div>
            </a>
          </div>
        </div>
      </section>

      <BrandCtaStrip />
      <BrandFooter />
    </div>
  );
}

function PillarCard({ pillar }: { pillar: Pillar }) {
  const Icon = pillar.icon;
  return (
    <div className="rounded-2xl border border-border bg-white p-6">
      <span
        className="inline-flex size-10 items-center justify-center rounded-lg"
        style={{
          background:
            "color-mix(in oklch, var(--brand-emerald) 12%, white)",
          color: "var(--brand-emerald-strong)",
        }}
      >
        <Icon className="size-5" />
      </span>
      <h3 className="mt-4 font-display text-[16px] font-semibold tracking-tight">
        {pillar.title}
      </h3>
      <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
        {pillar.body}
      </p>
      <ul className="mt-4 space-y-1.5 text-[12.5px]">
        {pillar.points.map((p) => (
          <li key={p} className="flex items-start gap-2">
            <CheckCircle2Icon
              className="mt-[3px] size-3 shrink-0"
              style={{ color: "var(--brand-emerald)" }}
            />
            <span className="text-foreground/85">{p}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
