import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { updateSettingsSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { getSettings, updateSettings } from "@/server/services/settings.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async () => {
  await requirePermission(Permission.SETTINGS_VIEW);
  const data = await getSettings();
  return jsonOk(data);
});

export const PATCH = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.SETTINGS_UPDATE);
  const body = await req.json();
  const input = updateSettingsSchema.parse(body);
  const ctx = await getRequestContext();
  const data = await updateSettings(input, {
    actorId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    request: ctx,
  });
  return jsonOk(data);
});
