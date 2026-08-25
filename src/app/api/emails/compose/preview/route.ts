import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { ForbiddenError } from "@/lib/errors";
import { previewComposedEmailSchema } from "@/lib/validation";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { previewComposedEmail } from "@/server/services/compose-email.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Render the draft exactly as it would send.
 *
 * Same service function as the send path, same inputs, same variable
 * resolution — so "what the preview shows" and "what the client
 * receives" cannot drift apart. Nothing is persisted and no mail leaves.
 */
export const POST = withApi(
  async (req: NextRequest) => {
    const actor = await requirePermission(Permission.CUSTOMER_VIEW);
    if (!actor.orgId) throw new ForbiddenError("Active organization required");
    const body = await req.json().catch(() => ({}));
    const input = previewComposedEmailSchema.parse(body);
    const result = await previewComposedEmail(input, {
      actor,
      orgId: actor.orgId,
    });
    return jsonOk(result);
  },
  {
    // A 20k-character body plus variable fills clears the default 32 KB
    // JSON cap once an operator writes a genuinely long email.
    bodyLimitBytes: 256 * 1024,
  },
);
