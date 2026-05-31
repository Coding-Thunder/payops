import { Hr, Section, Text } from "@react-email/components";
import * as React from "react";

import { COLOR, SPACE, typeStyle } from "./tokens";

interface EmailFooterProps {
  brandName: string;
  /** Optional legal/postal address line. */
  legalAddress?: string;
  /** Optional support email displayed in the legal block. */
  supportEmail?: string;
}

/**
 * Bottom-of-email legal block. Muted, single column, no marketing
 * fluff. Always shows: tenant copyright + automated-mail disclosure.
 *
 * Payment-processor attribution (e.g. "Powered by Stripe") was
 * removed: TraceTxn is BYOS Stripe today but the email frame stays
 * processor-agnostic so the same component renders correctly when a
 * tenant later adds a different gateway, and so a customer's receipt
 * doesn't promote a third-party brand alongside the tenant's.
 */
export function EmailFooter({
  brandName,
  legalAddress,
  supportEmail,
}: EmailFooterProps) {
  const year = new Date().getUTCFullYear();
  return (
    <Section
      style={{
        padding: `${SPACE.xl}px ${SPACE.xxxl}px ${SPACE.xxl + 4}px`,
        borderTop: `1px solid ${COLOR.border}`,
        backgroundColor: COLOR.surfaceMuted,
      }}
    >
      <Hr
        style={{
          margin: 0,
          marginBottom: SPACE.md + 2,
          borderColor: COLOR.borderSoft,
          borderTopWidth: 1,
          display: "none",
        }}
      />
      <Text
        style={{
          ...typeStyle("legal"),
          margin: 0,
          color: COLOR.textMuted,
        }}
      >
        © {year} {brandName}. Automated payment receipt — replies route to
        our support team.
      </Text>
      {supportEmail || legalAddress ? (
        <Text
          style={{
            ...typeStyle("legal"),
            margin: 0,
            marginTop: 4,
            color: COLOR.textFaint,
          }}
        >
          {supportEmail ? <span>{supportEmail}</span> : null}
          {supportEmail && legalAddress ? " · " : null}
          {legalAddress ? <span>{legalAddress}</span> : null}
        </Text>
      ) : null}
    </Section>
  );
}
