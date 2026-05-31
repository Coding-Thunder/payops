import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { createDraftSchema } from "@/lib/validation";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  createDraft,
  listDrafts,
} from "@/server/services/order-draft.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async () => {
  const actor = await requirePermission(Permission.ORDER_CREATE);
  const drafts = await listDrafts({ actor, orgId: actor.orgId });
  return jsonOk({ items: drafts });
});

export const POST = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.ORDER_CREATE);
  const body = await safeJson(req);
  const input = createDraftSchema.parse(body ?? {});
  const draft = await createDraft(
    { data: input.data },
    { actor, orgId: actor.orgId },
  );
  return jsonOk(draft, { status: 201 });
});

async function safeJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
