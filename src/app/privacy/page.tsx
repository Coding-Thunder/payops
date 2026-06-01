import type { Metadata } from "next";

import {
  H3,
  LegalDoc,
  Mail,
  Note,
  P,
  PageLink,
  UL,
  type LegalSection,
} from "@/components/marketing/legal-doc";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How TraceTxn collects, uses, shares, and protects personal information, including the sub-processors we rely on, how long we keep data, and your rights.",
  alternates: { canonical: "/privacy" },
};

const SECTIONS: LegalSection[] = [
  {
    id: "overview",
    title: "Overview",
    children: (
      <>
        <P>
          This Privacy Policy explains how Vinay Maheshwari, the
          sole-proprietor operating TraceTxn (&quot;TraceTxn&quot;,
          &quot;we&quot;, &quot;us&quot;), collects, uses, shares, and
          protects personal information when you (1) visit our website,
          (2) sign up for a workspace, or (3) use the TraceTxn platform
          (collectively, the &quot;Service&quot;).
        </P>
        <Note>
          <strong>Controller vs. processor.</strong> We act as a{" "}
          <em>data controller</em> for information about you, the
          operator who signed up for TraceTxn. We act as a{" "}
          <em>data processor</em> for information you handle through
          TraceTxn about your customers and end users. Your obligations
          to those people sit with you; ours sit with you under our{" "}
          <PageLink href="/dpa">Data Processing Addendum</PageLink>.
        </Note>
      </>
    ),
  },
  {
    id: "what-we-collect",
    title: "Information we collect",
    children: (
      <>
        <H3>Account information</H3>
        <P>
          When you sign up, we collect your name, email address, and
          workspace details (business name, country, currency
          preferences). We also store an authentication record from your
          chosen sign-in method (Google sign-in or email + password).
        </P>
        <H3>Workspace usage</H3>
        <P>
          As you use TraceTxn, we record activity needed to run the
          Service, orders you create, evidence events, audit-log
          entries, sub-processor jobs (e.g. emails queued for delivery),
          and feature interactions. This usage data is scoped to your
          workspace.
        </P>
        <H3>Payment processor metadata</H3>
        <P>
          When you connect Stripe, we store the credentials you provide
          (encrypted at rest), the Stripe account identifier, and event
          metadata returned by Stripe (session ids, charge ids, dispute
          ids, status timestamps). We never receive or store card
          numbers.
        </P>
        <H3>Billing information</H3>
        <P>
          When subscription billing is active, the payment instrument
          itself is handled by our subscription processor; we store only
          the billing email, last 4 digits, brand, country, and the
          processor&apos;s opaque customer identifier, never full card
          data.
        </P>
        <H3>Technical data</H3>
        <P>
          We collect device, browser, IP address, request timestamps,
          and rough geo-location (country/region) for security,
          fraud-prevention, and observability, including failed login
          attempts and bot-protection challenge results.
        </P>
        <H3>Cookies</H3>
        <P>
          We use a small number of essential cookies (session cookies,
          CSRF tokens, bot-protection tokens) needed to operate the
          Service. We do not use third-party advertising cookies or
          cross-site trackers.
        </P>
      </>
    ),
  },
  {
    id: "how-we-use",
    title: "How we use information",
    children: (
      <>
        <P>We use personal information to:</P>
        <UL>
          <li>provide, secure, and operate the Service;</li>
          <li>
            authenticate sign-in, maintain workspace membership, and
            apply role-based permissions;
          </li>
          <li>
            process subscription payments, send invoices, and meet
            tax/accounting obligations;
          </li>
          <li>
            send transactional email (sign-up confirmation, password
            reset, billing notices, security alerts), these are
            necessary for the Service and cannot be opted out of while
            your account is active;
          </li>
          <li>
            detect, investigate, and prevent fraud, abuse, and security
            incidents;
          </li>
          <li>
            comply with legal obligations and enforce our Terms of
            Service;
          </li>
          <li>
            improve the Service, primarily through aggregated metrics
            (latency, error rates, feature adoption) rather than
            individual profiling.
          </li>
        </UL>
      </>
    ),
  },
  {
    id: "legal-bases",
    title: "Legal bases (EU/UK)",
    children: (
      <>
        <P>
          Where the EU/UK GDPR applies, we rely on these lawful bases:
        </P>
        <UL>
          <li>
            <strong>Contract.</strong> To create your account, provide
            the Service, and process payments, without this, we cannot
            deliver what you signed up for.
          </li>
          <li>
            <strong>Legitimate interests.</strong> To secure the Service
            against abuse, run analytics for product improvement, and
            send transactional messages, balanced against your rights.
          </li>
          <li>
            <strong>Legal obligation.</strong> To meet tax, accounting,
            anti-fraud, and law-enforcement requirements.
          </li>
          <li>
            <strong>Consent.</strong> Where we ask separately (e.g.
            optional product update emails). You can withdraw consent at
            any time without affecting prior processing.
          </li>
        </UL>
      </>
    ),
  },
  {
    id: "sharing",
    title: "How we share information",
    children: (
      <>
        <P>
          We share personal information only as needed to provide the
          Service:
        </P>
        <UL>
          <li>
            <strong>Sub-processors</strong> (listed below), hosting,
            database, authentication, email delivery, payment
            processing, bot protection.
          </li>
          <li>
            <strong>Within your workspace</strong>, members of your
            workspace see data your role permits them to see. Workspace
            owners see all workspace data.
          </li>
          <li>
            <strong>Legal compliance</strong>, when required by law,
            valid legal process, or to protect rights, property, or
            safety.
          </li>
          <li>
            <strong>Business transfers</strong>, in connection with a
            merger, acquisition, or sale of assets, subject to the
            successor honouring this Policy.
          </li>
        </UL>
        <P>
          We do <strong>not</strong> sell personal information. We do
          not share personal information with advertising networks. We
          do not use personal information to train AI models.
        </P>
      </>
    ),
  },
  {
    id: "sub-processors",
    title: "Sub-processors",
    children: (
      <>
        <P>
          We rely on the following service providers (sub-processors) to
          run the Service. They process personal information only under
          our instructions and equivalent confidentiality and security
          obligations.
        </P>
        <div className="mb-4 overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-[13px]">
            <thead className="bg-[color:var(--background)] text-left font-display text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-semibold">Provider</th>
                <th className="px-4 py-3 font-semibold">Purpose</th>
                <th className="px-4 py-3 font-semibold">Location</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <tr>
                <td className="px-4 py-3 font-medium">DigitalOcean</td>
                <td className="px-4 py-3 text-muted-foreground">
                  Application hosting + compute
                </td>
                <td className="px-4 py-3 text-muted-foreground">United States / EU</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-medium">MongoDB Atlas</td>
                <td className="px-4 py-3 text-muted-foreground">
                  Primary database (workspace data, audit logs, evidence chain)
                </td>
                <td className="px-4 py-3 text-muted-foreground">United States / EU</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-medium">Google Firebase</td>
                <td className="px-4 py-3 text-muted-foreground">
                  Authentication (Google + email/password sign-in)
                </td>
                <td className="px-4 py-3 text-muted-foreground">United States</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-medium">Stripe</td>
                <td className="px-4 py-3 text-muted-foreground">
                  Subscription billing (TraceTxn fees), tenant payment
                  processing uses your own Stripe account
                </td>
                <td className="px-4 py-3 text-muted-foreground">United States / Ireland</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-medium">Google Workspace (SMTP)</td>
                <td className="px-4 py-3 text-muted-foreground">
                  Transactional email delivery
                </td>
                <td className="px-4 py-3 text-muted-foreground">United States</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-medium">Cloudflare</td>
                <td className="px-4 py-3 text-muted-foreground">
                  DNS, CDN, bot protection (Turnstile)
                </td>
                <td className="px-4 py-3 text-muted-foreground">Global</td>
              </tr>
            </tbody>
          </table>
        </div>
        <P>
          We notify customers of material sub-processor changes through
          this page and, where you have a signed DPA, via the
          notification channel set out in it.
        </P>
      </>
    ),
  },
  {
    id: "international",
    title: "International data transfers",
    children: (
      <>
        <P>
          The sub-processors above operate primarily in the United
          States, Ireland, and the European Union. When personal
          information is transferred from your region to another, we
          rely on appropriate safeguards (such as the EU Standard
          Contractual Clauses, where applicable) and require equivalent
          confidentiality and security obligations.
        </P>
      </>
    ),
  },
  {
    id: "retention",
    title: "How long we keep information",
    children: (
      <>
        <UL>
          <li>
            <strong>Account &amp; workspace data:</strong> retained
            while your account is active. After deletion, we may keep
            data for up to 30 days to allow recovery, then remove or
            irreversibly anonymise it (subject to legal retention).
          </li>
          <li>
            <strong>Audit logs &amp; evidence chain:</strong> retained
            for the lifetime of your workspace because tampering with
            this data would defeat its purpose. On deletion, we keep
            cryptographic chain anchors only.
          </li>
          <li>
            <strong>Billing records:</strong> retained for the period
            required by tax and accounting law in our operating
            jurisdiction.
          </li>
          <li>
            <strong>Security &amp; abuse-prevention logs:</strong> up to
            12 months, then deleted or rolled up to aggregates.
          </li>
          <li>
            <strong>Marketing / transactional email logs:</strong>{" "}
            delivery metadata kept up to 90 days for deliverability
            diagnostics.
          </li>
        </UL>
      </>
    ),
  },
  {
    id: "your-rights",
    title: "Your rights",
    children: (
      <>
        <P>
          Depending on where you live, you may have the right to access,
          correct, export, restrict processing of, or delete your
          personal information; to object to certain processing; and to
          lodge a complaint with your local data-protection authority.
        </P>
        <P>
          To exercise these rights for personal information we hold{" "}
          <em>about you as a TraceTxn operator</em>, email{" "}
          <Mail address="legal@tracetxn.com" /> from the email address
          associated with your workspace. We respond within 30 days.
        </P>
        <P>
          For requests about <em>your customers&apos;</em> personal
          information that we process on your behalf, please direct
          those requests to your workspace owner, they are the
          controller of that data.
        </P>
      </>
    ),
  },
  {
    id: "security",
    title: "Security",
    children: (
      <>
        <P>
          We use technical and organisational safeguards to protect
          personal information, encryption in transit, encryption at
          rest for credentials, scoped access controls, audit logging,
          tenant isolation at the data layer, and bot protection on
          public forms.
        </P>
        <P>
          No system is impenetrable. We commit to investigating and,
          where appropriate, notifying you of personal-data breaches
          without undue delay, in line with applicable law.
        </P>
        <P>
          More detail is on our{" "}
          <PageLink href="/security">Security page</PageLink>.
        </P>
      </>
    ),
  },
  {
    id: "children",
    title: "Children",
    children: (
      <>
        <P>
          The Service is intended for business use and not directed to
          children under 16. We do not knowingly collect personal
          information from children. If you believe a child has provided
          personal information to us, email{" "}
          <Mail address="legal@tracetxn.com" /> and we will delete it.
        </P>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes to this Policy",
    children: (
      <>
        <P>
          We may update this Privacy Policy. The &quot;Last
          updated&quot; date above reflects the current version.
          Material changes are announced by email at least 14 days
          before they take effect; continued use of the Service after
          the effective date constitutes acceptance.
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
          Questions about this Policy or our handling of personal
          information? Email <Mail address="legal@tracetxn.com" />.
        </P>
      </>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalDoc
      badge="Privacy"
      title="Privacy Policy"
      intro="What information we collect, how we use it, who we share it with, where it lives, how long we keep it, and the rights you have over it."
      lastUpdated="2026-05-31"
      effectiveDate="2026-05-31"
      sections={SECTIONS}
    />
  );
}
