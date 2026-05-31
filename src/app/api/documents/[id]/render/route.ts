import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { getDocumentForRender } from "@/server/services/document.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/documents/:id/render
 *
 * Returns the document's stored HTML snapshot as a full HTML page.
 * The user prints it to PDF via the browser's print dialog (the
 * page embeds a "Save as PDF" button that opens window.print()).
 *
 * Org-scoped via the service — a Tenant-A actor guessing a Tenant-B
 * document id gets a 404, not the document.
 *
 * Response is text/html (NOT the default JSON envelope withApi
 * usually returns) — the browser needs raw HTML to render it. We
 * still go through withApi for the auth + rate-limit guarantees,
 * but bypass jsonOk and return a NextResponse directly.
 */
export const GET = withApi(async (_req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.DOCUMENT_VIEW);
  if (!actor.orgId) {
    throw new Error("Your account is not attached to an organization.");
  }
  const { id } = await params;
  const { html } = await getDocumentForRender(id, { orgId: actor.orgId });
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
    },
  }) as never;
});
