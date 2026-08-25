import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { ForbiddenError } from "@/lib/errors";
import { composeEmailSchema } from "@/lib/validation";
import { idempotencyKeyFrom, runIdempotent } from "@/server/api/idempotency";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { sendComposedEmail } from "@/server/services/compose-email.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Send one composed message to a client.
 *
 * Gated on CUSTOMER_MANAGE: this puts a message in someone's inbox
 * under the workspace's name, which is a step beyond reading the client
 * record. Idempotent on the Idempotency-Key header so a double-submit or
 * a timeout retry can't send the same email twice — a duplicate returns
 * a no-op ack rather than a second delivery.
 */
export const POST = withApi(
  async (req: NextRequest) => {
    const actor = await requirePermission(Permission.CUSTOMER_MANAGE);
    if (!actor.orgId) throw new ForbiddenError("Active organization required");
    const body = await req.json().catch(() => ({}));
    const input = composeEmailSchema.parse(body);
    const request = await getRequestContext();
    const orgId = actor.orgId;

    const result = await runIdempotent<Record<string, unknown>>(
      "compose-email",
      idempotencyKeyFrom(req),
      async () => ({
        ...(await sendComposedEmail(input, { actor, orgId, request })),
        deduplicated: false,
      }),
      async () => ({ deduplicated: true }),
    );
    return jsonOk(result);
  },
  {
    bodyLimitBytes: 256 * 1024,
    rateLimit: { route: "compose-email", max: 60, windowMs: 60_000 },
  },
);
