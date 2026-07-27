import type { NextRequest } from "next/server";
import { z } from "zod";

import { Permission } from "@/lib/constants/permissions";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  getClientProfile,
  updateClient,
} from "@/server/services/client-profile.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/** Full Client Profile: identity + on-read lifetime aggregates + orders. */
export const GET = withApi(async (_req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.CUSTOMER_VIEW);
  const { id } = await params;
  const profile = await getClientProfile(actor.orgId, id);
  return jsonOk({ profile });
});

const patchSchema = z.object({
  name: z.string().max(120).optional(),
  phone: z.string().max(32).optional(),
  company: z.string().max(160).nullable().optional(),
  country: z.string().max(80).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  tags: z.array(z.string().max(40)).max(50).optional(),
});

/** Edit identity fields (company / notes / tags / name / phone). Admin-only. */
export const PATCH = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.CUSTOMER_MANAGE);
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const input = patchSchema.parse(body);
  const request = await getRequestContext();
  const profile = await updateClient(actor.orgId, id, input, {
    actor: { id: actor.id, name: actor.name, role: actor.role },
    request,
  });
  return jsonOk({ profile });
});
