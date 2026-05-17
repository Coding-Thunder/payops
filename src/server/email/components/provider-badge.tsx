import { Column, Img, Row, Section, Text } from "@react-email/components";
import * as React from "react";

import {
  resolveProvider,
  type ProviderSnapshot,
} from "@/lib/constants/providers";

import { COLOR, RADIUS, SPACE, typeStyle } from "./tokens";

interface ProviderBadgeProps {
  provider: ProviderSnapshot | null | undefined;
  /** Absolute URL base so the logo resolves outside our process. */
  appUrl: string;
  /** Small line under the provider name (e.g. booking type). */
  caption?: string;
}

/**
 * Provider strip — logo in a neutral white frame next to the provider
 * name and a small caption. NO brand-color band; the provider's primary
 * color stays inside the admin app, not the customer receipt.
 */
export function ProviderBadge({
  provider,
  appUrl,
  caption,
}: ProviderBadgeProps) {
  const meta = resolveProvider(provider ?? undefined);
  const logoUrl = absoluteUrl(appUrl, meta.logo);

  return (
    <Section
      style={{
        padding: `${SPACE.lg}px ${SPACE.xxxl}px`,
        borderBottom: `1px solid ${COLOR.borderSoft}`,
        backgroundColor: COLOR.surfaceMuted,
      }}
    >
      <Row>
        <Column
          style={{
            width: 60,
            paddingRight: SPACE.md + 2,
            verticalAlign: "middle",
          }}
        >
          <Img
            src={logoUrl}
            width="44"
            height="44"
            alt={meta.name}
            style={{
              display: "block",
              borderRadius: RADIUS.md,
              backgroundColor: COLOR.surface,
              border: `1px solid ${COLOR.border}`,
              padding: 4,
              boxSizing: "border-box",
            }}
          />
        </Column>
        <Column style={{ verticalAlign: "middle" }}>
          <Text
            style={{
              ...typeStyle("bodyStrong"),
              margin: 0,
              color: COLOR.textPrimary,
            }}
          >
            {meta.name}
          </Text>
          {caption ? (
            <Text
              style={{
                ...typeStyle("label"),
                margin: 0,
                marginTop: 2,
                color: COLOR.textMuted,
              }}
            >
              {caption}
            </Text>
          ) : null}
        </Column>
      </Row>
    </Section>
  );
}

function absoluteUrl(base: string, path: string): string {
  if (path.startsWith("data:")) return path;
  if (/^https?:\/\//i.test(path)) return path;
  const trimmedBase = base.replace(/\/+$/, "");
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}
