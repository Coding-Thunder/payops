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

const PAGE = landingPage("/client-record-management");

export const metadata: Metadata = pageMetadata({
  title: PAGE.title,
  description: PAGE.description,
  path: PAGE.path,
});

/**
 * Spoke: records / information-management intent.
 *
 * This search is closer to "how do I organise this" than "what should I buy",
 * so the page is structured as a method — what belongs in a client record and
 * how to keep it complete — with the product as the way to do it rather than
 * the subject of every paragraph.
 */
export default function ClientRecordManagementPage() {
  return (
    <LandingShell
      path={PAGE.path}
      eyebrow="Client records"
      h1="Client records management, so the history is complete by default"
      lede="A client record is only useful if it is complete, and it is only complete if keeping it complete takes no effort. TraceTxn builds the record as a side effect of the work: raising an order, sending an invoice and taking a payment all write to the same client history."
    >
      <Section title="What belongs in a client record">
        <p>
          Client information management goes wrong when the record is a contact
          card with notes bolted on. A record worth keeping holds the
          relationship, not just the identity.
        </p>
        <Bullets
          items={[
            "Identity — who the client is, how to reach them, and which of your team owns them",
            "Commitments — the orders you agreed, with the line items and totals at the time",
            "Documents — the invoices and receipts those orders produced",
            "Money — what was paid, when, and against which order",
            "Materials — files and links relevant to the work, with a note on what each is",
            "Correspondence — the messages you sent and what they were about",
            "Chronology — all of the above in date order, so cause and effect are visible",
          ]}
        />
      </Section>

      <Section title="Why records decay, and how to stop it" tint>
        <p>
          Records decay for one reason: keeping them up to date is a separate
          job from doing the work. Any system that relies on someone
          remembering to file things will be incomplete within a quarter, and
          an incomplete record is worse than none — it is trusted right up
          until the moment it is wrong.
        </p>
        <p>
          The fix is to make the record a by-product. In TraceTxn there is no
          separate filing step: the order you raise, the invoice it generates,
          the payment Stripe confirms and the email you send are all written to
          the client as they happen. Nobody has to maintain the history,
          because nobody is creating it by hand.
        </p>
        <Bullets
          items={[
            "Changes are recorded with who made them and when, in an audit trail",
            "Payment confirmations arrive from Stripe and attach themselves to the order",
            "Documents stay linked to the order that produced them rather than living loose",
            "Client history is searchable, so retrieval does not depend on memory",
          ]}
        />
      </Section>

      <Section title="Keeping a complete client history">
        <p>
          The test of a client record is simple: can someone who was not
          involved reconstruct what happened, in order, without asking anyone?
          If yes, the record is doing its job. If it needs a conversation to
          make sense, it is a filing cabinet rather than a history.
        </p>
        <p>
          That standard is why the timeline is the centre of the client record
          rather than a tab beside it. For how the correspondence half works,
          see{" "}
          <Link
            href="/client-communication-management"
            className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
          >
            client communication management
          </Link>
          ; for the category overview, see{" "}
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
