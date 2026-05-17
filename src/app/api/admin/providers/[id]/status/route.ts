import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { setProviderStatusSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { setProviderStatus } from "@/server/services/provider.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Enable / disable / archive a provider. Disabled providers are hidden
 * from the order selector and rejected on new-order creation, but past
 * orders that reference them keep rendering correctly via the snapshot.
 */
export const PATCH = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.PROVIDER_MANAGE);
  const { id } = await params;
  const body = await req.json();
  const input = setProviderStatusSchema.parse(body);
  const ctx = await getRequestContext();
  const data = await setProviderStatus(id, input, { actor, request: ctx });
  return jsonOk(data);
});
