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

export const metadata: Metadata = {
  title: "Data Processing Addendum (DPA)",
  description:
    "When you need a DPA with TraceTxn, what our standard DPA includes (SCCs, sub-processor list, security measures), and how to request a counter-signed copy.",
  alternates: { canonical: "/dpa" },
};

const SECTIONS: LegalSection[] = [
  {
    id: "what",
    title: "What a DPA is",
    children: (
      <>
        <P>
          A Data Processing Addendum (&quot;DPA&quot;) is a contract
          between two parties — typically a controller and a processor —
          that sets out how personal data will be handled by the
          processor on the controller&apos;s behalf. Under the EU/UK
          GDPR (and equivalent laws in other regions), a controller is
          required to have one with each of its processors.
        </P>
        <P>
          When you use TraceTxn to handle personal data about your
          customers (their names, contact details, order metadata), you
          are the controller and we are your processor. A signed DPA
          documents that relationship.
        </P>
      </>
    ),
  },
  {
    id: "when-you-need",
    title: "When you need one with us",
    children: (
      <>
        <P>You typically need a DPA with TraceTxn if:</P>
        <UL>
          <li>
            you process personal data of individuals located in the
            European Economic Area (EEA), the United Kingdom, or
            Switzerland;
          </li>
          <li>
            you are subject to the EU/UK GDPR (whether by establishment
            or by targeting EEA/UK individuals);
          </li>
          <li>
            you fall under another regional law that requires
            documented controller-processor terms — for example, India&apos;s
            Digital Personal Data Protection Act, Brazil&apos;s LGPD,
            California&apos;s CCPA/CPRA, or Quebec&apos;s Law 25.
          </li>
        </UL>
        <Note>
          If you only process personal data of individuals located in
          jurisdictions that don&apos;t require a DPA, you can still
          request one — many customers prefer to have one on file
          regardless.
        </Note>
      </>
    ),
  },
  {
    id: "whats-in-it",
    title: "What our standard DPA includes",
    children: (
      <>
        <P>Our standard DPA covers:</P>
        <UL>
          <li>
            <strong>Roles &amp; instructions.</strong> Confirmation that
            you are the controller and we are the processor; that we
            process personal data only on your documented instructions
            (which include the Service itself).
          </li>
          <li>
            <strong>Subject matter, duration, nature, purpose.</strong>{" "}
            The types of personal data and categories of data subjects
            processed through the Service.
          </li>
          <li>
            <strong>Sub-processors.</strong> Authorisation for the
            sub-processors listed in our{" "}
            <PageLink href="/privacy">Privacy Policy</PageLink>, with a
            notification mechanism for changes.
          </li>
          <li>
            <strong>Security measures.</strong> Technical and
            organisational measures we apply — encryption, access
            control, tenant isolation, audit logging, secure software
            development. Detailed on our{" "}
            <PageLink href="/security">Security page</PageLink>.
          </li>
          <li>
            <strong>International transfers.</strong> EU Standard
            Contractual Clauses (2021) and the UK International Data
            Transfer Addendum, where applicable.
          </li>
          <li>
            <strong>Personal-data breaches.</strong> Notification
            without undue delay after becoming aware of a confirmed
            breach affecting your data, with reasonable cooperation in
            your own notification obligations.
          </li>
          <li>
            <strong>Audit rights.</strong> Reasonable audit rights and
            cooperation, including via written assurances and (when
            available) third-party audit reports.
          </li>
          <li>
            <strong>Data subject requests.</strong> Cooperation with
            requests from your customers (access, deletion,
            portability, etc.) that we receive through the Service.
          </li>
          <li>
            <strong>Return / deletion.</strong> Return or deletion of
            personal data after termination of the Service, subject to
            legal retention.
          </li>
        </UL>
      </>
    ),
  },
  {
    id: "request",
    title: "How to request a signed DPA",
    children: (
      <>
        <P>
          Email <Mail address="legal@tracetxn.com" /> from the email
          associated with your TraceTxn workspace. Include:
        </P>
        <OL>
          <li>
            <strong>Workspace name</strong> (or slug) the DPA should
            apply to;
          </li>
          <li>
            <strong>Legal entity name</strong> for the controller (the
            entity that should appear as the counterparty);
          </li>
          <li>
            <strong>Registered address</strong> of the controller;
          </li>
          <li>
            <strong>Signatory name &amp; title</strong> — the person
            who&apos;ll counter-sign on the controller side;
          </li>
          <li>
            <strong>Region(s)</strong> where your data subjects are
            located — used to attach the right transfer mechanism
            (SCCs / UK Addendum / etc.) where applicable;
          </li>
          <li>
            optionally, any redlines you&apos;d like us to consider on
            our standard DPA.
          </li>
        </OL>
        <P>
          We aim to send a counter-signed PDF back within 2 business
          days. Most customers sign our standard DPA without redlines.
        </P>
      </>
    ),
  },
  {
    id: "controller-info",
    title: "If you process EEA/UK data through us",
    children: (
      <>
        <H3>What you should also do</H3>
        <UL>
          <li>
            Make sure your own privacy notice describes TraceTxn as a
            processor.
          </li>
          <li>
            Honour data-subject requests from your customers — we
            cooperate, but we are not authorised to act on your
            customers&apos; requests without your instruction.
          </li>
          <li>
            Keep your authorised users list current — anyone who can
            sign into your workspace can see workspace data.
          </li>
        </UL>
        <H3>Where TraceTxn sits in your data map</H3>
        <P>
          We process personal data about: workspace users, members
          invited to your workspace, customers you create orders for,
          and recipients of transactional emails you send through the
          Service. Detailed categories and retention periods are in our{" "}
          <PageLink href="/privacy">Privacy Policy</PageLink>.
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
          Privacy or DPA questions? Email{" "}
          <Mail address="legal@tracetxn.com" />. For non-legal product
          questions, see{" "}
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
      intro="A signed addendum that documents how we process your customers' personal data on your behalf. Required by GDPR and similar laws when you handle data of people in regulated regions."
      lastUpdated="2026-05-31"
      effectiveDate="2026-05-31"
      sections={SECTIONS}
    />
  );
}
