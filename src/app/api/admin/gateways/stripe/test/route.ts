import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { testStripeSchema } from "@/lib/validation";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { testStripeSecret } from "@/server/payments/gateway-credentials.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/gateways/stripe/test
 *
 * Pass 6a, "Did this key actually work?" probe. Hits Stripe's
 * `/v1/balance` with the supplied key + checks the mode prefix. NEVER
 * persists or encrypts. Used by the admin UI to show ✓ / ✗ before the
 * operator commits to save.
 *
 * Gated by GATEWAY_MANAGE so only the same actor who can save can
 * also test.
 */
export const POST = withApi(async (req: NextRequest) => {
  await requirePermission(Permission.GATEWAY_MANAGE);
  const body = await req.json();
  const input = testStripeSchema.parse(body);
  const result = await testStripeSecret(input.secretKey, input.mode);
  return jsonOk(result);
});
