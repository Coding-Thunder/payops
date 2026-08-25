import type { Metadata } from "next";

import {
  H3,
  LegalDoc,
  Mail,
  Note,
  OL,
  P,
  PageLink,
  UL,
  type LegalSection,
} from "@/components/marketing/legal-doc";

import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Data Processing Addendum (DPA)",
  description: "How TraceTxn processes personal data on behalf of the businesses using the Service, what a DPA covers, and how to request data-processing terms.",
  path: "/dpa",
});

/* ─────────────────────────────────────────────────────────────────────
 * MANUAL REVIEW REQUIRED — resolve before publishing.
 *
 * This page was rewritten for the current TraceTxn product (a client
 * record management platform for agencies and freelancers) and the
 * private-beta stage. It deliberately avoids inventing legal facts.
 * Each item below still needs a human (ideally counsel) to confirm:
 *
 *  1. Legal entity operating TraceTxn. Privacy Policy + Terms currently
 *     name "Vinay Maheshwari, sole-proprietor operating TraceTxn"
 *     (governing law: India). This page does not restate the entity;
 *     confirm the correct counterparty before the DPA is offered.
 *  2. Whether a standard EXECUTABLE DPA actually exists. Assumed NOT
 *     ready — section 05 says it is "being finalized". Remove that line
 *     only once a real signable document exists.
 *  3. Current sub-processors. Referenced via the Privacy Policy rather
 *     than listed here; the Privacy Policy list still reflects the OLD
 *     payment-ops product and must be reconciled to the new product.
 *  4. File-storage provider. The product describes storing "files and
 *     documents", but no general file/blob storage exists in the code
 *     today (only HTML invoice/receipt snapshots + branding logos).
 *     Confirm where uploaded client files will live before promising it.
 *  5. Data locations. Not asserted here; depends on (3)/(4).
 *  6. International transfer mechanisms. NOT claimed (no SCCs / UK IDTA /
 *     adequacy). Section 06 flags them as pending review. Note: the
 *     Privacy Policy DOES mention SCCs "where applicable" — reconcile.
 *  7. Consent metadata. Timestamp / signed name / IP / user-agent are
 *     CONFIRMED in code (payment-consent.model.ts: requestedAt/
 *     receivedAt/verifiedAt, signedName, receiptIp, receiptUserAgent),
 *     but capture is currently tied to the legacy order-linked consent
 *     flow. Confirm this carries into the new client-record consent UX.
 *  8. Client-data categories (section 04) — confirm against the shipped
 *     client-record schema once it lands.
 *  9. Retention / deletion practices. Stated generically ("not
 *     immediate", backups exist). Do not promise specific windows until
 *     the Privacy Policy retention section is updated for the new product.
 * 10. Security measures referenced by the DPA — the Security page still
 *     describes the OLD product (Stripe creds, evidence chain, BYOS).
 *     Reconcile before relying on it for the new product.
 * 11. Data-subject request process — described as "reasonable
 *     assistance"; confirm the operational process exists.
 * 12. Breach-notification process — no deadline invented; confirm the
 *     actual notification workflow and any contractual deadline.
 *
 * BROADER FLAG: Privacy Policy, Terms of Service, and Security page all
 * still describe the old payment-operations / evidence-chain / BYOS-
 * Stripe product. This DPA page now describes the new product, so it is
 * intentionally ahead of its siblings. Those pages must be updated for
 * the page set to be internally consistent (see the task's "MOST
 * IMPORTANT" note).
 *
 * Also confirm: legal@tracetxn.com is the correct monitored inbox
 * (used consistently across the legal pages) and the "Last updated /
 * Effective" dates below.
 * ───────────────────────────────────────────────────────────────────── */

