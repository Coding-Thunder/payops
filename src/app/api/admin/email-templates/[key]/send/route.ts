import type { NextRequest } from "next/server";

import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { Permission } from "@/lib/constants/permissions";
import {
  sendCustomTemplateSchema,
  templateKeyParam,
} from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { sendCustomTemplateManually } from "@/server/services/email.service";
import { getOrderById } from "@/server/services/order.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ key: string }>;
}

/**
 * Manual dispatch of a template (system or custom). Operator fires
 * from the order / customer / payment detail surfaces.
 *
 * When source.kind === "order" the route resolves the order first so
 * (a) we have a valid orderNumber for the evidence row, and (b) the
 * orderId is tenant-checked against actor.orgId before any send-side
 * effects fire (avoids a cross-tenant manual dispatch).
 *
 * Permission gate: ORDER_UPDATE for now — every operator who can
 * touch orders can fire templates. When the role matrix grows a
 * dedicated TEMPLATE_SEND permission we can tighten this without
 * changing the route shape.
 */
export const POST = withApi(async (req: NextRequest, { params }: Params) => {
  const actor = await requirePermission(Permission.ORDER_UPDATE);
  if (!actor.orgId) throw new ForbiddenError("Active organization required");
  const { key } = await params;
  const templateKey = templateKeyParam.parse(key);
  const body = await req.json().catch(() => ({}));
  const input = sendCustomTemplateSchema.parse(body);
  const reqCtx = await getRequestContext();

  // Resolve the order (if any) up-front so the evidence row gets a
  // real orderNumber and the orgId pin happens before the send.
  let source:
    | { kind: "order"; orderId: string; orderNumber: string }
    | { kind: "customer"; customerId: string }
    | null = null;
  if (input.source?.kind === "order") {
    try {
      const order = await getOrderById(input.source.orderId, {
        actor,
        orgId: actor.orgId,
      });
      source = {
        kind: "order",
        orderId: order.id,
        orderNumber: order.orderNumber,
      };
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new NotFoundError("Order not found for this tenant");
      }
      throw err;
    }
  } else if (input.source?.kind === "customer") {
    source = { kind: "customer", customerId: input.source.customerId };
  }

  const result = await sendCustomTemplateManually(
    {
      templateKey,
      to: input.to,
      overrides: input.overrides,
    },
    {
      actor,
      orgId: actor.orgId,
      source,
      request: reqCtx,
    },
  );
  return jsonOk(result);
});
