import "server-only";

import { createElement, type ReactElement } from "react";

import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";

import { inlinePublicImage } from "@/server/email/inline-image";
import type { OrderEvidenceChainDTO } from "@/types";

import { EvidenceDocument } from "./evidence-document";

/**
 * Render the evidence chain to a PDF Buffer. Server-only (the renderer
 * pulls in node-canvas + fontkit), invoked from the export route.
 *
 * Pre-flight: inline the provider logo into a base64 data URI so the PDF
 * is self-contained even on machines that can't reach our public URL.
 * The vehicle image is passed through as-is — `@react-pdf/renderer`
 * fetches remote URLs at render time. We let the renderer skip it if
 * the fetch fails rather than gating the whole packet on the customer
 * URL still being live.
 *
 * The cast on the createElement result is a deliberate concession to
 * react-pdf's strict typing — `renderToBuffer` insists on a
 * `ReactElement<DocumentProps>` literal but our wrapper component
 * returns one transparently.
 */
export async function renderEvidencePdf(
  chain: OrderEvidenceChainDTO,
): Promise<Buffer> {
  const providerLogoInline =
    chain.order.provider?.logo
      ? await inlinePublicImage(chain.order.provider.logo)
      : null;
  const enrichedChain: OrderEvidenceChainDTO = {
    ...chain,
    order: {
      ...chain.order,
      provider: chain.order.provider
        ? {
            ...chain.order.provider,
            logo: providerLogoInline ?? chain.order.provider.logo,
          }
        : chain.order.provider,
    },
  };
  const node = createElement(EvidenceDocument, {
    chain: enrichedChain,
    generatedAt: new Date(),
  }) as unknown as ReactElement<DocumentProps>;
  return renderToBuffer(node);
}
