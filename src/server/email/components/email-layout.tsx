import {
  Body,
  Container,
  Head,
  Html,
  Preview,
} from "@react-email/components";
import * as React from "react";

import {
  COLOR,
  EMAIL_CONTAINER_MAX_WIDTH,
  FONT,
  RADIUS,
  SPACE,
} from "./tokens";

interface EmailLayoutProps {
  /** Inbox preview text. Shown next to the subject in most clients. */
  preview: string;
  children: React.ReactNode;
}

/**
 * Outer email shell: <Html>, <Head>, viewport + color-scheme metas, the
 * page-tone <Body>, and the white-card <Container>. Every email template
 * composes its sections inside this.
 *
 * Why no <Tailwind>: most clients strip <style>. We keep everything
 * inline. The token system + per-component styles give us the same
 * design discipline without the runtime risk.
 */
export function EmailLayout({ preview, children }: EmailLayoutProps) {
  return (
    <Html lang="en">
      <Head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Light-only, emails read better on a known background. */}
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <title>{preview}</title>
      </Head>
      <Preview>{preview}</Preview>
      <Body
        style={{
          backgroundColor: COLOR.page,
          fontFamily: FONT.family,
          margin: 0,
          padding: `${SPACE.xxxl}px ${SPACE.md}px`,
          color: COLOR.textPrimary,
          // Avoid iOS auto-linking dates/phone numbers as call-to-actions.
          WebkitTextSizeAdjust: "100%",
        }}
      >
        <Container
          style={{
            backgroundColor: COLOR.surface,
            borderRadius: RADIUS.lg,
            maxWidth: EMAIL_CONTAINER_MAX_WIDTH,
            margin: "0 auto",
            border: `1px solid ${COLOR.border}`,
            overflow: "hidden",
          }}
        >
          {children}
        </Container>
      </Body>
    </Html>
  );
}
