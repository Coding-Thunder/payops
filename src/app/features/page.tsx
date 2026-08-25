import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BrandCtaStrip } from "@/components/marketing/brand-cta-strip";
import { BrandFooter } from "@/components/marketing/brand-footer";
import { BrandNav } from "@/components/marketing/brand-nav";
import {
  BeforeAfter,
  ClientRecordPreview,
  ConnectedSections,
  ConsentCard,
  FilesCard,
  InvoicesPaymentsCard,
  NotesCard,
  SearchCard,
  TimelineCard,
} from "@/components/marketing/mocks/client-record";

import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Features",
  description: "Client records and timelines, orders, numbered invoices and receipts, Stripe payments, consent capture, and a tamper-evident audit trail.",
  path: "/features",
  socialTitle: "Everything on one client record \u2022 TraceTxn",
});

/* Each feature is one alternating row: copy on one side, a real product
 * shape on the other. Order + copy match the product, no roadmap chrome. */
interface Feature {
  n: string;
  eyebrow: string;
  title: string;
  body: string;
  sub?: string;
  Mock: React.ComponentType;
}

const FEATURES: Feature[] = [
  {
    n: "01",
    eyebrow: "Client records",
    title: "One record for every client.",
    body: "Every client gets their own profile. Their details, invoices, payments, consent, files, notes, and history all stay in one place — connected, not scattered.",
    Mock: ConnectedSections,
  },
  {
    n: "02",
    eyebrow: "Client timeline",
    title: "See the full history.",
    body: "A simple, dated list of what happened with a client — created, agreement added, invoice sent, payment received, scope updated, delivered. No reconstructing it from old email threads.",
    Mock: TimelineCard,
  },
  {
    n: "03",
    eyebrow: "Search",
    title: "Find any client in seconds.",
    body: "Search by name, email, phone, or invoice number. Open the result and the whole record is right there.",
    sub: "No folders to remember. No digging through old tools.",
    Mock: SearchCard,
  },
  {
    n: "04",
    eyebrow: "Consent",
    title: "Keep client consent on the record.",
    body: "When scope, price, or deliverables change, record what the client agreed to — kept on their record with the date and details.",
    Mock: ConsentCard,
  },
  {
    n: "05",
    eyebrow: "Invoices & payments",
    title: "See the money with the client history.",
    body: "Invoices and payments sit on the client's record, not off in a separate tool. See what was invoiced, what was paid, and when — for the right client.",
    Mock: InvoicesPaymentsCard,
  },
  {
    n: "06",
    eyebrow: "Files & documents",
    title: "Keep the important files with the client.",
    body: "Contracts, proposals, briefs, and deliverables attached to the client they belong to — easy to find later, without hunting through Drive.",
    Mock: FilesCard,
  },
  {
    n: "07",
    eyebrow: "Notes",
    title: "Keep the details you'll need later.",
    body: "Add quick notes to a client so the small things don't get lost in Slack, WhatsApp, email, or someone's memory.",
    Mock: NotesCard,
  },
];

/* Real capabilities that round out the product. No invented features. */
const SECONDARY: Array<{ label: string; body: string }> = [
  {
    label: "Team access",
    body: "Invite your team into the same workspace so everyone sees the same client history.",
  },
  {
    label: "Workspace roles",
    body: "Owner, admin, and staff roles so people get the access that fits them.",
  },
  {
    label: "Client tags",
    body: "Tag clients however you work — by retainer, project type, or status.",
  },
  {
    label: "Filters & views",
    body: "Filter your client list to find the group you need without scrolling.",
  },
  {
    label: "Activity history",
    body: "A running record of what changed on a client and when.",
  },
  {
    label: "Client contact info",
    body: "Name, email, and phone kept on the record and used across the workspace.",
  },
];

