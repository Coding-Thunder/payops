import { NextResponse } from "next/server";

import {
  AuditAction,
  AuditEntity,
} from "@/lib/constants/enums";
import { Permission } from "@/lib/constants/permissions";
import { getRequestContext } from "@/server/api/request-context";
import { withApi } from "@/server/api/respond";
import {
  PDF_MAX_EVENTS,
  acquirePdfSlot,
  releasePdfSlot,
} from "@/server/api/security";
import { requirePermission } from "@/server/auth/session";
import { recordAudit } from "@/server/services/audit.service";
import { getEvidenceChain } from "@/server/services/evidence.service";
import { renderEvidencePdf } from "@/server/pdf/evidence/render";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Server-rendered PDF evidence packet.
 *
 * OOM guard on the $5 tier (`@react-pdf/renderer` peaks at 200-500 MB
 * heap per render):
 *
 *   1. In-process semaphore caps concurrent renders to 1. Excess
 *      callers get 503 + Retry-After so the UI backs off cleanly
 *      rather than fighting for memory.
 *   2. Chain-size cap (`PDF_MAX_EVENTS`) — refuse very large chains
 *      with 413. Forces an upstream chunking strategy before the
 *      renderer can OOM the box.
 *   3. The slot is released in `finally` so a throw inside the renderer
 *      doesn't leak the semaphore.
 */
export const GET = withApi(async (_req: Request, { params }: Params) => {
  const actor = await requirePermission(Permission.EVIDENCE_EXPORT);
  const { id } = await params;
  const reqCtx = await getRequestContext();
  const chain = await getEvidenceChain(id, { actor });

  if (chain.events.length > PDF_MAX_EVENTS) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: `Evidence chain has ${chain.events.length} events; max ${PDF_MAX_EVENTS} per PDF`,
        },
      },
      { status: 413 },
    );
  }

  if (!acquirePdfSlot()) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "BUSY",
          message: "Another evidence packet is rendering. Please retry shortly.",
        },
      },
      { status: 503, headers: { "Retry-After": "5" } },
    );
  }

  try {
    const pdf = await renderEvidencePdf(chain);
    await recordAudit({
      action: AuditAction.EVIDENCE_EXPORTED,
      entityType: AuditEntity.ORDER_EVIDENCE,
      entityId: chain.order.id,
      actor: { userId: actor.id, name: actor.name, role: actor.role },
      request: reqCtx,
      metadata: {
        orderNumber: chain.order.orderNumber,
        eventCount: chain.events.length,
        integrityValid: chain.verification.valid,
        headHash: chain.verification.headHash,
      },
    });

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="evidence-${chain.order.orderNumber}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } finally {
    releasePdfSlot();
  }
});
