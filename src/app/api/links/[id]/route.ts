import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { ForbiddenError } from "@/lib/errors";
import { updateClientLinkSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  deleteClientLink,
  updateClientLink,
} from "@/server/services/client-link.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

export const PATCH = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.CLIENT_LINK_MANAGE);
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const input = updateClientLinkSchema.parse(body);
  const ctx = await getRequestContext();
  const updated = await updateClientLink(id, input, {
    actor,
    orgId: actor.orgId,
    request: ctx,
  });
  return jsonOk(updated);
});

export const DELETE = withApi(async (_req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.CLIENT_LINK_MANAGE);
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const { id } = await params;
  const ctx = await getRequestContext();
  await deleteClientLink(id, { actor, orgId: actor.orgId, request: ctx });
  return jsonOk({ deleted: true });
});
