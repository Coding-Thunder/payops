import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { updateBrandingSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  getBranding,
  updateBranding,
} from "@/server/services/branding.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async () => {
  await requirePermission(Permission.BRANDING_VIEW);
  const data = await getBranding();
  return jsonOk(data);
});

export const PATCH = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.BRANDING_MANAGE);
  const body = await req.json();
  const input = updateBrandingSchema.parse(body);
  const ctx = await getRequestContext();
  const data = await updateBranding(input, { actor, request: ctx });
  return jsonOk(data);
});
