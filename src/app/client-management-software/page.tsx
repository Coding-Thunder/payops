import type { Metadata } from "next";
import Link from "next/link";

import {
  Bullets,
  ClusterLinks,
  LandingShell,
  Section,
} from "@/components/marketing/seo/landing-shell";
import {
  CLIENT_MANAGEMENT_PATH,
  SEO_LANDING_PAGES,
  landingPage,
  pageMetadata,
} from "@/lib/seo";

const PAGE = landingPage("/client-management-software");

export const metadata: Metadata = pageMetadata({
  title: PAGE.title,
  description: PAGE.description,
  path: PAGE.path,
});

/**
 * Spoke: commercial / evaluation intent.
 *
 * Someone searching "client management software" is shopping. They want to
 * know what the tool does, what it does not do, and whether it fits — so this
 * page is concrete about scope and unusually explicit about what TraceTxn is
 * NOT, because the fastest way to lose an evaluator's trust is to let them
 * discover a missing capability after signing up.
 */
export default function ClientManagementSoftwarePage() {
  return (
    <LandingShell
      path={PAGE.path}
      eyebrow="Client management software"
      h1="Client management software built around the client record"
      lede="Most tools in this category organise work, money or contacts. TraceTxn organises the relationship: one searchable record per client holding the orders, invoices, payments, files and email that belong to them — so the history is still there when you need it."
    >
      <Section title="What the software actually does">
        <p>
          TraceTxn is a workspace for your team. You add clients, raise orders
          against them, send those orders out as invoices, take payment, and
          keep the resulting paper trail attached to the client rather than
          scattered across tools.
        </p>
        <Bullets
          items={[
            "Client records — contact details, notes, tags, and a full change history",
            "Orders — line items priced from your own item catalogue, with per-order totals",
            "Documents — invoices and receipts generated from the order, re-openable at any time",
            "Payments — collected through your own Stripe account, reconciled to the order",
            "Files and links — attachments and external resources kept on the client",
            "Email — templated messages sent from the product, recorded against the client",
            "Timeline — a dated sequence of everything above, per client",
            "Team access — roles and permissions, with an audit trail of who did what",
          ]}
        />
      </Section>

      <Section title="What it is not" tint>
        <p>
          Worth saying plainly, so you can rule it out fast if it is the wrong
          shape for you:
        </p>
        <Bullets
          items={[
            "It is not a sales CRM. There is no lead pipeline, deal stage or forecast.",
            "It is not project management. There are no tasks, sprints or Gantt charts.",
            "It is not accounting software. It does not file your taxes or replace your ledger.",
            "It does not send marketing campaigns.",
          ]}
        />
        <p>
          If what you need is a pipeline, a task board or a general ledger,
          TraceTxn is the wrong tool and will feel thin. It earns its place
          when the painful question is &ldquo;what happened with this
          client?&rdquo; rather than &ldquo;what should I work on next?&rdquo;
        </p>
      </Section>

      <Section title="How it is priced and run">
        <p>
          TraceTxn is in private beta and free to use during it. Payments run
          through your own Stripe account, so money moves directly between you
          and your client — TraceTxn records the transaction, it does not sit
          in the middle of it. You can read the current terms on the{" "}
          <Link
            href="/pricing"
            className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
          >
            pricing page
          </Link>{" "}
          and how client data is protected on the{" "}
          <Link
            href="/security"
            className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
          >
            security page
          </Link>
          .
        </p>
        <p>
          For the broader idea behind the category, start at{" "}
          <Link
            href={CLIENT_MANAGEMENT_PATH}
            className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
          >
            client management
          </Link>
          .
        </p>
      </Section>

      <ClusterLinks exclude={PAGE.path} pages={SEO_LANDING_PAGES} />
    </LandingShell>
  );
}
