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

const PAGE = landingPage("/agency-client-management");

export const metadata: Metadata = pageMetadata({
  title: PAGE.title,
  description: PAGE.description,
  path: PAGE.path,
});

/**
 * Spoke: audience intent.
 *
 * "Agency client management" is searched by someone with a specific,
 * different problem from a solo operator: several people touch the same
 * client, and the knowledge lives in whichever of them happens to be
 * available. So this page is about handover and continuity rather than about
 * features — the feature list belongs on the software page.
 */
export default function AgencyClientManagementPage() {
  return (
    <LandingShell
      path={PAGE.path}
      eyebrow="For agencies"
      h1="Client management for agencies, where more than one person needs the answer"
      lede="In an agency the client history is usually in someone's head, and that someone is on leave. TraceTxn keeps one record per client that any teammate can open — what was ordered, what was invoiced, what was paid, and what was said — so continuity does not depend on who is at their desk."
    >
      <Section title="The agency-specific problem">
        <p>
          A freelancer can hold a client relationship in memory. An agency
          cannot. The moment two people work the same account, the history has
          to live somewhere both of them can reach, or the agency pays for it
          twice: once when the answer is reconstructed, and again when the
          reconstruction is wrong.
        </p>
        <p>The failure modes are recognisable:</p>
        <Bullets
          items={[
            "A client references a decision from last quarter and nobody can find where it was agreed",
            "An account manager leaves and takes the context with them",
            "Two people email the same client about the same invoice",
            "Nobody is certain whether the last invoice was actually paid",
            "Onboarding a new hire onto an account takes a week of reading old threads",
          ]}
        />
      </Section>

      <Section title="What changes with one record per client" tint>
        <p>
          The unit of organisation stops being the project or the invoice and
          becomes the client. Everything the agency did for them accumulates in
          one place, in order.
        </p>
        <Bullets
          items={[
            "Anyone with access can open a client and read the relationship from the start",
            "Orders carry the line items that were agreed, so scope is evidenced rather than remembered",
            "Invoices and receipts stay attached to the order that produced them",
            "Payments reconcile against those orders through your own Stripe account",
            "Emails sent from TraceTxn are recorded on the client, so the thread is not one person's inbox",
            "Roles and permissions decide who can see and change what, with an audit trail behind it",
          ]}
        />
        <p>
          None of that requires the team to change how it works day to day. The
          record fills in as the work happens.
        </p>
      </Section>

      <Section title="Managing several clients at once">
        <p>
          Agencies rarely have a client problem; they have a{" "}
          <em>which client</em> problem. Client records are searchable and
          filterable, orders roll up per client, and the dashboard surfaces what
          is outstanding — so the question &ldquo;where does each account
          stand?&rdquo; has an answer that does not involve opening eight tabs.
        </p>
        <p>
          If you are still weighing up the category itself, start with{" "}
          <Link
            href={CLIENT_MANAGEMENT_PATH}
            className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
          >
            client management
          </Link>
          . If you are comparing tools, the{" "}
          <Link
            href="/client-management-software"
            className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
          >
            client management software
          </Link>{" "}
          page is more specific about scope.
        </p>
      </Section>

      <ClusterLinks exclude={PAGE.path} pages={SEO_LANDING_PAGES} />
    </LandingShell>
  );
}
