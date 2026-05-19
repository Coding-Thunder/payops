import { type NextRequest } from "next/server";

import { ValidationError } from "@/lib/errors";
import { Permission } from "@/lib/constants/permissions";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { replaceProviderLogo } from "@/server/services/provider.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Multipart logo upload. Expects a single `file` field. Writes to
 * `public/providers/` with a random suffix so previous receipts that
 * pointed at the prior file keep resolving.
 */
export const POST = withApi(
  async (req: NextRequest, { params }: Params) => {
    const actor = await requirePermission(Permission.PROVIDER_MANAGE);
    const { id } = await params;

    // Pre-flight Content-Length cap: anything over 1 MB never reaches
    // formData() — the service-level 512 KB cap is the hard ceiling.
    const declared = req.headers.get("content-length");
    if (declared) {
      const n = Number.parseInt(declared, 10);
      if (Number.isFinite(n) && n > 1024 * 1024) {
        throw new ValidationError("Logo upload exceeds the 1 MB request cap");
      }
    }

    const form = await req.formData().catch(() => {
      throw new ValidationError("Expected a multipart/form-data body");
    });
    const file = form.get("file");
    if (!(file instanceof Blob)) {
      throw new ValidationError("Missing 'file' field");
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = file.type;

    const ctx = await getRequestContext();
    const data = await replaceProviderLogo(
      id,
      { buffer, mimeType },
      { actor, request: ctx },
    );
    return jsonOk(data);
  },
  {
    bodyLimitBytes: null,
    rateLimit: { route: "provider-logo", max: 20, windowMs: 60_000 },
  },
);
