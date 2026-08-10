import { Hr, Section, Text } from "@react-email/components";
import * as React from "react";

import { COLOR, SPACE, typeStyle } from "./tokens";

interface EmailFooterProps {
  brandName: string;
  /** Optional legal/postal address line. */
  legalAddress?: string;
  /** Optional support email displayed in the legal block. */
  supportEmail?: string;
  /**
   * Payment processor that actually handled the money, e.g. "Stripe" or
   * "PayPal". Omit and the attribution sentence is dropped entirely — this
   * used to read "Powered by Stripe." unconditionally, which put a Stripe
   * attribution in the legal footer of every PayPal brand's email.
   */
  gatewayLabel?: string | null;
}

/**
 * Bottom-of-email legal block. Muted, single column, no marketing
 * fluff. Shows copyright, the automated-mail disclosure, and — when the
 * processor is known — its attribution.
 */
export function EmailFooter({
  brandName,
  legalAddress,
  supportEmail,
  gatewayLabel,
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
        our support team.{gatewayLabel ? ` Powered by ${gatewayLabel}.` : ""}
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
