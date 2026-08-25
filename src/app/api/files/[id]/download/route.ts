import { NextResponse, type NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { readClientFile } from "@/server/services/client-file.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Authenticated byte stream for one client file.
 *
 * Unlike the branding-logo handler (public, because customer-facing
 * emails hot-link it), this is session-gated and tenant-scoped: client
 * documents are the tenant's private material.
 *
 * Always served as an ATTACHMENT with `nosniff`. Half the allow-list —
 * SVG-adjacent images, .txt, .csv, .html-shaped payloads that slipped a
 * sniff — would otherwise be a stored-XSS vector the moment a browser
 * decided to render it inline on our own origin.
 */
export const GET = withApi(async (_req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.CLIENT_FILE_VIEW);
  const { id } = await params;
  const { file, bytes } = await readClientFile(id, actor.orgId);

  // Copy into a plain Uint8Array so the body lines up with BodyInit —
  // Buffer's ArrayBufferLike isn't assignable under strict TS.
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);

  return new NextResponse(new Blob([owned], { type: file.mimeType }), {
    status: 200,
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `attachment; filename="${asciiFallback(file.fileName)}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      // Private + no-store: this is tenant material, never a shared cache.
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

/** Quoted-string-safe ASCII name for the legacy `filename` parameter;
 *  the RFC 5987 `filename*` alongside it carries the real one. */
function asciiFallback(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
}
