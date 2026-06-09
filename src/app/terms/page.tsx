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
  title: "Terms of Service",
  description:
    "Terms of Service for TraceTxn, the obligations between you (the operator using the platform) and us (the operator of TraceTxn).",
  alternates: { canonical: "/terms" },
};

/**
 * Baseline ToS, not a substitute for counsel. Reviewed before
 * relying on these for any commercial dispute. India operates as
 * the governing law because TraceTxn is run by an Indian
 * sole-proprietor today; rewrite this section if the entity moves.
 */

const SECTIONS: LegalSection[] = [
  {
    id: "acceptance",
    title: "Acceptance of these Terms",
    children: (
      <>
        <P>
          These Terms of Service (&quot;Terms&quot;) form a binding
          agreement between you (&quot;you&quot;, &quot;your&quot;, or
          &quot;Operator&quot;) and Vinay Maheshwari, the
          sole-proprietor operating TraceTxn (&quot;TraceTxn&quot;,
          &quot;we&quot;, &quot;us&quot;, or &quot;our&quot;). They
          govern your access to and use of the TraceTxn platform, our
          websites, and any related services (collectively, the
          &quot;Service&quot;).
        </P>
        <P>
          By creating an account, opening a workspace, or otherwise
          accessing the Service, you accept these Terms in full. If you
          do not agree, do not use the Service.
        </P>
        <P>
          If you accept these Terms on behalf of an employer or other
          legal entity, you represent that you have authority to do so
          and to bind that entity. &quot;You&quot; then refers to that
          entity.
        </P>
      </>
    ),
  },
  {
    id: "service",
    title: "The Service",
    children: (
      <>
        <P>
          TraceTxn is a software platform that helps operators take
          payments, capture customer consent, track payment lifecycle
          events, and assemble evidence for chargeback / dispute defense.
          TraceTxn connects to your own payment-processor account (today,
          Stripe) using credentials you provide, a model commonly called
          &quot;bring your own Stripe&quot; (BYOS).
        </P>
        <P>
          We do not process payments on our own account. Funds move
          directly between your customers and your connected
          payment-processor account. We never see, store, or have access
          to card numbers.
        </P>
        <Note>
          The Service evolves. We add features, change defaults, and
          retire experimental functionality from time to time. Material
          changes that affect billing or data handling are announced via
          email and reflected in the &quot;Last updated&quot; date above.
        </Note>
      </>
    ),
  },
  {
    id: "account",
    title: "Your account and workspace",
    children: (
      <>
        <P>
          You must register an account to use the Service. You agree to
          provide accurate information at sign-up, keep it current, and
          maintain the confidentiality of your sign-in credentials. You
          are responsible for all activity on your workspace and for
          ensuring that anyone you invite complies with these Terms.
        </P>
        <H3>Eligibility</H3>
        <P>
          You must be at least 18 years old, legally capable of entering
          into binding contracts, and not barred under applicable law
          from receiving the Service. The Service is intended for
          business use, not for personal, family, or household purposes.
        </P>
        <H3>Workspace ownership</H3>
        <P>
          The user who creates a workspace is its initial owner. Owners
          control billing, member access, and may transfer workspace
          ownership through in-product workflows when provided.
        </P>
      </>
    ),
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    children: (
      <>
        <P>You agree not to use the Service to:</P>
        <UL>
          <li>
            violate any law, regulation, third-party right, or
            payment-processor terms (including Stripe&apos;s Restricted
            Businesses);
          </li>
          <li>
            transmit malware, attempt to interfere with the Service&apos;s
            integrity, or probe for vulnerabilities outside the
            responsible-disclosure process described on{" "}
            <PageLink href="/security">our Security page</PageLink>;
          </li>
          <li>
            attempt to reverse-engineer, decompile, or extract source
            code from the Service, except as expressly permitted by law;
          </li>
          <li>
            scrape, mirror, or use the Service to build a competing
            product;
          </li>
          <li>
            send unsolicited communications, infringing content, or
            content that is fraudulent, deceptive, or designed to harm
            others;
          </li>
          <li>
            misrepresent your identity, impersonate any person or
            entity, or process payments under a business identity that
            does not belong to you.
          </li>
        </UL>
        <P>
          You are responsible for the lawfulness of the goods and
          services you offer through the Service, the accuracy of
          information you collect, and your compliance with the terms of
          any payment processor you connect.
        </P>
      </>
    ),
  },
  {
    id: "your-data",
    title: "Your data and content",
    children: (
      <>
        <P>
          You retain all rights to the data and content you submit to
          the Service (&quot;Your Data&quot;). You grant us a worldwide,
          non-exclusive, royalty-free licence to host, store, process,
          transmit, and display Your Data only as necessary to provide
          the Service, prevent abuse, comply with law, and improve the
          Service while you have an active account.
        </P>
        <P>
          You represent that you have all rights, consents, and legal
          bases needed to submit Your Data to the Service, including
          for any personal information of your customers.
        </P>
        <P>
          When you use the Service to process personal information of
          your customers, we act as a processor on your behalf. Our
          handling of that data is described in our{" "}
          <PageLink href="/privacy">Privacy Policy</PageLink> and, where
          a data processing addendum is required, in our{" "}
          <PageLink href="/dpa">DPA</PageLink>.
        </P>
      </>
    ),
  },
  {
    id: "payments",
    title: "Tenant payments (BYOS Stripe)",
    children: (
      <>
        <P>
          You connect your own Stripe account to TraceTxn. Funds
          collected through that account flow directly between your
          customers and Stripe and then to your bank, TraceTxn never
          holds settlement funds. Your contractual relationship for
          payment processing is with Stripe, governed by Stripe&apos;s
          terms.
        </P>
        <P>
          Stripe processing fees, chargeback fees, currency conversion
          spreads, and any other amounts charged by Stripe are between
          you and Stripe. TraceTxn does not add any per-transaction fee
          on top.
        </P>
        <P>
          You are responsible for keeping your Stripe credentials and
          webhook signing secrets up to date, configuring your Stripe
          account properly, and complying with Stripe&apos;s ongoing
          requirements (including, where applicable, PCI scope reduction
          using Stripe-hosted checkout).
        </P>
      </>
    ),
  },
  {
    id: "subscription",
    title: "Subscriptions, billing, and refunds",
    children: (
      <>
        <P>
          Access to TraceTxn is offered on a subscription basis. Current
          tiers, pricing, and feature differences are described on our{" "}
          <PageLink href="/pricing">Pricing page</PageLink>. You may
          change tiers at any time; tier changes take effect on the next
          billing cycle.
        </P>
        <P>
          Subscriptions renew automatically each billing period unless
          you cancel before the renewal date. If you cancel mid-period,
          your workspace stays on the paid tier until the end of the
          paid period and then converts to read-only access subject to
          our retention policy.
        </P>
        <P>
          We offer a 14-day no-questions money-back guarantee on new
          paid subscriptions. Full conditions and the request process
          are described in our{" "}
          <PageLink href="/refunds">Refund Policy</PageLink>.
        </P>
        <P>
          We may change subscription prices on at least 30 days&apos;
          email notice. Price changes take effect at the start of your
          next billing cycle after the notice period; you may cancel
          before then to avoid the new price.
        </P>
      </>
    ),
  },
  {
    id: "suspension",
    title: "Suspension and termination",
    children: (
      <>
        <P>
          You may stop using the Service at any time and may delete your
          workspace through in-product workflows. We may suspend or
          terminate your access if:
        </P>
        <UL>
          <li>
            you materially breach these Terms, including the Acceptable
            Use section;
          </li>
          <li>
            your account is past due on subscription fees and remains
            unpaid for more than 10 days after notice;
          </li>
          <li>
            we reasonably believe continued service exposes us, our
            other users, your customers, or third parties to legal,
            security, or reputational risk;
          </li>
          <li>required by law, court order, or payment-processor demand.</li>
        </UL>
        <P>
          On termination, your right to use the Service ends. We will
          make reasonable efforts to let you export Your Data for at
          least 30 days after termination, after which we may delete
          Your Data subject to legal retention obligations.
        </P>
      </>
    ),
  },
  {
    id: "ip",
    title: "Intellectual property",
    children: (
      <>
        <P>
          TraceTxn, the Service, our trademarks, logos, and all
          underlying software, designs, and content (excluding Your
          Data) are owned by us or our licensors and are protected by
          intellectual-property laws. We grant you a limited,
          non-exclusive, non-transferable, revocable licence to use the
          Service for your internal business purposes during your
          subscription.
        </P>
        <P>
          You agree not to remove, alter, or obscure any proprietary
          notices, and not to use our trademarks except as permitted in
          writing or under fair-use principles.
        </P>
        <P>
          Feedback you provide about the Service is appreciated and may
          be incorporated without obligation to you. You grant us a
          perpetual, royalty-free licence to use such feedback for any
          purpose without restriction.
        </P>
      </>
    ),
  },
  {
    id: "disclaimers",
    title: "Disclaimers",
    children: (
      <>
        <P>
          THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS
          AVAILABLE&quot;. TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE
          DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING
          WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
          PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE
          SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR THAT ANY
          PARTICULAR DEFECT WILL BE CORRECTED.
        </P>
        <P>
          The Service is a tool. We do not provide legal advice,
          financial advice, accounting advice, or chargeback guarantees.
          You remain responsible for your business decisions, including
          what evidence you submit in any payment dispute.
        </P>
      </>
    ),
  },
  {
    id: "liability",
    title: "Limitation of liability",
    children: (
      <>
        <P>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, NEITHER PARTY WILL BE
          LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL,
          OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, LOST REVENUE, LOST
          DATA, OR BUSINESS INTERRUPTION, ARISING OUT OF OR RELATING TO
          THESE TERMS OR THE SERVICE.
        </P>
        <P>
          OUR TOTAL AGGREGATE LIABILITY ARISING OUT OF OR RELATING TO
          THESE TERMS OR THE SERVICE WILL NOT EXCEED THE GREATER OF:
          (a) THE FEES YOU ACTUALLY PAID TO US FOR THE SERVICE IN THE
          12 MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM, OR
          (b) USD 100.
        </P>
        <P>
          Nothing in these Terms limits liability that cannot be limited
          under applicable law, for example, liability for gross
          negligence, willful misconduct, or fraud.
        </P>
      </>
    ),
  },
  {
    id: "indemnity",
    title: "Indemnification",
    children: (
      <>
        <P>
          You agree to defend, indemnify, and hold us harmless from any
          third-party claims, damages, liabilities, costs, and expenses
          (including reasonable legal fees) arising out of: (a) Your
          Data; (b) your use of the Service in violation of these Terms
          or applicable law; (c) your products, services, or business
          operations; or (d) your relationship with your customers or
          your payment processor.
        </P>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes to these Terms",
    children: (
      <>
        <P>
          We may update these Terms from time to time. If we make
          material changes that adversely affect you, we will notify you
          by email or through the Service at least 14 days before they
          take effect. Continued use of the Service after the effective
          date constitutes acceptance of the updated Terms.
        </P>
      </>
    ),
  },
  {
    id: "law",
    title: "Governing law and disputes",
    children: (
      <>
        <P>
          These Terms are governed by the laws of India, without regard
          to its conflict-of-laws principles. The courts located in the
          operator&apos;s ordinary place of residence in India have
          exclusive jurisdiction over any dispute arising out of or
          relating to these Terms, except that either party may seek
          injunctive relief in any court of competent jurisdiction to
          protect its intellectual-property rights.
        </P>
        <P>
          The parties will use good-faith efforts to resolve disputes
          informally before commencing formal proceedings. Notices of
          dispute should be sent to{" "}
          <Mail address="legal@tracetxn.com" />.
        </P>
      </>
    ),
  },
  {
    id: "miscellaneous",
    title: "Miscellaneous",
    children: (
      <>
        <OL>
          <li>
            <strong>Entire agreement.</strong> These Terms, together
            with the Privacy Policy, Refund Policy, and any DPA we sign
            with you, are the entire agreement between you and us on
            their subject matter.
          </li>
          <li>
            <strong>Severability.</strong> If any provision is held
            unenforceable, the remainder of these Terms remains in
            effect.
          </li>
          <li>
            <strong>No waiver.</strong> Failure to enforce a provision
            is not a waiver of our right to enforce it later.
          </li>
          <li>
            <strong>Assignment.</strong> You may not assign these Terms
            without our prior written consent. We may assign these Terms
            in connection with a merger, acquisition, or sale of assets.
          </li>
          <li>
            <strong>Force majeure.</strong> Neither party is liable for
            delays or failures caused by events beyond reasonable
            control.
          </li>
          <li>
            <strong>Notices.</strong> Legal notices to us must be sent
            to <Mail address="legal@tracetxn.com" />. Notices to you may
            be sent to the email associated with your workspace.
          </li>
        </OL>
      </>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    children: (
      <>
        <P>
          Questions about these Terms? Email{" "}
          <Mail address="legal@tracetxn.com" />. For product or account
          support, see{" "}
          <PageLink href="/contact">our Contact page</PageLink>.
        </P>
      </>
    ),
  },
];

export default function TermsPage() {
  return (
    <LegalDoc
      badge="Terms"
      title="Terms of Service"
      intro="The agreement between you, the operator using TraceTxn, and us, the team running it. Written to be clear about what we promise, what we don't, and what each side is responsible for."
      lastUpdated="2026-05-31"
      effectiveDate="2026-05-31"
      sections={SECTIONS}
    />
  );
}
