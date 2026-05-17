import { Column, Img, Row, Section, Text } from "@react-email/components";
import * as React from "react";

import {
  resolveProvider,
  type ProviderSnapshot,
} from "@/lib/constants/providers";

interface EmailProviderHeaderProps {
  provider: ProviderSnapshot | null | undefined;
  /** Absolute base URL used to build a public logo URL email clients can fetch. */
  appUrl: string;
  /** Eyebrow text rendered above the brand name (e.g. "Booking confirmation"). */
  eyebrow?: string;
}

/**
 * Provider-branded email header. Renders a thin colour wash drawn from the
 * brand's primary colour so the receipt still reads on-brand even when an
 * email client blocks remote images.
 *
 * NOTE: `Img` uses an absolute URL — never a relative `/providers/...` path —
 * so Gmail/Outlook/Apple Mail can actually load it.
 */
export function EmailProviderHeader({
  provider,
  appUrl,
  eyebrow = "Booking confirmation",
}: EmailProviderHeaderProps) {
  const meta = resolveProvider(provider ?? undefined);
  const logoUrl = absoluteUrl(appUrl, meta.logo);

  return (
    <Section
      style={{
        backgroundColor: meta.primaryColor,
        padding: "24px 28px",
      }}
    >
      <Row>
        <Column
          style={{ width: 92, paddingRight: 18, verticalAlign: "middle" }}
        >
          <Img
            src={logoUrl}
            width="76"
            height="76"
            alt={meta.name}
            style={{
              borderRadius: 12,
              display: "block",
              backgroundColor: "#FFFFFF",
              padding: 6,
              boxSizing: "border-box",
            }}
          />
        </Column>
        <Column style={{ verticalAlign: "middle" }}>
          <Text
            style={{
              margin: 0,
              color: meta.onPrimaryColor,
              opacity: 0.85,
              fontSize: 11,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              lineHeight: "14px",
            }}
          >
            {eyebrow}
          </Text>
          <Text
            style={{
              margin: 0,
              marginTop: 6,
              color: meta.onPrimaryColor,
              fontSize: 22,
              fontWeight: 700,
              lineHeight: "26px",
              letterSpacing: "-0.015em",
            }}
          >
            {meta.name}
          </Text>
        </Column>
      </Row>
    </Section>
  );
}

function absoluteUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const trimmedBase = base.replace(/\/+$/, "");
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}
