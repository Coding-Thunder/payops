import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { buildComposeContext } from "@/server/services/email-context.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Everything the composer needs to open already knowing the answer:
 * the client, this workspace's brand name, the orders the message can
 * be attributed to, and the tenant's own templates with their copy
 * already loaded.
 *
 * Fetched once when the composer opens rather than per-keystroke, so
 * picking a template is instant and needs no second round-trip.
 */
export const GET = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.CUSTOMER_VIEW);
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const customerId = new URL(req.url).searchParams.get("customerId");
  if (!customerId) throw new ValidationError("customerId is required");

  const context = await buildComposeContext({
    orgId: actor.orgId,
    customerId,
    actorName: actor.name,
  });
  return jsonOk(context);
});
