import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import {
  createCarLinkSchema,
  listCarLinksQuerySchema,
} from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  createCarLink,
  listCarLinks,
} from "@/server/services/car-link.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.CAR_LINK_VIEW);
  const url = new URL(req.url);
  const raw = Object.fromEntries(url.searchParams.entries());
  const query = listCarLinksQuerySchema.parse(raw);
  // Only admins can ask for archived rows.
  if (query.includeArchived && actor.role === "STAFF") {
    query.includeArchived = false;
  }
  const items = await listCarLinks(query);
  return jsonOk({ items });
});

export const POST = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.CAR_LINK_CREATE);
  const body = await req.json();
  const input = createCarLinkSchema.parse(body);
  const ctx = await getRequestContext();
  const carLink = await createCarLink(input, { actor, request: ctx });
  return jsonOk(carLink, { status: 201 });
});
