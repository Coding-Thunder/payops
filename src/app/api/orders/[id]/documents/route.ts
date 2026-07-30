import type { NextRequest } from "next/server";
import { z } from "zod";

import { Permission } from "@/lib/constants/permissions";
import { ConflictError, ForbiddenError } from "@/lib/errors";
import { DocumentKind } from "@/server/db/models";
import { idempotencyKeyFrom, runIdempotent } from "@/server/api/idempotency";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  issueDocument,
  latestDocumentForOrder,
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

/** GET /api/orders/:id/documents, list accounting docs issued for
 *  this order. Org-scoped by the service. */
export const GET = withApi(async (_req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.DOCUMENT_VIEW);
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const { id } = await params;
  const items = await listDocumentsForOrder(id, { orgId: actor.orgId });
  return jsonOk({ items });
});

/** POST /api/orders/:id/documents, issue a new document
 *  (INVOICE or RECEIPT). Admin-only via DOCUMENT_ISSUE. */
export const POST = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.DOCUMENT_ISSUE);
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const orgId = actor.orgId;
  const { id } = await params;
  const body = issueBodySchema.parse(await req.json());
  const ctx = await getRequestContext();

  // Idempotent issue: a double-submit or timeout-retry with the same
  // Idempotency-Key returns the document the first call issued rather than
  // minting a second invoice/receipt for the order. Scoped by `kind` so an
  // invoice and a receipt sharing the client's key can't collide. Deliberate
  // reissue-with-corrections is a NEW action with a fresh key, so it still
  // works. (Needs the idempotency_keys unique index in prod to enforce; until
  // then this degrades safely to today's behavior.)
  const payload = await runIdempotent(
    `issue-document:${body.kind}`,
    idempotencyKeyFrom(req),
    async () => {
      const document = await issueDocument(
        { orderId: id, kind: body.kind },
        {
          actor: {
            id: actor.id,
            name: actor.name,
            email: actor.email,
            role: actor.role,
          },
          orgId,
          request: ctx,
        },
      );
      return { document, deduplicated: false };
    },
    async () => {
      const existing = await latestDocumentForOrder(id, body.kind, { orgId });
      if (!existing) {
        throw new ConflictError(
          "That document is already being issued — try again in a moment.",
        );
      }
      return { document: existing, deduplicated: true };
    },
  );
  return jsonOk(payload, { status: 201 });
});
