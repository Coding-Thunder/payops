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
  CLIENT_MANAGEMENT_SPOKES,
  landingPage,
  pageMetadata,
} from "@/lib/seo";

const PAGE = landingPage(CLIENT_MANAGEMENT_PATH);

export const metadata: Metadata = pageMetadata({
  title: PAGE.title,
  description: PAGE.description,
  path: PAGE.path,
});

/**
 * Pillar page for the client-management cluster.
 *
 * Search intent here is definitional and comparative — someone typing "client
 * management" or "client management system" mostly wants to know what the
 * category is and how it differs from the CRM they already rejected. So this
 * page answers that first and sells second, and hands the commercial intent
 * onward to the spokes.
 *
 * Every capability named below exists in the product today: customers,
 * orders, documents (invoices and receipts), payments, client files and
 * links, email with templates and an outbox, consent records, and the audit
 * log behind the timeline. "Approvals" is deliberately absent — there is no
 * approvals model or UI, and `seo-claims.test.ts` treats claiming one as a
 * regression.
 */
export default function ClientManagementPage() {
  return (
    <LandingShell
      path={PAGE.path}
      eyebrow="Client management"
      h1="Client management, kept in one permanent record"
      lede="Client management is the practice of keeping everything about a client relationship — who they are, what they asked for, what you sent, what they paid, and what was said — in one place you can still search a year later. TraceTxn is built to be that place for agencies and service businesses."
    >
      <Section title="What client management actually means">
        <p>
          Most teams already do client management. They just do it across eight
          tools. The brief is in email, the quote is in a spreadsheet, the
          invoice is in accounting software, the payment is in Stripe, the
          files are in a shared drive, and the reasoning behind a decision is
          in somebody&apos;s memory.
        </p>
        <p>
          That works until someone asks a question about six months ago.
          Client management, done properly, means one record per client that
          holds the whole relationship in order, so answering that question is
          a search rather than an excavation.
        </p>
        <p>A complete client record answers four questions without guesswork:</p>
        <Bullets
          items={[
            "Who is this client, and who at our end has dealt with them?",
            "What did we agree to do, and what did we actually deliver?",
            "What did we invoice, what did they pay, and what is outstanding?",
            "What was said, when, and by whom?",
          ]}
        />
      </Section>

      <Section title="Client management vs a CRM" tint>
        <p>
          A CRM is built for the period <em>before</em> someone becomes a
          client. Its shape is a pipeline: leads, stages, forecasts, close
          dates. That is genuinely useful if your problem is winning work.
        </p>
        <p>
          Client management is the period <em>after</em>. The deal is won; what
          matters now is delivery, money and history. A pipeline has nowhere
          natural to keep the invoice you sent in March, the file the client
          approved, or the email thread where the scope changed — so those
          scatter, and the CRM slowly becomes a contact list nobody trusts.
        </p>
        <p>
          The same gap opens with the other two tools teams reach for. Project
          management software knows the task but not the money. Accounting
          software knows the money but not the conversation. Neither keeps the
          relationship, which is the thing you actually need when a client
          resurfaces.
        </p>
      </Section>

      <Section title="How TraceTxn does it">
        <p>
          Every client gets one record. Opening it shows the relationship in
          date order rather than as a set of tabs you have to reconcile
          yourself.
        </p>
        <Bullets
          items={[
            "Client details, with the team member who created the record and every change since",
            "Orders, with the line items, item types and totals that were agreed",
            "Invoices and receipts generated from those orders, as documents you can re-open",
            "Payments taken through your own Stripe account, matched to the order they settle",
            "Files and links attached to the client, with a note on why each one matters",
            "Every email sent from TraceTxn to that client, and what it was about",
            "A dated timeline that stitches all of the above into one sequence",
          ]}
        />
        <p>
          Because the record is one object rather than a join across tools, the
          history survives the things that usually destroy it: someone leaving,
          an inbox being archived, or a tool being swapped out.
        </p>
      </Section>

      <Section title="Where to go next" tint>
        <p>
          This page is the overview. The pages below go deeper into the
          specific job you are trying to do — evaluating{" "}
          <Link
            href="/client-management-software"
            className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
          >
            client management software
          </Link>
          , running{" "}
          <Link
            href="/agency-client-management"
            className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
          >
            client management for agencies
          </Link>
          , getting a grip on{" "}
          <Link
            href="/client-communication-management"
            className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
          >
            client communication management
          </Link>
          , or organising{" "}
          <Link
            href="/client-record-management"
            className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
          >
            client records management
          </Link>
          .
        </p>
      </Section>

      <ClusterLinks exclude={PAGE.path} pages={CLIENT_MANAGEMENT_SPOKES} />
    </LandingShell>
  );
}
