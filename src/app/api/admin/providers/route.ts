import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import {
  createProviderSchema,
  listProvidersQuerySchema,
} from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  createProvider,
  listProviders,
} from "@/server/services/provider.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req: NextRequest) => {
  await requirePermission(Permission.PROVIDER_VIEW);
  const url = new URL(req.url);
  const query = listProvidersQuerySchema.parse({
    status: url.searchParams.get("status") ?? undefined,
    includeAll: url.searchParams.get("includeAll") ?? "true",
  });
  const items = await listProviders(query);
  return jsonOk({ items });
});

export const POST = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.PROVIDER_MANAGE);
  const body = await req.json();
  const input = createProviderSchema.parse(body);
  const ctx = await getRequestContext();
  const data = await createProvider(input, { actor, request: ctx });
  return jsonOk(data, { status: 201 });
});
