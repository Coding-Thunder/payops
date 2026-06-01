import { Button, Section, Text } from "@react-email/components";
import * as React from "react";

import { EmailFooter, EmailHeader, EmailLayout } from "../components";
import { COLOR, SPACE, typeStyle } from "../components/tokens";

/**
 * Platform-side welcome email sent the moment a new workspace lands
 * via /signup or the Firebase exchange. Distinct from the tenant-side
 * confirmation emails — this one is FROM TraceTxn (the platform),
 * not from the tenant's brand.
 *
 * Three jobs:
 *   1. Confirm the workspace exists and tell them the trial clock started
 *   2. Point at the first three things to do (connect Stripe, define
 *      what they sell, run a real order)
 *   3. Leave a low-friction reply path so their first follow-up question
 *      lands in our inbox without them hunting for it
 */
export interface WelcomeEmailProps {
  /** Workspace owner's name from the signup form. */
  customerName: string;
  /** Workspace display name they picked at signup. Surfaces in the
   *  greeting so the email feels personal even when "name" is just an
   *  email-handle. */
  workspaceName: string;
  /** Absolute URL for the dashboard CTA. */
  dashboardUrl: string;
  /** Replies route here. Kept distinct from the From in the SMTP layer
   *  so the human can hit reply and reach support, not the no-reply
   *  account mailbox. */
  supportEmail: string;
}

export function WelcomeEmail({
  customerName,
  workspaceName,
  dashboardUrl,
  supportEmail,
}: WelcomeEmailProps): React.ReactElement {
  const preview = `Welcome to TraceTxn, your 15-day trial just started.`;
  return (
    <EmailLayout preview={preview}>
      <EmailHeader brandName="TraceTxn" eyebrow="Welcome" />

      <Section style={{ padding: `${SPACE.xl}px ${SPACE.xxxl}px` }}>
        <Text
          style={{
            ...typeStyle("body"),
            margin: 0,
            color: COLOR.textPrimary,
            fontWeight: 600,
          }}
        >
          Hi {customerName},
        </Text>

        <Text
          style={{
            ...typeStyle("body"),
            margin: 0,
            marginTop: SPACE.md,
            color: COLOR.textPrimary,
          }}
        >
          Your <strong>{workspaceName}</strong> workspace is live. The
          15-day evaluation trial starts today, no card on file, every
          part of TraceTxn unlocked.
        </Text>

        <Text
          style={{
            ...typeStyle("body"),
            margin: 0,
            marginTop: SPACE.md,
            color: COLOR.textPrimary,
          }}
        >
          Three quick wins to get you running before the day ends:
        </Text>

        <ol
          style={{
            margin: 0,
            marginTop: SPACE.md,
            paddingLeft: SPACE.xl,
            color: COLOR.textPrimary,
            fontSize: 14,
            lineHeight: "1.6",
          }}
        >
          <li>
            <strong>Connect Stripe.</strong> Paste your secret key once,
            we register the webhook on your account and store the
            signing secret encrypted.
          </li>
          <li>
            <strong>Define what you sell.</strong> One item type or one
            catalog row, your first order flow needs something to point
            at.
          </li>
          <li>
            <strong>Send your first payment request.</strong> Composer
            generates the Stripe link, hosted consent captures the
            customer&apos;s acknowledgement, the evidence chain starts
            writing from the first transition.
          </li>
        </ol>

        <Section style={{ marginTop: SPACE.xl }}>
          <Button
            href={dashboardUrl}
            style={{
              background: COLOR.textPrimary,
              color: "#FFFFFF",
              padding: `12px 22px`,
              borderRadius: 6,
              fontSize: 14,
              fontWeight: 600,
              textDecoration: "none",
              display: "inline-block",
            }}
          >
            Open your workspace
          </Button>
        </Section>

        <Text
          style={{
            ...typeStyle("body"),
            margin: 0,
            marginTop: SPACE.xl,
            color: COLOR.textMuted,
            borderLeft: `2px solid ${COLOR.border}`,
            paddingLeft: SPACE.md,
          }}
        >
          Reply to this email if anything is unclear or if something
          looks broken, the address routes to a human who builds the
          product. We answer fast while we&apos;re small.
        </Text>

        <Text
          style={{
            ...typeStyle("micro"),
            margin: 0,
            marginTop: SPACE.xl,
            color: COLOR.textMuted,
          }}
        >
          Trial ends in 15 days. We&apos;ll send one heads-up email
          three days before; nothing surprises you.
        </Text>
      </Section>

      <EmailFooter brandName="TraceTxn" supportEmail={supportEmail} />
    </EmailLayout>
  );
}

export default WelcomeEmail;
