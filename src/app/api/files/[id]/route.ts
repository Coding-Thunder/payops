import type { NextRequest } from "next/server";

import type { FileVisibility } from "@/lib/constants/client-resources";
import { Permission } from "@/lib/constants/permissions";
import { ForbiddenError } from "@/lib/errors";
import { updateClientFileSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  deleteClientFile,
  getClientFile,
  updateClientFile,
} from "@/server/services/client-file.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

export const GET = withApi(async (_req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.CLIENT_FILE_VIEW);
  const { id } = await params;
  return jsonOk(await getClientFile(id, actor.orgId));
});

/** Edit the description, the visibility, or the order relationship.
 *  Re-relating a file MOVES it between Order Files views; it never
 *  copies. */
export const PATCH = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.CLIENT_FILE_MANAGE);
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const input = updateClientFileSchema.parse(body);
  const ctx = await getRequestContext();
  const updated = await updateClientFile(
    id,
    {
      description: input.description,
      visibility: input.visibility as FileVisibility | undefined,
      orderId: input.orderId,
    },
    { actor, orgId: actor.orgId, request: ctx },
  );
  return jsonOk(updated);
});

export const DELETE = withApi(async (_req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.CLIENT_FILE_MANAGE);
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const { id } = await params;
  const ctx = await getRequestContext();
  await deleteClientFile(id, { actor, orgId: actor.orgId, request: ctx });
  return jsonOk({ deleted: true });
});
