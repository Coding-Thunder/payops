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
  title: "Terms of Service",
  description: "Terms of Service for TraceTxn, the client record platform for agencies and freelancers. The obligations between you (the business using the platform) and us.",
  path: "/terms",
});

/* ─────────────────────────────────────────────────────────────────────
 * MANUAL LEGAL REVIEW REQUIRED — resolve before publishing.
 *
 * These Terms were rewritten for the CURRENT TraceTxn product (a client
 * record management platform for agencies and freelancers). They
 * deliberately do not invent legal facts, guarantees, pricing,
 * jurisdictions, or product capabilities, and their terminology and
 * substance are aligned to the already-migrated, code-grounded Privacy
 * Policy and DPA. Each item below still needs a human (ideally counsel)
 * to confirm:
 *
 *  1. LEGAL ENTITY (§01). Still names "Vinay Maheshwari, the
 *     sole-proprietor operating TraceTxn" — kept unchanged per
 *     instruction and consistent with Privacy/DPA. Confirm the actual
 *     operator; if it changes, revisit §01 and §14 (governing law).
 *  2. FREE-BETA / STAGE (§02/§07). §02/§07 describe a free private beta
 *     with no card required, per the brief. HOWEVER the Privacy Policy
 *     (from code review) notes the public /pricing page markets three
 *     paid tiers ($39 / $99 / $249) with an OPEN /signup, and therefore
 *     says only "free" and drops "private beta". Reconcile: either gate
 *     signups so "private beta" is accurate, or align these Terms to the
 *     Privacy Policy's "free, not private beta" framing.
 *  3. EXISTING PAID CUSTOMERS (§07/§08/§15). Drafted assuming NO paying
 *     customers (subscription billing is confirmed NOT live; new
 *     workspaces get a time-limited free evaluation). If some users pay:
 *     restore the unpaid-fees suspension ground (§08), the billing /
 *     renewal obligations (§07), and the Refund Policy in the entire-
 *     agreement clause (§15) and footer.
 *  4. LIABILITY CAP (§11). Left UNCHANGED ("greater of fees paid in the
 *     previous 12 months or USD 100"). While the Service is free the
 *     fees-paid figure is USD 0, so the effective cap is USD 100.
 *     MANUAL LEGAL REVIEW REQUIRED: liability cap during the free stage.
 *  5. GOVERNING LAW / JURISDICTION (§14). Left UNCHANGED (India), tied to
 *     the sole-proprietor in §01. Re-review if the operating entity moves.
 *  6. EXPORT FUNCTIONALITY (§08). The old fixed "30-day export window"
 *     was removed; §08 points to the Privacy Policy. Confirm what export
 *     actually exists before promising any window.
 *  7. RETENTION AFTER TERMINATION (§08). Points to the Privacy Policy,
 *     which frames workspace closure as request-based (archive, not
 *     immediate erasure; no self-serve deletion UI or timed purge in code
 *     today). Confirm the real retention/deletion behaviour.
 *  8. THIRD-PARTY INTEGRATIONS (§06). Stripe is named as an OPTIONAL
 *     per-tenant (BYOS) integration — confirmed live in code and in the
 *     Privacy Policy ("connect your own Stripe account to collect
 *     payments from your Clients"; TraceTxn's OWN subscription billing is
 *     NOT live). Confirm Stripe is the only current integration.
 *  9. CLIENT CONSENT (§10). Consent metadata (timestamp, typed signed
 *     name, IP, user-agent) is confirmed in code, currently tied to the
 *     order/booking → checkout flow. §10 describes it only as a "record"
 *     of consent, never as legal proof — consistent with Privacy/DPA.
 * 10. REFUND POLICY (§15 + footer). Removed from the entire-agreement
 *     clause and the footer Legal column while the Service is free.
 *     /refunds has ALREADY been migrated to a free-beta notice (it no
 *     longer describes a paid 14-day money-back guarantee), so nothing
 *     stale is linked. Re-add if paid plans/customers exist (item 3).
 * 11. ACCOUNT / WORKSPACE PERMISSIONS (§03). Owner/member wording kept
 *     generic. Confirm the actual roles, member-access model, and
 *     ownership-transfer feature.
 * 12. PRIVACY POLICY + DPA CONSISTENCY. Terminology and substance here
 *     match the already-migrated Privacy Policy and DPA (User/Customer =
 *     the business; Client / Client Contact = their customer; Client
 *     Data; controller/processor; softened change-notice period; Stripe
 *     as optional BYOS). REMAINING: confirm the /security page has been
 *     migrated off the old payment-ops / evidence-chain product before
 *     relying on the §04 cross-link.
 *
 * ALSO CONFIRM:
 *  - FILES / DOCUMENTS / AGREEMENTS (§02/§05). The brief listed "files
 *    and documents" and "agreements" as record contents, but per the
 *    Privacy Policy the product supports NO arbitrary file/document
 *    upload (only a workspace logo; "documents" = generated invoices /
 *    receipts). §02/§05 were aligned to that reality and do not claim
 *    file/agreement attachment. Expand when/if that feature ships.
 *  - Notice period for Terms changes (§13) softened to "reasonable
 *    advance notice", consistent with the Privacy Policy.
 *  - legal@tracetxn.com (§14/§15/§16) is a correct, monitored inbox.
 *  - "Last updated / Effective" dates below (2026-07-25) match Privacy/DPA.
 * ───────────────────────────────────────────────────────────────────── */

