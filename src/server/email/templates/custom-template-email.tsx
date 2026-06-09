import { Section, Text } from "@react-email/components";
import * as React from "react";

import { EmailFooter, EmailHeader, EmailLayout } from "../components";
import { COLOR, SPACE, typeStyle } from "../components/tokens";

/**
 * Stripped-down email shell for manually-dispatched custom templates.
 *
 * The order-flavoured `UniversalOrderEmail` is built around line
 * items, payment CTAs, and consent timers — too heavy for an
 * operator firing off "Payment reminder" or "Refund approved" by
 * hand. This component renders the brand header / footer plus the
 * tenant's editable copy (greeting + intro + optional note), nothing
 * else. Same typographic tokens so it sits beside the other
 * transactional templates without visual drift.
 */
export interface CustomTemplateEmailProps {
  brandName: string;
  /** Operator-facing kind label rendered as the eyebrow (e.g. "Payment Reminder"). */
  eyebrow: string;
  preview: string;
  greeting?: string | null;
  intro?: string | null;
  note?: string | null;
  supportEmail?: string | null;
  footerNote?: string | null;
}

export function CustomTemplateEmail({
  brandName,
  eyebrow,
  preview,
  greeting,
  intro,
  note,
  supportEmail,
  footerNote,
}: CustomTemplateEmailProps): React.ReactElement {
  return (
    <EmailLayout preview={preview}>
      <EmailHeader brandName={brandName} eyebrow={eyebrow} />

      <Section style={{ padding: `${SPACE.xl}px ${SPACE.xxxl}px` }}>
        {greeting ? (
          <Text
            style={{
              ...typeStyle("body"),
              margin: 0,
              color: COLOR.textPrimary,
              fontWeight: 600,
            }}
          >
            {greeting}
          </Text>
        ) : null}

        {intro ? (
          <Text
            style={{
              ...typeStyle("body"),
              margin: 0,
              marginTop: greeting ? SPACE.md : 0,
              color: COLOR.textPrimary,
              whiteSpace: "pre-wrap",
            }}
          >
            {intro}
          </Text>
        ) : null}

        {note ? (
          <Text
            style={{
              ...typeStyle("body"),
              margin: 0,
              marginTop: SPACE.lg,
              color: COLOR.textMuted,
              whiteSpace: "pre-wrap",
              borderLeft: `2px solid ${COLOR.border}`,
              paddingLeft: SPACE.md,
            }}
          >
            {note}
          </Text>
        ) : null}

        {footerNote ? (
          <Text
            style={{
              ...typeStyle("micro"),
              margin: 0,
              marginTop: SPACE.xl,
              color: COLOR.textMuted,
            }}
          >
            {footerNote}
          </Text>
        ) : null}
      </Section>

      <EmailFooter
        brandName={brandName}
        supportEmail={supportEmail ?? undefined}
      />
    </EmailLayout>
  );
}

export default CustomTemplateEmail;
