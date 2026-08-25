import type { NextRequest } from "next/server";

import { ResourceActorType } from "@/lib/constants/client-resources";
import { Permission } from "@/lib/constants/permissions";
import { ForbiddenError } from "@/lib/errors";
import {
  createClientLinkSchema,
  listClientLinksSchema,
} from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  createClientLink,
  listClientLinks,
} from "@/server/services/client-link.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Links in one context — `customerId` for Client Links, `orderId` for
 *  Order Links. Same scoping contract as /api/files. */
export const GET = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.CLIENT_LINK_VIEW);
  const url = new URL(req.url);
  const query = listClientLinksSchema.parse({
    customerId: url.searchParams.get("customerId") ?? undefined,
    orderId: url.searchParams.get("orderId") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    filter: url.searchParams.get("filter") ?? undefined,
  });
  const links = await listClientLinks(query, actor.orgId);
  return jsonOk({ links });
});

export const POST = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.CLIENT_LINK_MANAGE);
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const body = await req.json().catch(() => ({}));
  const input = createClientLinkSchema.parse(body);
  const ctx = await getRequestContext();
  const created = await createClientLink(
    {
      ...input,
      actorType: input.addedByClient
        ? ResourceActorType.CLIENT
        : ResourceActorType.BUSINESS,
    },
    { actor, orgId: actor.orgId, request: ctx },
  );
  return jsonOk(created, { status: 201 });
});
