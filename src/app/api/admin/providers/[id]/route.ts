import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { updateProviderSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  archiveProvider,
  getProviderById,
  updateProvider,
} from "@/server/services/provider.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

export const GET = withApi(async (_req: NextRequest, { params }: Params) => {
  await requirePermission(Permission.PROVIDER_VIEW);
  const { id } = await params;
  const data = await getProviderById(id);
  return jsonOk(data);
});

export const PATCH = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.PROVIDER_MANAGE);
  const { id } = await params;
  const body = await req.json();
  const input = updateProviderSchema.parse(body);
  const ctx = await getRequestContext();
  const data = await updateProvider(id, input, { actor, request: ctx });
  return jsonOk(data);
});

/**
 * Soft-delete via status=ARCHIVED. Hard delete is deliberately not
 * supported — historical orders reference this provider's snapshot and
 * disputes may need its canonical brand metadata later.
 */
export const DELETE = withApi(async (_req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.PROVIDER_MANAGE);
  const { id } = await params;
  const ctx = await getRequestContext();
  const data = await archiveProvider(id, { actor, request: ctx });
  return jsonOk(data);
});
