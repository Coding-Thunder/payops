import type { NextRequest } from "next/server";

import {
  FileVisibility,
  LARGE_FILE_GUIDANCE,
  MAX_FILE_UPLOAD_BYTES,
  ResourceActorType,
  ResourceSource,
} from "@/lib/constants/client-resources";
import { Permission } from "@/lib/constants/permissions";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import {
  createClientFileSchema,
  listClientFilesSchema,
} from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  createClientFile,
  listClientFiles,
} from "@/server/services/client-file.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Files in one context. Pass `customerId` for Client Files, `orderId`
 * for Order Files (both is allowed and simply intersects). There is no
 * unscoped listing — a workspace-wide file browser is exactly the
 * drive-shaped product this feature is not.
 */
export const GET = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.CLIENT_FILE_VIEW);
  const url = new URL(req.url);
  const query = listClientFilesSchema.parse({
    customerId: url.searchParams.get("customerId") ?? undefined,
    orderId: url.searchParams.get("orderId") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    filter: url.searchParams.get("filter") ?? undefined,
  });
  const files = await listClientFiles(query, actor.orgId);
  return jsonOk({ files });
});

/**
 * Multipart upload. The client is required; the order is optional and,
 * when the upload came from inside an order, already filled in by the
 * caller — the operator is never asked to re-state context TraceTxn has.
 */
export const POST = withApi(
  async (req: NextRequest) => {
    const actor = await requirePermission(Permission.CLIENT_FILE_MANAGE);
    if (!actor.orgId) throw new ForbiddenError("Active organization required");

    // Pre-flight on the declared length so a 200 MB body is refused
    // before `formData()` buffers it into memory. The real check runs
    // again on the actual bytes below.
    const declared = req.headers.get("content-length");
    if (declared) {
      const n = Number.parseInt(declared, 10);
      // Multipart framing adds a few KB of boundaries + headers on top
      // of the payload, so allow a little slack before rejecting.
      if (Number.isFinite(n) && n > MAX_FILE_UPLOAD_BYTES + 512 * 1024) {
        throw new ValidationError(LARGE_FILE_GUIDANCE);
      }
    }

    const form = await req.formData().catch(() => {
      throw new ValidationError("Expected a multipart/form-data body");
    });
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ValidationError("Choose a file to upload");
    }

    const input = createClientFileSchema.parse({
      customerId: form.get("customerId") ?? undefined,
      orderId: form.get("orderId") ?? undefined,
      description: form.get("description") ?? undefined,
      visibility: form.get("visibility") ?? undefined,
      uploadedByClient: form.get("uploadedByClient") === "true",
    });

    const buffer = Buffer.from(await file.arrayBuffer());
    const ctx = await getRequestContext();
    const created = await createClientFile(
      {
        customerId: input.customerId,
        orderId: input.orderId,
        fileName: file.name,
        declaredMimeType: file.type,
        buffer,
        description: input.description,
        visibility: input.visibility as FileVisibility,
        source: input.uploadedByClient
          ? ResourceSource.CLIENT_UPLOAD
          : ResourceSource.DIRECT_UPLOAD,
        actorType: input.uploadedByClient
          ? ResourceActorType.CLIENT
          : ResourceActorType.BUSINESS,
      },
      { actor, orgId: actor.orgId, request: ctx },
    );
    return jsonOk(created, { status: 201 });
  },
  {
    // The handler enforces its own cap; the JSON body limit doesn't
    // apply to multipart.
    bodyLimitBytes: null,
    rateLimit: { route: "client-file-upload", max: 60, windowMs: 60_000 },
  },
);
