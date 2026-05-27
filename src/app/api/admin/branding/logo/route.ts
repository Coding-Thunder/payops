import type { NextRequest } from "next/server";

import { ValidationError } from "@/lib/errors";
import { Permission } from "@/lib/constants/permissions";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { replaceBrandingLogo } from "@/server/services/branding.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Multipart logo upload for the workspace branding singleton. Mirrors the
 * provider-logo endpoint: random filename suffix invalidates caches and
 * keeps the previous file in place so any cached page reference still
 * resolves until the next deploy / cleanup.
 */
export const POST = withApi(
  async (req: NextRequest) => {
    const actor = await requirePermission(Permission.BRANDING_MANAGE);

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
    const ctx = await getRequestContext();
    const data = await replaceBrandingLogo(
      { buffer, mimeType: file.type },
      { actor, orgId: actor.orgId, request: ctx },
    );
    return jsonOk(data);
  },
  {
    // Multipart payloads exceed the default 32 KB JSON cap; the route
    // imposes its own 1 MB pre-flight + 512 KB service-level cap.
    bodyLimitBytes: null,
    rateLimit: { route: "branding-logo", max: 20, windowMs: 60_000 },
  },
);
