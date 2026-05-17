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
 * fluff. Always shows: copyright, automated-mail disclosure, "Powered
 * by Stripe" attribution.
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
        our support team. Powered by Stripe.
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
