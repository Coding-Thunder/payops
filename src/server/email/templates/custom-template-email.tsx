import { Section, Text } from "@react-email/components";
import * as React from "react";

import { EmailFooter, EmailHeader, EmailLayout } from "../components";
import { COLOR, SPACE, typeStyle } from "../components/tokens";
import { renderEmailBody, linkifyText } from "../rich-text";

/**
 * The shell every operator-written email renders through — custom
 * templates from the template editor, and one-off messages from the
 * client composer.
 *
 * The order-flavoured `UniversalOrderEmail` is built around line items,
 * payment CTAs, and consent timers. That's the right frame for a payment
 * request and the wrong one for "here's this week's update", which is
 * why a custom template gets this shell instead: brand header, the
 * operator's words, an optional resources block, footer.
 *
 * `body` is the modern path — the whole message as written. `greeting` /
 * `intro` / `note` are the legacy slot fields and still render when a
 * template was saved before `body` existed, so nothing already in the
 * database changes shape.
 */
export interface CustomTemplateEmailProps {
  brandName: string;
  /** Operator-facing kind label rendered as the eyebrow (e.g. "Project Update"). */
  eyebrow: string;
  preview: string;
  /** The written message, variables already resolved. */
  body?: string | null;
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
  body,
  greeting,
  intro,
  note,
  supportEmail,
  footerNote,
}: CustomTemplateEmailProps): React.ReactElement {
  const hasBody = Boolean(body && body.trim());

  return (
    <EmailLayout preview={preview}>
      <EmailHeader brandName={brandName} eyebrow={eyebrow} />

      <Section style={{ padding: `${SPACE.xl}px ${SPACE.xxxl}px` }}>
        {hasBody ? (
          renderEmailBody(body!)
        ) : (
          <>
            {greeting ? (
              <Text
                style={{
                  ...typeStyle("body"),
                  margin: 0,
                  color: COLOR.textPrimary,
                  fontWeight: 600,
                }}
              >
                {linkifyText(greeting)}
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
                {linkifyText(intro)}
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
                {linkifyText(note)}
              </Text>
            ) : null}
          </>
        )}

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
        // A person wrote this email. Footing it "Automated payment
        // receipt" would be both wrong and off-brand.
        disclosure="message"
      />
    </EmailLayout>
  );
}

export default CustomTemplateEmail;
