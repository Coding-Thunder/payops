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

const PAGE = landingPage("/client-communication-management");

export const metadata: Metadata = pageMetadata({
  title: PAGE.title,
  description: PAGE.description,
  path: PAGE.path,
});

/**
 * Spoke: communication intent.
 *
 * Scope discipline matters on this page more than anywhere else in the
 * cluster. TraceTxn sends email and records what it sent; it is NOT an inbox,
 * does not receive replies, and does not sync Gmail. Someone searching
 * "client communication software" may well be looking for a shared inbox, and
 * it is better that they learn that here than after signing up.
 */
export default function ClientCommunicationManagementPage() {
  return (
    <LandingShell
      path={PAGE.path}
      eyebrow="Client communication"
      h1="Client communication management that keeps the thread with the work"
      lede="Client communication goes missing not because it was deleted but because it was filed somewhere the work is not. TraceTxn sends client email from inside the record and keeps a copy of what was sent, against the client and the order it was about."
    >
      <Section title="Why client communication gets lost">
        <p>
          The message itself is rarely the problem. The problem is that the
          message lives in an inbox, the invoice lives in accounting, and the
          decision the message contained lives in neither. Six months later the
          only way to answer &ldquo;what did we tell them?&rdquo; is to search
          somebody&apos;s mail — assuming that somebody still works here and
          still has the thread.
        </p>
        <p>Three things reliably break:</p>
        <Bullets
          items={[
            "The conversation is separated from the order or invoice it concerned",
            "Only the sender has the history, so it leaves when they do",
            "Nobody can prove what was communicated, only what someone remembers",
          ]}
        />
      </Section>

      <Section title="How TraceTxn handles it" tint>
        <p>
          Communication is sent from the client record rather than from a
          mailbox, and what was sent is kept alongside everything else about
          that client.
        </p>
        <Bullets
          items={[
            "Compose and send client email from inside the order or client record",
            "Reusable templates, so the same message is not rewritten each time",
            "Every send is recorded against the client and the order it relates to",
            "The message appears on the client's dated timeline with the rest of the history",
            "Delivery is tracked, so a send that failed is visible rather than assumed",
            "Consent requests and their responses are recorded as part of the same trail",
          ]}
        />
      </Section>

      <Section title="What this is not">
        <p>
          Being precise, because it decides whether the tool fits:{" "}
          <strong>TraceTxn is not a shared inbox.</strong> It does not receive
          your client&apos;s replies, does not sync with Gmail or Outlook, and
          does not thread inbound mail. Replies land in your normal mailbox, as
          they always did.
        </p>
        <p>
          What it gives you is the outbound half kept permanently with the
          work: what you sent, when, about which order, and whether it arrived.
          For most teams that is the half that was missing.
        </p>
        <p>
          The related pieces are covered on{" "}
          <Link
            href="/client-record-management"
            className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
          >
            client records management
          </Link>{" "}
          and, for the wider picture,{" "}
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
