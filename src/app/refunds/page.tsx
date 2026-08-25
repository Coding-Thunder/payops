import type { Metadata } from "next";

import {
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
  title: "Refund Policy",
  description: "TraceTxn is currently a free private beta with no subscription charges, so there are no subscription refunds today. This policy updates when paid plans launch.",
  path: "/refunds",
});

/**
 * Beta-stage Refund Policy. TraceTxn is a free private beta today:
 * no subscription charges, no SaaS billing wired up (see
 * billing.service.ts), so there is nothing to refund. This page
 * describes today's product only and defers all paid-plan refund
 * terms to a later revision. Do NOT add refund rules, prices, plan
 * names, or cancellation periods here until paid subscriptions
 * actually ship.
 */

const SECTIONS: LegalSection[] = [
  {
    id: "beta",
    title: "Private beta",
    children: (
      <>
        <P>
          TraceTxn is currently available as a free private beta. There
          is no charge to join and no charge to use it during the beta,
          and no credit card is required.
        </P>
        <P>
          Because the beta is free and there are currently no
          subscription charges, there are currently no subscription
          refunds. There is nothing to refund while there is nothing to
          pay for.
        </P>
      </>
    ),
  },
  {
    id: "future-subscriptions",
    title: "Future subscriptions",
    children: (
      <>
        <P>
          We plan to introduce paid subscriptions in the future. They
          are not available today.
        </P>
        <P>
          When paid subscriptions become available, we will update this
          Refund Policy to explain how they work, including:
        </P>
        <UL>
          <li>billing,</li>
          <li>cancellations,</li>
          <li>refunds,</li>
          <li>eligibility,</li>
          <li>payment terms.</li>
        </UL>
        <P>
          Until paid subscriptions launch, this policy does not set any
          prices, plans, or refund terms. Any refund rules for paid
          plans will be published here when those plans exist.
        </P>
      </>
    ),
  },
  {
    id: "billing",
    title: "Billing",
    children: (
      <>
        <P>
          During the private beta, TraceTxn does not collect any payment
          or card details from you in order to use the product. There is
          no subscription to pay for, so there is nothing to bill.
        </P>
        <Note>
          This policy covers amounts TraceTxn would charge you for the
          product. It does not cover money you collect from your own
          customers. If you connect your own payment processor to take
          payments from your customers, those funds move between you,
          your customers, and that processor, TraceTxn never holds them.
          Refunds to your customers are handled through your own
          processor, not through TraceTxn. See our{" "}
          <PageLink href="/terms">Terms of Service</PageLink> for how
          connected payment processors work.
        </Note>
      </>
    ),
  },
  {
    id: "cancellation",
    title: "Cancellation",
    children: (
      <>
        <P>
          You can stop using the private beta at any time. Because the
          beta is free, there is nothing to cancel and no charges to
          stop.
        </P>
        <P>
          If you would like the personal information we hold about you
          deleted, or a copy of it, you can request that as described in
          our <PageLink href="/privacy">Privacy Policy</PageLink>.
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
          Questions about this Refund Policy? Email{" "}
          <Mail address="legal@tracetxn.com" />.
        </P>
      </>
    ),
  },
];

export default function RefundsPage() {
  return (
    <LegalDoc
      badge="Refunds"
      title="Refund Policy"
      intro="Information about refunds, billing, and future paid subscriptions."
      lastUpdated="2026-07-25"
      effectiveDate="2026-07-25"
      sections={SECTIONS}
    />
  );
}
