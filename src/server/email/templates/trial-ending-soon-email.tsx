import { Button, Section, Text } from "@react-email/components";
import * as React from "react";

import { EmailFooter, EmailHeader, EmailLayout } from "../components";
import { COLOR, SPACE, typeStyle } from "../components/tokens";

/**
 * Sent once when a tenant's 15-day evaluation trial enters the
 * three-day warn window. The in-app banner shows the same signal,
 * the email is the proactive nudge so an inactive workspace owner
 * doesn't get surprised by an expired-trial gate.
 *
 * Tone: matter-of-fact, not panicky. The product still works through
 * the warn window, the only thing that changes at day 0 is that
 * order creation pauses, existing orders + evidence chains are
 * untouched. Operators can extend trials by replying.
 */
export interface TrialEndingSoonEmailProps {
  customerName: string;
  workspaceName: string;
  /** Whole days left until the trial expires. Clamped to [1, 3] by
   *  the caller, the template just renders whatever it receives. */
  daysRemaining: number;
  /** Absolute URL for the dashboard CTA. */
  dashboardUrl: string;
  /** Reply-To target on the SMTP layer (support@). Rendered as a
   *  visible address in the body so the customer can plain-text-
   *  forward the email and reach support without clicking. */
  supportEmail: string;
  /** earlyaccess@ — where extension requests should go. */
  extendEmail: string;
}

export function TrialEndingSoonEmail({
  customerName,
  workspaceName,
  daysRemaining,
  dashboardUrl,
  supportEmail,
  extendEmail,
}: TrialEndingSoonEmailProps): React.ReactElement {
  const dayWord = daysRemaining === 1 ? "day" : "days";
  const preview = `${daysRemaining} ${dayWord} left on your TraceTxn trial.`;
  return (
    <EmailLayout preview={preview}>
      <EmailHeader brandName="TraceTxn" eyebrow="Trial ending soon" />

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
          A heads-up before things go quiet, your{" "}
          <strong>{workspaceName}</strong> trial has{" "}
          <strong>
            {daysRemaining} {dayWord}
          </strong>{" "}
          left.
        </Text>

        <Text
          style={{
            ...typeStyle("body"),
            margin: 0,
            marginTop: SPACE.md,
            color: COLOR.textPrimary,
          }}
        >
          What happens at day 0:
        </Text>

        <ul
          style={{
            margin: 0,
            marginTop: SPACE.sm,
            paddingLeft: SPACE.xl,
            color: COLOR.textPrimary,
            fontSize: 14,
            lineHeight: "1.6",
          }}
        >
          <li>
            New order creation pauses inside the app.
          </li>
          <li>
            Existing orders, payment links, evidence chains, and audit
            logs stay fully intact and editable.
          </li>
          <li>
            Reply to this email or write to{" "}
            <a href={`mailto:${extendEmail}`} style={{ color: COLOR.textPrimary }}>
              {extendEmail}
            </a>{" "}
            and we&apos;ll extend the trial by hand, no card required.
          </li>
        </ul>

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
            ...typeStyle("micro"),
            margin: 0,
            marginTop: SPACE.xl,
            color: COLOR.textMuted,
          }}
        >
          If something about TraceTxn isn&apos;t clicking for you, hit
          reply and tell us what&apos;s missing. Brutally honest
          feedback is the best gift while we&apos;re still small.
        </Text>
      </Section>

      <EmailFooter brandName="TraceTxn" supportEmail={supportEmail} />
    </EmailLayout>
  );
}

export default TrialEndingSoonEmail;