export default function FeaturesPage() {
  return (
    <div className="bg-background text-foreground">
      <BrandNav />

      {/* ─── Hero ────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b border-border">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
          style={{ background: "linear-gradient(180deg, #F8FAFC 0%, #FFFFFF 100%)" }}
        />
        <div className="mx-auto max-w-[1024px] px-6 pt-20 pb-10 text-center sm:px-10 sm:pt-24">
          <p className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-3 py-1 font-display text-[10.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ background: "var(--brand-emerald)" }}
            />
            Features
          </p>
          <h1 className="mx-auto mt-6 max-w-3xl font-display text-[clamp(2rem,5vw,3.6rem)] font-medium leading-[1.05] tracking-[-0.025em]">
            Everything about a client.{" "}
            <span className="font-semibold text-[color:var(--brand-emerald)]">
              In one place.
            </span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
            Keep invoices, payments, consent, files, notes, agreements, and
            client history connected to one searchable record.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg" className="gap-1.5">
              <Link href="/waitlist">
                Join the beta
                <ArrowRightIcon className="size-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="#how-it-works">See how it works</Link>
            </Button>
          </div>
        </div>

        {/* Product preview: a client record, not a payments dashboard. */}
        <div
          id="how-it-works"
          className="mx-auto max-w-[720px] scroll-mt-20 px-6 pb-16 sm:px-10"
        >
          <ClientRecordPreview />
        </div>
      </section>

      {/* ─── Features, alternating rows ─────────────────────────── */}
      <section className="mx-auto max-w-[1280px] px-6 py-20 lg:px-10">
        <div className="space-y-20 sm:space-y-24">
          {FEATURES.map((f, i) => (
            <FeatureRow key={f.n} feature={f} flipped={i % 2 === 1} />
          ))}
        </div>
      </section>

      {/* ─── Why it matters: without / with ─────────────────────── */}
      <section className="border-y border-border bg-white py-20">
        <div className="mx-auto max-w-[1080px] px-6 lg:px-10">
          <div className="text-center">
            <p className="font-display text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Why it matters
            </p>
            <h2 className="mx-auto mt-3 max-w-2xl font-display text-[clamp(1.6rem,3vw,2.2rem)] font-medium leading-[1.15] tracking-[-0.015em]">
              Stop searching six tools to remember one client.
            </h2>
            <p className="mx-auto mt-4 max-w-md text-[14px] leading-relaxed text-muted-foreground">
              Today, one client&apos;s history is spread across email, chat,
              Drive, and payment tools. TraceTxn keeps it in one place.
            </p>
          </div>
          <div className="mt-12">
            <BeforeAfter />
          </div>
        </div>
      </section>

      {/* ─── Everything else you need ───────────────────────────── */}
      <section className="mx-auto max-w-[1280px] px-6 py-20 lg:px-10">
        <div className="text-center">
          <p className="font-display text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            The rest of it
          </p>
          <h2 className="mt-3 font-display text-[clamp(1.6rem,3vw,2.2rem)] font-medium leading-[1.15] tracking-[-0.015em]">
            Everything else you need.
          </h2>
        </div>
        <div className="mt-12 grid grid-cols-1 gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {SECONDARY.map((s) => (
            <div
              key={s.label}
              className="border-l-2 pl-5"
              style={{ borderColor: "var(--brand-emerald)" }}
            >
              <div className="font-display text-[14px] font-semibold tracking-tight">
                {s.label}
              </div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                {s.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      <BrandCtaStrip />
      <BrandFooter />
    </div>
  );
}

/* ──────────────────────── Sub-components ───────────────────────────── */

function FeatureRow({ feature, flipped }: { feature: Feature; flipped: boolean }) {
  const { Mock } = feature;
  return (
    <div
      className={
        flipped
          ? "grid grid-cols-1 items-center gap-10 lg:grid-cols-[1fr_1.05fr] lg:gap-14"
          : "grid grid-cols-1 items-center gap-10 lg:grid-cols-[1.05fr_1fr] lg:gap-14"
      }
    >
      {/* Copy */}
      <div className={flipped ? "lg:order-2" : ""}>
        <p className="font-display text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          <span style={{ color: "var(--brand-emerald-strong)" }}>
            Feature {feature.n}
          </span>{" "}
          · {feature.eyebrow}
        </p>
        <h3 className="mt-3 font-display text-[clamp(1.5rem,3vw,2.1rem)] font-medium leading-[1.15] tracking-[-0.015em]">
          {feature.title}
        </h3>
        <p className="mt-4 max-w-md text-[14.5px] leading-relaxed text-muted-foreground">
          {feature.body}
        </p>
        {feature.sub ? (
          <p className="mt-3 max-w-md text-[13.5px] font-medium text-foreground/80">
            {feature.sub}
          </p>
        ) : null}
      </div>

      {/* Product shape */}
      <div className={flipped ? "lg:order-1" : ""}>
        <Mock />
      </div>
    </div>
  );
}
