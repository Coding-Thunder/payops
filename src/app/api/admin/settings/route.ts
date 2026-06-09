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
  // `requirePermission` returns the auth user with `orgId` resolved
  // from the JWT (new tokens) or User.primaryOrgId (legacy tokens
  // pre-migration). Threading it through means tenant #2 reads its
  // own settings row instead of the legacy singleton.
  const actor = await requirePermission(Permission.SETTINGS_VIEW);
  const data = await getSettings(actor.orgId);
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
    orgId: actor.orgId,
    request: ctx,
  });
  return jsonOk(data);
});
