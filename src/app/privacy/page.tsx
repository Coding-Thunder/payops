import type { Metadata } from "next";

import {
  ExternalLink,
  H3,
  LegalDoc,
  Mail,
  Note,
  P,
  PageLink,
  UL,
  type LegalSection,
} from "@/components/marketing/legal-doc";

import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Privacy Policy",
  description: "How TraceTxn collects, uses, shares, and protects personal information, including the sub-processors we rely on, how long we keep data, and your rights.",
  path: "/privacy",
});

/* ════════════════════════════════════════════════════════════════════════
 * ⚠️  MANUAL LEGAL-REVIEW FLAGS — resolve before publishing.
 *
 * This policy was rewritten to match the client-record product. The
 * statements below are grounded in the current codebase, but the
 * following facts could not be verified from code alone and MUST be
 * confirmed (or corrected) by the operator/legal reviewer. These are
 * developer comments only — they do NOT render on the public page.
 *
 *  1. LEGAL ENTITY — Overview still names "Vinay Maheshwari, the
 *     sole-proprietor operating TraceTxn". Left UNCHANGED per brief.
 *     Confirm this is the correct current legal operator.
 *  2. ACCOUNT FIELDS — Verified from user/organization models: name,
 *     email, hashed password / Firebase UID, workspace name, optional
 *     legal business name. The old policy's "country" and "currency
 *     preferences" were dropped (no such fields on signup; currency is a
 *     per-workspace setting). Confirm nothing else is collected at signup.
 *  3. CONSENT METADATA — Confirmed collected today: acknowledgement text,
 *     client name + email, order snapshot (amount/currency), timestamp,
 *     typed signed name, IP address, browser user-agent
 *     (payment-consent.model.ts + consent-form.tsx). Consent is currently
 *     tied to an order/booking → Stripe checkout. Confirm this scope.
 *  4. FILE STORAGE — There is NO arbitrary file/document upload in the
 *     product. The ONLY user upload is a workspace logo image (≤512 KB),
 *     stored as bytes inside MongoDB (no S3/Spaces/R2/GCS/Firebase
 *     Storage/GridFS). "Documents" = system-GENERATED invoices/receipts
 *     (HTML). The policy therefore does NOT claim clients can attach
 *     contracts/agreements/deliverables. If file attachments ship later,
 *     add a file-storage subprocessor and expand §02/§06/§08.
 *  5. SUBPROCESSORS — Verified in use: DigitalOcean (hosting), MongoDB
 *     Atlas (DB + logo bytes), Google Firebase (AUTH ONLY — not storage),
 *     Cloudflare (Turnstile/DNS/CDN), Stripe (OPTIONAL per-tenant gateway
 *     only). EMAIL PROVIDER IS AMBIGUOUS: .env.example documents Resend
 *     (outbound) + Zoho (inbound mailbox); .env.prod still contains a
 *     legacy Google Workspace / smtp.gmail.com block alongside a
 *     smtp.resend.com block. The table lists "Resend" — CONFIRM the live
 *     outbound provider and whether Zoho (inbound) should be listed.
 *  6. DATA LOCATIONS — The prior "United States / EU" over-claim was
 *     removed; the table now reads "United States" for DigitalOcean and
 *     MongoDB Atlas. Code supports a SINGLE US region (.do/app.yaml pins
 *     region: nyc; security page = single-region + daily Atlas
 *     snapshots). Still CONFIRM the exact DigitalOcean region, the Atlas
 *     cluster region(s), and each other provider's region before
 *     publishing.
 *  7. INTERNATIONAL TRANSFERS — "SCCs where applicable" is hedged, not
 *     asserted. Confirm which transfer mechanisms actually apply.
 *  8. RETENTION PERIODS — Code-backed: email delivery metadata = 90 days
 *     (enforced); security signals = up to 12 months (mostly not
 *     persisted); account/workspace/client/audit data = lifetime of
 *     workspace, no automated purge. Confirm these are the intended
 *     policy periods. NOTE: audit logs have no auto-purge but CAN be
 *     hard-deleted by an admin holding the AUDIT_DELETE permission (each
 *     deletion itself logged) — the §08 wording was corrected to drop any
 *     immutability implication; the append-only SHA-256 chain belongs to
 *     the separate order-evidence collection, not the audit log.
 *  9. DELETION / ERASURE WINDOW — Workspaces are ARCHIVED (soft delete);
 *     "hard-delete is not supported" in code. No wired flow currently
 *     transitions an org into ARCHIVED, there is no self-serve
 *     account-deletion UI, and no timed purge job. The old policy's "up to
 *     30 days then delete" claim was REMOVED as unverified, and §08 now
 *     frames workspace closure as request-based. Define and confirm the
 *     actual erasure process + window (e.g. on request).
 * 10. BACKUP DELETION WINDOW — Daily Atlas snapshots exist; the retention
 *     window of those snapshots (how long deleted data lingers in
 *     backups) is unknown. Confirm and insert if a specific window is
 *     promised.
 * 11. STRIPE / SUBSCRIPTION BILLING — Confirmed: TraceTxn's OWN
 *     subscription billing is NOT live ("Stripe Billing is not wired
 *     up"); 15-day free evaluation, no card required. The per-tenant
 *     Stripe gateway (BYOS) IS live. §02 describes TraceTxn as a "free
 *     private beta" — the sanctioned positioning used on the home/hero
 *     and footers. KNOWN INCONSISTENCY (flag for reconciliation, not a
 *     policy error): /pricing and /waitlist still advertise paid tiers
 *     ($39/$99/$249) even though billing is not wired up. Do not assert
 *     live paid plans anywhere until that is reconciled.
 * 12. AI / ANALYTICS — NO AI/LLM integration. Third-party analytics is
 *     now DISCLOSED (§ "Website analytics"): Microsoft Clarity, scoped to
 *     the public marketing routes in `@/lib/analytics/clarity`, never on
 *     auth / payment / consent / /app/** / /admin/**. The disclosure is
 *     written to stay true whether or not the tag is switched on, so it
 *     does not need editing at activation time.
 *
 *     ⚠️  ACTIVATION IS GATED — NEEDS-LEGAL-REVIEW. Clarity is DORMANT:
 *     NEXT_PUBLIC_CLARITY_PROJECT_ID is unset in production, so no script
 *     loads and nothing is collected. Two questions are unresolved and are
 *     NOT settled by this page:
 *       (a) Clarity Terms of Use v5 §1(b)(ii) — "You will not use the
 *           Offering in connection with content which may contain
 *           sensitive user materials, such as health care, financial
 *           services or government-related information." The phrase is
 *           undefined and Microsoft publishes no guidance on whether a
 *           marketing-pages-only deployment falls inside it.
 *       (b) EEA/UK/CH consent. ToU §4.4(d) requires obtaining consent for
 *           cookies/local storage, retaining records of it, and offering
 *           revocation. There is NO consent-management mechanism in this
 *           codebase. Clarity's own Consent Mode suppresses EU cookies by
 *           default but does NOT discharge §4.4(d), and Microsoft states
 *           the tag "loads immediately, that is before your user can
 *           indicate whether they consent to your use of cookies."
 *     Do not set the env var until both are resolved. See README
 *     "Microsoft Clarity" for the full activation checklist.
 * 13. CHANGE NOTICE PERIOD — The prior "at least 14 days" commitment was
 *     softened (see §12). Restore a specific period only if TraceTxn
 *     intends to honour it.
 * 14. EFFECTIVE DATE — Set to 2026-07-25. Adjust per your material-change
 *     notice process before publishing.
 * 15. CONTACT — Confirm legal@tracetxn.com is the correct, monitored
 *     legal/privacy inbox.
 * ════════════════════════════════════════════════════════════════════════ */

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
          (collectively, the &quot;Service&quot;). TraceTxn is a
          client-record management tool used by agencies and freelancers
          to keep records about the clients they work with.
        </P>
        <P>
          <strong>Who&apos;s who.</strong> In this Policy, &quot;you&quot;,
          the &quot;User&quot;, &quot;Customer&quot;, or &quot;Workspace
          Owner&quot; means the person or business that creates and uses a
          TraceTxn account. A &quot;Client&quot; or &quot;Client
          Contact&quot; means one of your own customers or contacts whose
          information you choose to store in TraceTxn. We say
          &quot;Client&quot; for your customers so the two roles never
          blur.
        </P>
        <Note>
          <strong>Controller vs. processor.</strong> We act as a{" "}
          <em>data controller</em> for information about you, the User /
          Workspace Owner who signs up for and uses TraceTxn. We act as a{" "}
          <em>data processor</em> for the personal information you add to
          TraceTxn about your Clients and Client Contacts, there, you are
          the controller and we process it on your instructions under our{" "}
          <PageLink href="/dpa">Data Processing Addendum</PageLink>. Your
          obligations to your Clients sit with you.
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
          When you sign up, we collect your name and email address, and we
          store an authentication record for your chosen sign-in method
          (Google sign-in, or email + password, where passwords are stored
          only as a salted hash). We also collect your workspace details,
          your workspace / business name and, optionally, a legal business
          name used on the invoices you issue. You may upload a workspace
          logo image, which appears on your invoices and hosted pages, it
          is the only file TraceTxn currently lets you upload.
        </P>

        <H3>Client record data</H3>
        <P>
          The core of the Service is a record for each of your Clients.
          Depending on what you choose to add, a client record may include:
        </P>
        <UL>
          <li>client / contact name;</li>
          <li>email address;</li>
          <li>phone number;</li>
          <li>business or company name;</li>
          <li>free-form notes;</li>
          <li>labels or tags you apply;</li>
          <li>invoices and receipts you issue to that Client;</li>
          <li>
            payment records (amounts, currency, status, and timestamps of
            the orders you track for that Client);
          </li>
          <li>consent records (described below);</li>
          <li>a timeline of activity recorded on the record.</li>
        </UL>
        <P>
          TraceTxn does not require most of this information, what we
          actually process about a Client depends entirely on what you
          choose to add. You are responsible for having a lawful basis to
          store information about your Clients in TraceTxn.
        </P>

        <H3>Consent records</H3>
        <P>
          TraceTxn can capture a Client&apos;s acknowledgement of an order
          or booking before payment (a &quot;consent record&quot;).
          Depending on the flow, a consent record may include the
          acknowledgement text the Client was shown, the Client&apos;s name
          and email, the related order details (such as amount and
          currency), and a timestamp. When a Client confirms on the hosted
          consent page, we also record their typed signature (their full
          name), IP address, and browser user-agent as evidence of the
          acknowledgement.
        </P>
        <Note>
          <strong>Product consent is not privacy-law consent.</strong> A
          consent record is something <em>you</em> keep about your Client
          for your own purposes. It is not the Client&apos;s agreement to
          this Privacy Policy, and it does not, on its own, establish a
          lawful basis under data-protection law for you or for us. The two
          are separate concepts.
        </Note>

        <H3>Documents (invoices and receipts)</H3>
        <P>
          When you issue an invoice or receipt, TraceTxn generates it from
          the order and Client details you entered and stores a rendered
          copy so the exact document you issued can be reproduced later.
          These documents may contain personal information about your
          Client, such as their name, email, phone number, and the line
          items on the order. TraceTxn does not currently support uploading
          or attaching arbitrary files (for example contracts, proposals,
          or deliverables) to a client record.
        </P>

        <H3>Workspace usage</H3>
        <P>
          As you use TraceTxn, we record activity needed to run the
          Service, client records and documents you create, consent
          activity, timeline entries, audit-log events, and queued
          transactional emails. This usage data is scoped to your
          workspace.
        </P>

        <H3>Third-party integrations</H3>
        <P>
          You can optionally connect your own Stripe account so you can
          collect payments from your Clients. When you connect Stripe, we
          store the API credentials you provide (the secret key and
          webhook-signing secret are encrypted at rest; the publishable key
          and Stripe account identifier are stored as provided), and we
          receive and store metadata Stripe returns about payments, such as
          checkout-session, charge, and dispute identifiers and status
          timestamps. We never receive or store card numbers, Stripe
          handles card data directly.
        </P>

        <H3>Billing information</H3>
        <P>
          TraceTxn is currently a free private beta. We are not charging
          subscription fees today, and we do not collect payment-card
          details for TraceTxn itself, new workspaces get a time-limited
          evaluation with no credit card required. If we begin charging
          subscription fees in the future, we will update this Policy
          first.
        </P>

        <H3>Technical data</H3>
        <P>
          We collect device and browser information, IP address, and
          request timestamps for security, fraud-prevention, and
          reliability, including records of security-relevant events such
          as failed sign-in attempts. Public forms are protected by a
          bot-protection check (Cloudflare Turnstile); we do not keep a
          record of each challenge result.
        </P>

        <H3>Cookies</H3>
        <P>
          We use a single essential first-party cookie to keep you signed
          in (a session cookie that holds your authentication token). We
          rely on strict same-site and origin checks rather than a separate
          anti-CSRF cookie. Our bot-protection provider (Cloudflare) may
          set its own cookies when its challenge widget loads.
        </P>
        <P>
          The signed-in application sets no advertising or cross-site
          tracking cookies. On our public marketing pages, where website
          analytics is enabled, Microsoft Clarity sets its own first-party
          and third-party cookies, including identifiers Microsoft also
          uses for advertising. See{" "}
          <PageLink href="#website-analytics">Website analytics</PageLink>{" "}
          below for what that involves.
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
            create and maintain your workspace, and store, search, and
            display your client records;
          </li>
          <li>generate and store the invoices and receipts you issue;</li>
          <li>
            record and display the client acknowledgements (consent
            records) you request;
          </li>
          <li>
            maintain a timeline and audit log of workspace activity;
          </li>
          <li>
            authenticate sign-in, maintain workspace membership, and apply
            role-based permissions;
          </li>
          <li>
            where you connect Stripe, let you collect payments from your
            Clients;
          </li>
          <li>
            send transactional email (sign-up confirmation, password reset,
            security alerts, and workspace notifications), these are
            necessary for the Service and cannot be opted out of while your
            account is active;
          </li>
          <li>
            detect, investigate, and prevent fraud, abuse, and security
            incidents;
          </li>
          <li>
            comply with legal obligations and enforce our Terms of Service;
          </li>
          <li>
            improve the reliability and functionality of the Service,
            primarily through aggregated, workspace-scoped metrics rather
            than individual profiling.
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
          Where the EU/UK GDPR applies, we rely on these lawful bases for
          the personal information we hold as a controller (about you, the
          User):
        </P>
        <UL>
          <li>
            <strong>Contract.</strong> To create your account, provide the
            Service, and maintain your workspace and records, without this,
            we cannot deliver what you signed up for.
          </li>
          <li>
            <strong>Legitimate interests.</strong> To secure the Service
            against abuse, keep it reliable, and send transactional
            messages, balanced against your rights.
          </li>
          <li>
            <strong>Legal obligation.</strong> To meet legal, tax,
            anti-fraud, and law-enforcement requirements.
          </li>
          <li>
            <strong>Consent.</strong> Where we ask separately (e.g.
            optional product-update emails). You can withdraw consent at
            any time without affecting prior processing.
          </li>
        </UL>
        <Note>
          <strong>Client data.</strong> For the personal information you
          store about your Clients, <em>you</em> are the controller and
          decide the purposes and the lawful basis, we process it on your
          behalf under our{" "}
          <PageLink href="/dpa">Data Processing Addendum</PageLink>. Keeping
          a consent record about a Client does not, by itself, give you or
          us a lawful basis for processing, that remains your
          responsibility.
        </Note>
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
            database, authentication, email delivery, payment integration,
            and bot protection.
          </li>
          <li>
            <strong>Within your workspace</strong>, members of your
            workspace see data their role permits them to see. Workspace
            owners see all workspace data.
          </li>
          <li>
            <strong>Legal compliance</strong>, when required by law, valid
            legal process, or to protect rights, property, or safety.
          </li>
          <li>
            <strong>Business transfers</strong>, in connection with a
            merger, acquisition, or sale of assets, subject to the
            successor honouring this Policy.
          </li>
        </UL>
        <P>
          We do <strong>not</strong> sell personal information. We do not
          send your data to any AI provider, and we do not use personal
          information to train AI or machine-learning models.
        </P>
        <P>
          One exception applies to our public marketing pages only. Where
          website analytics is enabled there, Microsoft receives
          information about visits to those pages and may use it for its
          own purposes, including advertising. That processing is
          described in{" "}
          <PageLink href="#website-analytics">Website analytics</PageLink>.
          It does not apply to the signed-in application, to Client Data,
          or to payment and consent pages.
        </P>
      </>
    ),
  },
  {
    id: "website-analytics",
    title: "Website analytics",
    children: (
      <>
        <P>
          Third parties such as Microsoft may collect personal information
          from visitors to our public website. Where website analytics is
          enabled, we use <strong>Microsoft Clarity</strong> to understand
          how people use our public marketing pages, which pages are
          viewed, where visitors click and scroll, and replays of those
          page visits.
        </P>

        <H3>Where it runs, and where it does not</H3>
        <P>
          Clarity runs on our public marketing pages only. It is not
          loaded on sign-in, sign-up, password reset, invitation or
          activation pages, on payment or consent pages, in the signed-in
          application, or in the administration console. Form fields on
          the pages where it does run are masked before anything is sent,
          so what you type into them is not transmitted to Microsoft. We
          do not send Microsoft a user identifier, an email address, a
          name, or any custom identifier or event of our own.
        </P>

        <H3>Microsoft&apos;s role and Microsoft Advertising</H3>
        <P>
          Microsoft collects or receives personal information from us to
          provide <strong>Microsoft Advertising</strong>, and may use it
          for its own purposes, including creating user profiles for
          advertising. Microsoft&apos;s handling of that information is
          governed by the{" "}
          <ExternalLink href="https://privacy.microsoft.com/en-us/privacystatement">
            Microsoft Privacy Statement
          </ExternalLink>
          .
        </P>
        <Note>
          For this processing, Microsoft and TraceTxn each act as an{" "}
          <strong>independent controller</strong>. Microsoft is not acting
          as our processor, service provider, or sub-processor, and it is
          not listed in the sub-processor table below. We do not direct or
          control what Microsoft does with the information it collects
          through Clarity, and we cannot delete an individual
          visitor&apos;s Clarity data on request, Microsoft retains and
          deletes it on its own schedule. Requests about that information
          should be directed to Microsoft using the Microsoft Privacy
          Statement linked above.
        </Note>

        <H3>Opting out</H3>
        <P>
          You can prevent Clarity from loading by blocking{" "}
          <code className="font-mono text-[12.5px]">clarity.ms</code> in
          your browser or an extension, or by using a browser setting that
          blocks third-party cookies. Blocking it does not affect your use
          of the marketing pages or the application.
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
          run the Service. They process personal information only under our
          instructions and equivalent confidentiality and security
          obligations. Microsoft Clarity is deliberately not in this table,
          it is not a sub-processor, see{" "}
          <PageLink href="#website-analytics">Website analytics</PageLink>{" "}
          above.
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
                <td className="px-4 py-3 text-muted-foreground">United States</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-medium">MongoDB Atlas</td>
                <td className="px-4 py-3 text-muted-foreground">
                  Primary database (account, client records, invoices and
                  receipts, consent records, audit logs, uploaded logo
                  images)
                </td>
                <td className="px-4 py-3 text-muted-foreground">United States</td>
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
                  Optional payment integration, when you connect your own
                  Stripe account, it processes payments from your Clients
                  (not used for TraceTxn subscription billing)
                </td>
                <td className="px-4 py-3 text-muted-foreground">United States / Ireland</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-medium">Resend</td>
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
          this page and, where you have a signed DPA, via the notification
          channel set out in it.
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
          The sub-processors above operate primarily in the United States
          (Stripe also operates in Ireland, and Cloudflare operates
          globally). When personal information is transferred from your
          region to another, we rely on appropriate safeguards (such as the
          EU Standard Contractual Clauses, where applicable) and require
          equivalent confidentiality and security obligations.
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
            <strong>Account &amp; workspace data:</strong> retained while
            your workspace is active. If you ask us to close your
            workspace, we archive it rather than erasing it immediately, so
            records and history remain recoverable and any legal or tax
            obligations can be met.
          </li>
          <li>
            <strong>Client records, invoices &amp; receipts, and consent
            records:</strong> kept for as long as your workspace keeps
            them or until you delete them. Deleting a client record removes
            it from your workspace. Issued invoices and receipts are kept
            for as long as needed for accounting and tax purposes.
          </li>
          <li>
            <strong>Audit &amp; activity logs:</strong> retained for the
            lifetime of your workspace and not automatically purged.
          </li>
          <li>
            <strong>Email delivery metadata:</strong> kept up to 90 days
            for deliverability diagnostics, then deleted.
          </li>
          <li>
            <strong>Security &amp; abuse-prevention signals:</strong> most
            are not stored separately by us, failed sign-ins live in our
            authentication provider&apos;s logs, and rate-limit counters
            are transient. Where we do persist a security signal, it is
            kept up to 12 months and then deleted or rolled up to
            aggregates.
          </li>
          <li>
            <strong>Backups:</strong> our database provider takes routine
            snapshots for disaster recovery. Information you delete may
            persist in those backups for a limited period until they roll
            over.
          </li>
        </UL>
        <Note>
          <strong>&quot;One permanent record&quot; does not mean
          forever.</strong> Keeping a permanent, searchable record for
          every Client means your Client history stays in one place while
          you use TraceTxn, it does not mean we keep personal data
          indefinitely. Your and your Clients&apos; deletion rights,
          workspace closure, and applicable privacy laws all still apply.
        </Note>
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
          correct, export, restrict processing of, or delete your personal
          information; to object to certain processing; and to lodge a
          complaint with your local data-protection authority.
        </P>
        <P>
          To exercise these rights for personal information we hold{" "}
          <em>about you as a TraceTxn User</em>, email{" "}
          <Mail address="legal@tracetxn.com" /> from the email address
          associated with your workspace. We respond within 30 days.
        </P>
        <P>
          For requests about a <em>Client&apos;s</em> personal information
          that we process on a User&apos;s behalf, we act as a processor on
          the instructions of the relevant Workspace Owner, who is the
          controller of that data. We will refer such requests to that
          Workspace Owner, Clients should contact the agency or freelancer
          that holds their record.
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
          personal information, including encryption in transit, encryption
          at rest for connected payment-gateway credentials (AES-256
          envelope encryption), authentication and role-based access
          controls, audit logging, tenant / workspace isolation at the data
          layer, and bot protection on public forms.
        </P>
        <P>
          No system is impenetrable. We commit to investigating and, where
          appropriate, notifying you of personal-data breaches without
          undue delay, in line with applicable law.
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
          We may update this Privacy Policy. The &quot;Last updated&quot;
          date above reflects the current version. We announce material
          changes by email and/or in-product notice before they take
          effect; continued use of the Service after the effective date
          constitutes acceptance.
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
      lastUpdated="2026-07-25"
      effectiveDate="2026-07-25"
      sections={SECTIONS}
    />
  );
}
