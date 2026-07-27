import { Button, Section, Text } from "@react-email/components";
import * as React from "react";

import { EmailFooter, EmailHeader, EmailLayout } from "../components";
import { COLOR, SPACE, typeStyle } from "../components/tokens";

/**
 * Platform-side team invitation. Sent FROM TraceTxn (the platform, via
 * EMAIL_FROM_ACCOUNTS) when a workspace owner adds a member. Carries the
 * single-use /join link the invitee uses to set their own password and join
 * the owner's existing workspace. The raw token lives only inside `joinUrl`.
 */
export interface TeamInviteEmailProps {
  /** The invited member's name (from the owner's "Add member" form). */
  inviteeName?: string;
  /** The workspace they're being invited to. */
  orgName: string;
  /** The owner/admin who sent the invitation. */
  inviterName: string;
  /** Human role label (e.g. "Admin" / "Staff"). */
  role: string;
  /** Absolute single-use /join URL (contains the raw token). */
  joinUrl: string;
  /** e.g. "7 days" — how long the link stays valid. */
  expiresLabel: string;
  /** Reply-to support address. */
  supportEmail: string;
}

export function TeamInviteEmail({
  inviteeName,
  orgName,
  inviterName,
  role,
  joinUrl,
  expiresLabel,
  supportEmail,
}: TeamInviteEmailProps): React.ReactElement {
  const preview = `${inviterName} invited you to join ${orgName} on TraceTxn.`;
  return (
    <EmailLayout preview={preview}>
      <EmailHeader brandName="TraceTxn" eyebrow="Team invitation" />

      <Section style={{ padding: `${SPACE.xl}px ${SPACE.xxxl}px` }}>
        <Text
          style={{
            ...typeStyle("body"),
            margin: 0,
            color: COLOR.textPrimary,
            fontWeight: 600,
          }}
        >
          Hi {inviteeName?.trim() || "there"},
        </Text>

        <Text
          style={{
            ...typeStyle("body"),
            margin: 0,
            marginTop: SPACE.md,
            color: COLOR.textPrimary,
          }}
        >
          <strong>{inviterName}</strong> invited you to join{" "}
          <strong>{orgName}</strong> on TraceTxn as <strong>{role}</strong>. Set
          your password to get started.
        </Text>

        <Section style={{ marginTop: SPACE.xl }}>
          <Button
            href={joinUrl}
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
            Accept invitation
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
          This link is single-use and expires in {expiresLabel}. If you
          weren&apos;t expecting this invitation, you can safely ignore this
          email — no account is created until you set a password.
        </Text>
      </Section>

      <EmailFooter brandName="TraceTxn" supportEmail={supportEmail} />
    </EmailLayout>
  );
}

export default TeamInviteEmail;