const SECTIONS: LegalSection[] = [
  {
    id: "acceptance",
    title: "Acceptance of these Terms",
    children: (
      <>
        {/* MANUAL LEGAL REVIEW FLAG (1): legal entity operating TraceTxn.
            "Vinay Maheshwari, the sole-proprietor" is kept unchanged
            pending verification of the actual operator. Do not change
            without confirmation; §14 governing law depends on it. */}
        <P>
          These Terms of Service (&quot;Terms&quot;) form a binding
          agreement between you (&quot;you&quot;, &quot;your&quot;,
          &quot;User&quot;, or &quot;Customer&quot;) and Vinay
          Maheshwari, the sole-proprietor operating TraceTxn
          (&quot;TraceTxn&quot;, &quot;we&quot;, &quot;us&quot;, or
          &quot;our&quot;). They govern your access to and use of the
          TraceTxn platform, our websites, and any related services
          (collectively, the &quot;Service&quot;).
        </P>
        <P>
          By creating an account, opening a workspace, or otherwise
          accessing the Service, you accept these Terms in full. If you
          do not agree, do not use the Service.
        </P>
        <P>
          If you accept these Terms on behalf of an employer, business,
          or other legal entity, you represent that you have authority to
          do so and to bind that entity, and &quot;you&quot; then refers
          to that entity. The Service is intended for business use.
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
          TraceTxn is a software platform that helps agencies,
          freelancers, and other service businesses organize the
          information related to their client relationships. It allows you
          to create and maintain a searchable record for each of your
          Clients.
        </P>
        <P>
          Depending on the features available to you, a Client record may
          include contact information, notes, the invoices and receipts
          you issue, payment records, consent records, and activity
          history. TraceTxn is a tool for keeping this information
          together and searchable. It is not a payment processor, an
          accounting platform, a CRM, a project-management platform, or a
          legal service.
        </P>
        <P>
          The Service evolves. We may add, change, or remove features,
          change defaults, and retire functionality from time to time. We
          aim to notify you of material changes that affect data handling
          by email or through the Service, and such changes are reflected
          in the &quot;Last updated&quot; date above.
        </P>
        <Note>
          TraceTxn is currently offered as a private beta. Beta features
          may be incomplete, change, contain errors, or be removed as the
          Service develops.
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
          are responsible for all activity in your workspace and for
          ensuring that anyone you invite to it complies with these Terms.
        </P>
        <H3>Eligibility</H3>
        <P>
          You must be at least 18 years old, legally capable of entering
          into binding contracts, and not barred under applicable law
          from receiving the Service. The Service is intended for
          business use, not for personal, family, or household purposes.
        </P>
        <H3>Workspace ownership</H3>
        {/* MANUAL LEGAL REVIEW FLAG (11): confirm the actual roles,
            member-access model, and ownership-transfer feature before
            hardening this wording. */}
        <P>
          The user who creates a workspace is its initial owner. Owners
          manage workspace settings and member access, and may transfer
          workspace ownership where in-product workflows are provided.
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
          <li>violate any law, regulation, or third-party right;</li>
          <li>
            engage in fraud, or upload content that is fraudulent,
            deceptive, or designed to harm others;
          </li>
          <li>
            transmit malware, gain unauthorized access to any system or
            account, interfere with the integrity or performance of the
            Service, or probe for vulnerabilities outside the
            responsible-disclosure process described on{" "}
            <PageLink href="/security">our Security page</PageLink>;
          </li>
          <li>
            impersonate any person or entity, or misrepresent your
            identity or affiliation;
          </li>
          <li>
            send unsolicited or unlawful communications, or upload
            infringing content;
          </li>
          <li>
            violate the privacy rights of any person, including any Client
            or other individual whose information you add to the Service;
          </li>
          <li>
            store or process information in the Service that you do not
            have the legal right or a lawful basis to process;
          </li>
          <li>
            reverse-engineer, decompile, or extract source code from the
            Service, except to the extent this restriction is prohibited
            by applicable law.
          </li>
        </UL>
        <P>
          You are responsible for the information you add to the Service,
          the lawfulness of your business and the services you provide to
          your Clients, and your compliance with the terms of any
          third-party service you connect. Nothing in this section is
          intended to prevent you from exporting Your Data or exercising
          rights that cannot be waived under applicable law.
        </P>
      </>
    ),
  },
  {
    id: "your-data",
    title: "Your data and Client Data",
    children: (
      <>
        <P>
          You retain ownership of Your Data. &quot;Your Data&quot; means
          the information and content you submit to or create in the
          Service, including Client records, contact details, notes, the
          invoices and receipts you issue, payment records, consent
          records, and other content. &quot;Client Data&quot; means the
          information within Your Data that relates to your Clients.
        </P>
        <P>
          You grant us a limited, worldwide, non-exclusive, royalty-free
          licence to host, store, process, transmit, and display Your
          Data solely as needed to provide, secure, maintain, and support
          the Service and to comply with law. We do not claim ownership of
          Your Data or your Client Data.
        </P>
        <P>
          You represent that you have the necessary rights, permissions,
          notices, consents, or other lawful basis required to add
          personal information and Client Data to the Service.
        </P>
        {/* MANUAL LEGAL REVIEW FLAG (12): keep the controller/processor
            split consistent with the Privacy Policy + DPA. The Privacy
            Policy still describes the old product and must be updated. */}
        <P>
          When you use the Service to process personal information about
          your Clients, you act as the controller of that information and
          we act as a processor on your behalf. Our handling of that data
          is described in our{" "}
          <PageLink href="/privacy">Privacy Policy</PageLink> and, where a
          data processing addendum is required, in our{" "}
          <PageLink href="/dpa">DPA</PageLink>.
        </P>
      </>
    ),
  },
  {
    id: "integrations",
    title: "Third-party services and integrations",
    children: (
      <>
        {/* MANUAL LEGAL REVIEW FLAG (8): Stripe (optional BYOS) is
            confirmed live in code and in the Privacy Policy. Confirm it is
            the only current integration; name others here if offered. */}
        <P>
          The Service may allow you to connect third-party services. Where
          such integrations are offered, connecting them is optional and
          at your discretion. Today, you may optionally connect your own
          Stripe account so that you can collect payments from your
          Clients; TraceTxn does not process those payments and never
          receives or stores card numbers.
        </P>
        <P>
          Third-party services (including Stripe) are provided by their
          respective operators, not by TraceTxn, and are governed by their
          own terms and privacy policies. Your relationship for any
          payment processing is with the third-party provider. TraceTxn is
          not responsible for the operation, availability, security, or
          content of any third-party service.
        </P>
        <P>
          You are responsible for maintaining any third-party accounts you
          connect, for the credentials used to connect them, and for
          complying with the third party&apos;s requirements. The
          availability of any integration may change, and an integration
          may be added, changed, or removed as the Service develops.
        </P>
      </>
    ),
  },
  {
    id: "beta-pricing",
    title: "Private beta and pricing",
    children: (
      <>
        {/* MANUAL LEGAL REVIEW FLAG (2)/(3): confirm the beta is free and
            no card is required, and whether any users already pay. If
            paid customers exist, reinstate their billing/renewal
            obligations rather than deleting them. */}
        <P>
          TraceTxn is currently available as a private beta. Participation
          in the beta is currently free, and no credit card is required to
          take part.
        </P>
        <P>
          We may introduce paid plans in the future. If we do, we will
          give you reasonable notice before your continued use of the
          Service becomes subject to a paid plan, so that you can decide
          whether to continue.
        </P>
        <P>
          Any current plans and pricing are described on our{" "}
          <PageLink href="/pricing">Pricing page</PageLink>. These Terms do
          not set or promise any particular price, and nothing here grants
          lifetime free access, a lifetime discount, or grandfathered
          pricing.
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
          You may stop using the Service at any time and may ask us to
          close your workspace. We may suspend or terminate your access
          if:
        </P>
        {/* MANUAL LEGAL REVIEW FLAG (3): the unpaid-subscription-fees
            suspension ground was removed because the beta is free. If
            paid customers exist, restore it. */}
        <UL>
          <li>
            you materially breach these Terms, including the Acceptable
            Use section;
          </li>
          <li>
            your use is illegal or abusive, or creates a security risk to
            the Service, other users, your Clients, or third parties;
          </li>
          <li>
            we reasonably believe continued service exposes us, other
            users, your Clients, or third parties to legal or reputational
            risk; or
          </li>
          <li>we are required to do so by law or valid legal process.</li>
        </UL>
        {/* MANUAL LEGAL REVIEW FLAG (6)/(7): the old fixed 30-day export
            promise was removed. Confirm the real export capability and
            retention/deletion behaviour and keep it consistent with the
            Privacy Policy. */}
        <P>
          On termination, your right to use the Service ends. The export,
          retention, and deletion of Your Data following termination are
          handled in accordance with our{" "}
          <PageLink href="/privacy">Privacy Policy</PageLink> and any
          applicable legal retention obligations.
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
          underlying software, designs, and content (excluding Your Data)
          are owned by us or our licensors and are protected by
          intellectual-property laws. We grant you a limited,
          non-exclusive, non-transferable, revocable licence to use the
          Service for your internal business purposes while these Terms
          are in effect.
        </P>
        <P>
          You agree not to remove, alter, or obscure any proprietary
          notices, and not to use our trademarks except as permitted in
          writing or under fair-use principles.
        </P>
        <P>
          Feedback you provide about the Service is appreciated and may be
          incorporated without obligation to you. You grant us a
          perpetual, royalty-free licence to use such feedback for any
          purpose without restriction. This does not give us any rights in
          Your Data or your Client Data beyond those needed to provide the
          Service.
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
          TraceTxn helps you organize and maintain records about your
          Clients. It does not guarantee any particular outcome in your
          client relationships. In particular, TraceTxn does not guarantee
          that a Client will pay an invoice, will not request a refund, or
          will not dispute your work.
        </P>
        {/* MANUAL LEGAL REVIEW FLAG (9): consent is described only as a
            "record", never as legal proof. Confirm the consent-capture
            implementation carries into the new client-record UX. */}
        <P>
          Records you keep in TraceTxn, including timestamped consent
          records, are a record of what occurred. They are not a guarantee
          of any legal result. TraceTxn does not guarantee that a consent
          record will prevent a dispute, will be accepted as legal
          evidence, or is legally binding in any particular jurisdiction.
        </P>
        <P>
          TraceTxn does not provide legal, tax, accounting, or financial
          advice. You remain responsible for determining whether your
          contracts, consent processes, invoices, and business practices
          comply with applicable law.
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
        {/* MANUAL LEGAL REVIEW REQUIRED — FLAG (4): liability cap during
            free beta. The cap is left UNCHANGED per instruction. During
            the free beta the fees-paid figure is USD 0, so the effective
            cap is USD 100. Have counsel review before publishing. */}
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
          (including reasonable legal fees) arising out of: (a) Your Data
          or your Client Data; (b) your use of the Service in violation of
          these Terms or applicable law; (c) your products, services, or
          business operations; (d) your infringement or violation of the
          rights of any third party; or (e) your relationship with your
          Clients.
        </P>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes to these Terms",
    children: (
      <>
        {/* Notice period softened from a fixed "at least 14 days" to
            "reasonable advance notice", consistent with the Privacy Policy
            (which likewise softened its change-notice language). */}
        <P>
          We may update these Terms from time to time. If we make material
          changes that adversely affect you, we will provide reasonable
          advance notice by email or through the Service before they take
          effect. Continued use of the Service after the effective date
          constitutes acceptance of the updated Terms.
        </P>
      </>
    ),
  },
  {
    id: "law",
    title: "Governing law and disputes",
    children: (
      <>
        {/* MANUAL LEGAL REVIEW FLAG (5): governing law/jurisdiction left
            UNCHANGED (India), tied to the sole-proprietor in §01.
            Re-review if the operating entity changes. */}
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
          {/* MANUAL LEGAL REVIEW FLAG (10): Refund Policy removed from the
              entire-agreement clause because the beta is free. Re-add if
              paid customers/charges exist. */}
          <li>
            <strong>Entire agreement.</strong> These Terms, together with
            our <PageLink href="/privacy">Privacy Policy</PageLink> and any{" "}
            <PageLink href="/dpa">DPA</PageLink> we enter into with you,
            are the entire agreement between you and us on their subject
            matter.
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
        {/* MANUAL LEGAL REVIEW: confirm legal@tracetxn.com is a correct,
            monitored inbox (used consistently across the legal pages). */}
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
      intro="The agreement between you, the business using TraceTxn, and us, the operator of TraceTxn. Written to be clear about what we promise, what we don't, and what each side is responsible for."
      lastUpdated="2026-07-25"
      effectiveDate="2026-07-25"
      sections={SECTIONS}
    />
  );
}