const SECTIONS: LegalSection[] = [
  {
    id: "what",
    title: "What a DPA is",
    children: (
      <>
        <P>
          A Data Processing Addendum (&quot;DPA&quot;) is a contract,
          typically between a controller and a processor, that sets out
          how personal data will be handled by the processor on the
          controller&apos;s behalf.
        </P>
        <P>
          When an agency, freelancer, or business stores personal
          information about its clients in TraceTxn, that business
          generally determines why and how the information is used. In
          that situation the business may act as the{" "}
          <strong>controller</strong> and TraceTxn may act as its{" "}
          <strong>processor</strong>. A DPA documents that relationship.
        </P>
        <Note>
          Exact legal roles can depend on the law that applies to you and
          on the circumstances of your processing. This page describes
          the common case, it is not legal advice, and it does not by
          itself create a data-processing agreement.
        </Note>
      </>
    ),
  },
  {
    id: "when-you-may-need",
    title: "When you may need one",
    children: (
      <>
        <P>
          You may need a DPA or similar data-processing terms if privacy
          laws applicable to your business require a written agreement
          with service providers that process personal data on your
          behalf.
        </P>
        <P>
          Under the EU / UK GDPR, for example, a controller is generally
          required to put a written agreement in place with each
          processor it uses. Other privacy laws, such as
          California&apos;s CCPA/CPRA, Brazil&apos;s LGPD, or
          India&apos;s Digital Personal Data Protection Act, may set
          their own requirements for engaging service providers. They do
          not all impose the same terms, so whether you need one, and
          what it has to say, depends on the laws that apply to you.
        </P>
        <Note>
          If you are unsure, check with your own advisers. Some
          businesses keep data-processing terms on file even where they
          are not strictly required.
        </Note>
      </>
    ),
  },
  {
    id: "whats-in-it",
    title: "What our DPA covers",
    children: (
      <>
        <P>A DPA for TraceTxn is designed to cover:</P>
        <UL>
          <li>
            <strong>Roles &amp; instructions.</strong> That you act as
            the controller and TraceTxn acts as the processor for Client
            Data, and that TraceTxn processes Client Data according to
            your documented instructions and as necessary to provide the
            Service.
          </li>
          <li>
            <strong>Processing details.</strong> The subject matter,
            nature, purpose, and duration of the processing, the
            categories of data subjects, and the types of personal data,
            summarised in section 04 below.
          </li>
          <li>
            <strong>Sub-processors.</strong> That TraceTxn may use
            service providers to help operate the Service. The current
            list is maintained in our{" "}
            <PageLink href="/privacy">Privacy Policy</PageLink>, with a
            mechanism to notify you of changes.
          </li>
          <li>
            <strong>Security.</strong> The technical and organisational
            measures TraceTxn applies, described on our{" "}
            <PageLink href="/security">Security page</PageLink>. TraceTxn
            does not claim certifications (such as SOC 2) or third-party
            penetration tests it has not completed, the Security page is
            candid about what is and is not in place today.
          </li>
          <li>
            <strong>Data subject requests.</strong> That, where TraceTxn
            acts as processor, it will reasonably assist you with
            applicable requests concerning Client Data. TraceTxn
            generally does not independently decide how to respond to a
            request from one of your clients, it looks to you, as
            controller, for instructions.
          </li>
          <li>
            <strong>Personal-data breaches.</strong> A commitment to
            notify affected customers of a personal-data breach as
            required by applicable law and the executed DPA.
          </li>
          <li>
            <strong>Return &amp; deletion.</strong> That, on termination,
            Client Data is returned or deleted in line with the
            Service&apos;s actual deletion and retention behaviour and
            applicable legal requirements. Because backups and retention
            processes exist, deletion may not be immediate.
          </li>
          <li>
            <strong>Audit &amp; information rights.</strong> The
            information and audit rights actually offered in the standard
            DPA, typically a commitment to respond to reasonable written
            information requests. TraceTxn does not currently provide
            third-party audit reports.
          </li>
        </UL>
      </>
    ),
  },
  {
    id: "client-data",
    title: "Client Data processed through TraceTxn",
    children: (
      <>
        <P>
          When you use TraceTxn as a client record management platform,
          the personal data you process through the Service
          (&quot;Client Data&quot;) may relate to the people, and be of
          the kinds, set out below.
        </P>
        <H3>Data subjects may include</H3>
        <UL>
          <li>your clients;</li>
          <li>your clients&apos; contacts;</li>
          <li>workspace users;</li>
          <li>invited team members;</li>
          <li>
            other individuals whose personal information appears in the
            client records or documents you add.
          </li>
        </UL>
        <H3>Client Data may include</H3>
        <UL>
          <li>name;</li>
          <li>email address;</li>
          <li>phone number;</li>
          <li>business / company details;</li>
          <li>invoice information;</li>
          <li>payment status and records;</li>
          <li>agreements;</li>
          <li>consent records;</li>
          <li>notes;</li>
          <li>files and documents;</li>
          <li>client activity / timeline information.</li>
        </UL>
        <H3>Consent-record metadata</H3>
        <P>
          Where you use TraceTxn to capture a client&apos;s
          acknowledgement, the consent record may include a timestamp,
          the name the person typed to sign, and the IP address and
          browser user-agent captured at the moment of acknowledgement.
        </P>
        <P>
          TraceTxn does not process payment card numbers or similar
          financial-account details.
        </P>
      </>
    ),
  },
  {
    id: "request",
    title: "How to request a DPA",
    children: (
      <>
        <P>
          Email <Mail address="legal@tracetxn.com" /> from the address
          associated with your TraceTxn workspace and we&apos;ll review
          your request. It helps to include:
        </P>
        <OL>
          <li>
            <strong>Workspace name</strong> (or slug) the terms should
            apply to;
          </li>
          <li>
            <strong>Legal entity / business name</strong> that should
            appear as the counterparty;
          </li>
          <li>
            <strong>Registered or business address</strong>;
          </li>
          <li>
            <strong>Signatory name &amp; title</strong>;
          </li>
          <li>
            <strong>Relevant jurisdiction / region</strong> where your
            clients are located;
          </li>
          <li>
            any <strong>procurement requirements</strong> we should know
            about.
          </li>
        </OL>
        <Note>
          Our standard DPA is currently being finalized. Contact us if
          you need data-processing terms for your organization, and
          we&apos;ll review your request.
        </Note>
      </>
    ),
  },
  {
    id: "international",
    title: "International data transfers",
    children: (
      <>
        <P>
          TraceTxn relies on service providers (sub-processors) to
          operate the Service. Where those providers operate in more than
          one country, personal data, including Client Data, may be
          transferred internationally. The current providers and the
          regions they operate in are described in our{" "}
          <PageLink href="/privacy">Privacy Policy</PageLink>.
        </P>
        <P>
          The specific legal mechanisms that would apply to those
          transfers, such as standard contractual clauses or comparable
          instruments, have not been finalized at TraceTxn&apos;s current
          stage and are pending review. We will describe them here once
          they are in place. In the meantime, contact us if your
          organization needs particular transfer terms.
        </P>
      </>
    ),
  },
  {
    id: "your-responsibilities",
    title: "What you should do",
    children: (
      <>
        <P>If you store Client Data in TraceTxn, you should:</P>
        <UL>
          <li>
            maintain an appropriate privacy notice that reflects your use
            of a service provider like TraceTxn;
          </li>
          <li>
            make sure you have a lawful basis for the Client Data you
            store;
          </li>
          <li>keep workspace access limited to authorised people;</li>
          <li>
            handle privacy requests from your clients appropriately;
          </li>
          <li>avoid uploading personal data you do not need;</li>
          <li>
            remove access for team members who no longer need it.
          </li>
        </UL>
        <Note>
          This is general guidance, not legal advice. Your obligations
          depend on the laws that apply to you and your clients.
        </Note>
      </>
    ),
  },
  {
    id: "data-flow",
    title: "Where TraceTxn sits in your data flow",
    children: (
      <>
        <P>
          Through the Service, TraceTxn may process personal data about:
        </P>
        <UL>
          <li>workspace users;</li>
          <li>team members you invite;</li>
          <li>your clients;</li>
          <li>your clients&apos; contacts;</li>
          <li>people mentioned in client records;</li>
          <li>
            people whose information appears in files or documents you
            upload.
          </li>
        </UL>
        <P>
          More detail on the categories we handle is in our{" "}
          <PageLink href="/privacy">Privacy Policy</PageLink>.
        </P>
        <H3>A note on consent records</H3>
        <P>
          TraceTxn lets you store a client&apos;s consent or
          acknowledgement, for example, agreement to a scope, a price, or
          a project decision. A consent record stored in TraceTxn is part
          of your Client Data.
        </P>
        <P>
          Storing that record does not, on its own, mean the person has
          given consent under privacy law to the processing of their
          personal data. &quot;Client consent to a scope, price, or
          project decision&quot; and &quot;privacy-law consent to the
          processing of personal data&quot; are different things. You
          remain responsible for having a lawful basis for the Client
          Data you store.
        </P>
      </>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    children: (
      <>
        <P>
          Questions about this page, a DPA, or privacy? Email{" "}
          <Mail address="legal@tracetxn.com" />. For product or account
          support, see{" "}
          <PageLink href="/contact">our Contact page</PageLink>.
        </P>
      </>
    ),
  },
];

export default function DpaPage() {
  return (
    <LegalDoc
      badge="DPA"
      title="Data Processing Addendum"
      intro="Information about how TraceTxn processes personal data on behalf of the businesses using the Service, what a DPA covers, and how to request data-processing terms for your organization."
      lastUpdated="2026-07-25"
      effectiveDate="2026-07-25"
      heroCta={{ label: "Request a DPA", href: "#request" }}
      sections={SECTIONS}
    />
  );
}
