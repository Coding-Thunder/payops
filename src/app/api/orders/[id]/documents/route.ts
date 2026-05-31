import type { NextRequest } from "next/server";
import { z } from "zod";

import { Permission } from "@/lib/constants/permissions";
import { DocumentKind } from "@/server/db/models";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  issueDocument,
  listDocumentsForOrder,
} from "@/server/services/document.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

const issueBodySchema = z.object({
  kind: z.enum([DocumentKind.INVOICE, DocumentKind.RECEIPT]),
});

/** GET /api/orders/:id/documents — list accounting docs issued for
 *  this order. Org-scoped by the service. */
export const GET = withApi(async (_req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.DOCUMENT_VIEW);
  if (!actor.orgId) {
    throw new Error("Your account is not attached to an organization.");
  }
  const { id } = await params;
  const items = await listDocumentsForOrder(id, { orgId: actor.orgId });
  return jsonOk({ items });
});

/** POST /api/orders/:id/documents — issue a new document
 *  (INVOICE or RECEIPT). Admin-only via DOCUMENT_ISSUE. */
export const POST = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.DOCUMENT_ISSUE);
  if (!actor.orgId) {
    throw new Error("Your account is not attached to an organization.");
  }
  const { id } = await params;
  const body = issueBodySchema.parse(await req.json());
  const ctx = await getRequestContext();
  const doc = await issueDocument(
    { orderId: id, kind: body.kind },
    {
      actor: {
        id: actor.id,
        name: actor.name,
        email: actor.email,
        role: actor.role,
      },
      orgId: actor.orgId,
      request: ctx,
    },
  );
  return jsonOk({ document: doc }, { status: 201 });
});
