import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { connectStripeSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { connectStripeCredential } from "@/server/payments/gateway-credentials.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/gateways/stripe/connect
 *
 * Pass 6a, one-shot Stripe connect. Body carries just `mode` +
 * `secretKey` (+ optional `publishableKey`, `accountId`); the server
 * verifies the key against Stripe, auto-registers TraceTxn as a webhook
 * endpoint, captures the signing secret on the create response, and
 * persists everything encrypted. The operator never has to visit the
 * Stripe dashboard's Webhooks page.
 *
 * Gated by GATEWAY_MANAGE (SUPER_ADMIN-only).
 */
export const POST = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.GATEWAY_MANAGE);
  if (!actor.orgId) {
    throw new Error("Your account is not attached to an organization.");
  }
  const body = await req.json();
  const input = connectStripeSchema.parse(body);
  const ctx = await getRequestContext();
  const result = await connectStripeCredential(input, {
    actor: { id: actor.id, name: actor.name, role: actor.role },
    orgId: actor.orgId,
    request: ctx,
  });
  return jsonOk(result, { status: 201 });
});
