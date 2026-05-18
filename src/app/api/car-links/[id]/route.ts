import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { updateCarLinkSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  deactivateCarLink,
  restoreCarLink,
  updateCarLink,
} from "@/server/services/car-link.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const PATCH = withApi(async (req: NextRequest, ctx: Ctx) => {
  const actor = await requirePermission(Permission.CAR_LINK_MANAGE);
  const { id } = await ctx.params;
  const body = await req.json();
  const input = updateCarLinkSchema.parse(body);
  const reqCtx = await getRequestContext();
  const carLink = await updateCarLink(id, input, { actor, request: reqCtx });
  return jsonOk(carLink);
});

export const DELETE = withApi(async (req: NextRequest, ctx: Ctx) => {
  const actor = await requirePermission(Permission.CAR_LINK_MANAGE);
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const restore = url.searchParams.get("restore") === "1";
  const reqCtx = await getRequestContext();
  const carLink = restore
    ? await restoreCarLink(id, { actor, request: reqCtx })
    : await deactivateCarLink(id, { actor, request: reqCtx });
  return jsonOk(carLink);
});
