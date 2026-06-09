import "server-only";

import { createElement, type ReactElement } from "react";

import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";

import type { OrderEvidenceChainDTO } from "@/types";

import { EvidenceDocument } from "./evidence-document";

/**
 * Render the evidence chain to a PDF Buffer. Server-only (the renderer
 * pulls in node-canvas + fontkit), invoked from the export route.
 *
 * Pass 5h: Provider-logo pre-inlining is gone, the PDF no longer has
 * a dedicated provider strip. Any per-line image URL the order carries
 * in `lineItems[i].attributes.image_url` is fetched lazily by the
 * renderer at print time. The cast on the createElement result is a
 * deliberate concession to react-pdf's strict typing, `renderToBuffer`
 * insists on a `ReactElement<DocumentProps>` literal but our wrapper
 * component returns one transparently.
 */
export async function renderEvidencePdf(
  chain: OrderEvidenceChainDTO,
): Promise<Buffer> {
  const node = createElement(EvidenceDocument, {
    chain,
    generatedAt: new Date(),
  }) as unknown as ReactElement<DocumentProps>;
  return renderToBuffer(node);
}
