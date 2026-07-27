import type { NextRequest } from "next/server";
import { z } from "zod";

import { Permission } from "@/lib/constants/permissions";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  createClient,
  listClients,
} from "@/server/services/client-profile.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Paginated, searchable list of Client Profiles for the active tenant. */
export const GET = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.CUSTOMER_VIEW);
  const url = new URL(req.url);
  const result = await listClients(actor.orgId, {
    search: url.searchParams.get("q") ?? undefined,
    page: Number(url.searchParams.get("page")) || undefined,
    pageSize: Number(url.searchParams.get("pageSize")) || undefined,
    sort: url.searchParams.get("sort") ?? undefined,
  });
  return jsonOk(result);
});

const createSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(254).optional().or(z.literal("")),
  phone: z.string().max(32).optional(),
  company: z.string().max(160).nullable().optional(),
  country: z.string().max(80).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

/** Create a new Client Profile (the "New Client Record" flow). */
export const POST = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.CUSTOMER_MANAGE);
  const body = await req.json().catch(() => ({}));
  const input = createSchema.parse(body);
  const request = await getRequestContext();
  const result = await createClient(actor.orgId, input, {
    actor: { id: actor.id, name: actor.name, role: actor.role },
    request,
  });
  return jsonOk(result);
});
