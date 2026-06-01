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
  title: "Refund Policy",
  description:
    "14-day no-questions money-back guarantee on new TraceTxn subscriptions. Plain conditions, what's covered, what's not, and how to request.",
  alternates: { canonical: "/refunds" },
};

const SECTIONS: LegalSection[] = [
  {
    id: "summary",
    title: "The short version",
    children: (
      <>
        <P>
          We offer a <strong>14-day no-questions money-back
          guarantee</strong> on new paid TraceTxn subscriptions. If
          TraceTxn isn&apos;t a fit for you in the first 14 days, email{" "}
          <Mail address="billing@tracetxn.com" /> from your workspace
          email address and we&apos;ll refund the subscription fee in
          full. No survey, no save-attempt phone call, no friction.
        </P>
        <Note>
          The 14-day window starts the moment your first paid charge
          succeeds, not the moment you sign up. Trial usage before that
          charge doesn&apos;t count.
        </Note>
      </>
    ),
  },
  {
    id: "guarantee",
    title: "The 14-day guarantee",
    children: (
      <>
        <P>If, within 14 days of your first paid charge, you decide:</P>
        <UL>
          <li>TraceTxn doesn&apos;t fit how your team works,</li>
          <li>you found a better tool,</li>
          <li>you simply changed your mind,</li>
        </UL>
        <P>
          we&apos;ll refund 100% of the subscription fee you paid for
          that charge. You don&apos;t have to explain why. You don&apos;t
          have to schedule a call. You just have to ask within the
          window.
        </P>
      </>
    ),
  },
  {
    id: "how-to-request",
    title: "How to request a refund",
    children: (
      <>
        <P>
          Email <Mail address="billing@tracetxn.com" /> from the email
          associated with your workspace. Include:
        </P>
        <UL>
          <li>your workspace name (or slug),</li>
          <li>the date of the charge you&apos;d like refunded,</li>
          <li>
            optionally, a one-line reason, only if you want to. It
            helps us improve the product. It&apos;s not required.
          </li>
        </UL>
        <P>
          We acknowledge refund requests within one business day and
          issue the refund the same business day in most cases.
        </P>
      </>
    ),
  },
  {
    id: "what-covered",
    title: "What's covered",
    children: (
      <>
        <P>The 14-day guarantee covers:</P>
        <UL>
          <li>
            the most recent subscription charge from TraceTxn to you on
            a new paid subscription,
          </li>
          <li>
            full refund of that charge to the original payment method,
          </li>
          <li>
            taxes we collected on that charge (refunded to the same
            method, subject to processor limitations).
          </li>
        </UL>
      </>
    ),
  },
  {
    id: "what-not-covered",
    title: "What's NOT covered",
    children: (
      <>
        <P>The 14-day guarantee does not cover:</P>
        <UL>
          <li>
            <strong>Stripe processing fees</strong> on payments your
            customers made <em>to you</em> through your connected Stripe
            account. We never received that money, it went directly
            from your customer to your Stripe to your bank. Refunding it
            is between you and Stripe, not us.
          </li>
          <li>
            <strong>Renewal charges after day 14.</strong> If you cancel
            after the window closes, the cancellation takes effect at
            the end of the paid period, no pro-rata refund of the
            current period.
          </li>
          <li>
            <strong>Reactivated subscriptions.</strong> The guarantee
            applies to your <em>first</em> paid charge on a workspace.
            Reactivating an old workspace doesn&apos;t reset it.
          </li>
          <li>
            <strong>Add-ons.</strong> One-off charges (e.g. paid
            migration help, custom-branded evidence templates) are
            described separately and follow the terms of their own
            order.
          </li>
        </UL>
      </>
    ),
  },
  {
    id: "after-window",
    title: "After the 14-day window",
    children: (
      <>
        <P>
          You can cancel any subscription at any time through your
          billing settings. Cancellation:
        </P>
        <UL>
          <li>
            takes effect at the end of the period you&apos;ve already
            paid for;
          </li>
          <li>
            stops auto-renewal, you won&apos;t be charged again;
          </li>
          <li>
            preserves read-only access to your workspace data for at
            least 30 days after the period ends, so you can export.
          </li>
        </UL>
        <H3>Annual plans</H3>
        <P>
          The 14-day guarantee applies to annual plans the same way it
          applies to monthly plans, full refund within 14 days of the
          first charge. After day 14, annual plans run to the end of the
          paid year; we don&apos;t pro-rate annual refunds outside the
          guarantee window.
        </P>
        <H3>Tier changes</H3>
        <P>
          Upgrades take effect immediately; we charge the prorated
          difference. Downgrades take effect at the start of your next
          billing cycle, you keep the higher tier&apos;s features until
          then.
        </P>
      </>
    ),
  },
  {
    id: "exceptional",
    title: "Exceptional circumstances",
    children: (
      <>
        <P>
          If TraceTxn experiences a major outage or a billing error on
          our side, we may issue credits or refunds outside the
          guarantee window, case-by-case, in your favour. Email{" "}
          <Mail address="billing@tracetxn.com" /> with the details and
          we&apos;ll work it out quickly.
        </P>
        <P>
          If you suspect fraudulent charges (e.g. someone else used your
          card to sign up), email{" "}
          <Mail address="billing@tracetxn.com" /> immediately. We work
          with your card issuer to resolve and refund.
        </P>
      </>
    ),
  },
  {
    id: "context",
    title: "How this fits with our other policies",
    children: (
      <>
        <P>
          This Refund Policy is part of, and read together with, our{" "}
          <PageLink href="/terms">Terms of Service</PageLink> and{" "}
          <PageLink href="/privacy">Privacy Policy</PageLink>. Where
          this Policy and the Terms appear to conflict on the subject of
          refunds, this Policy prevails.
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
      intro="A 14-day no-questions money-back guarantee on new paid subscriptions. The plain version, plus the boring fine print so there are no surprises."
      lastUpdated="2026-05-31"
      effectiveDate="2026-05-31"
      sections={SECTIONS}
    />
  );
}
