import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { updateDraftSchema } from "@/lib/validation";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  deleteDraft,
  getDraftById,
  updateDraft,
} from "@/server/services/order-draft.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

export const GET = withApi(async (_req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.ORDER_CREATE);
  const { id } = await params;
  const draft = await getDraftById(id, { actor });
  return jsonOk(draft);
});

export const PUT = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.ORDER_CREATE);
  const { id } = await params;
  const body = await req.json();
  const input = updateDraftSchema.parse(body);
  const draft = await updateDraft(
    id,
    { data: input.data, expectedRevision: input.expectedRevision },
    { actor },
  );
  return jsonOk(draft);
});

export const DELETE = withApi(async (_req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.ORDER_CREATE);
  const { id } = await params;
  await deleteDraft(id, { actor });
  return jsonOk({ ok: true });
});
