import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { saveGatewayCredentialSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { isEncryptionAvailable } from "@/lib/crypto/envelope";
import {
  listGatewayCredentialsForOrg,
  saveGatewayCredential,
} from "@/server/payments/gateway-credentials.service";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET, list every per-org gateway credential row + a few diagnostics
 * the admin UI needs to render the page (webhook URL template, whether
 * the master encryption key is configured). Never returns the
 * encrypted secrets themselves.
 */
export const GET = withApi(async (_req: NextRequest) => {
  const actor = await requirePermission(Permission.GATEWAY_VIEW);
  if (!actor.orgId) {
    // SUPER_ADMIN whose JWT has no orgId, only happens for ghost
    // legacy accounts the migration script never claimed.
    return jsonOk({
      items: [],
      webhookUrlBase: env.server.APP_URL,
      encryptionAvailable: isEncryptionAvailable(),
      orgId: null,
    });
  }
  const items = await listGatewayCredentialsForOrg(actor.orgId);
  return jsonOk({
    items,
    webhookUrlBase: env.server.APP_URL,
    encryptionAvailable: isEncryptionAvailable(),
    orgId: actor.orgId,
  });
});

/**
 * POST, upsert a credential. Re-posting for the same (orgId, gateway)
 * rotates the encrypted blob, there's no separate /rotate endpoint
 * because rotation is semantically identical to "save again with new
 * key material".
 *
 * Strict SUPER_ADMIN gate (via `GATEWAY_MANAGE`) because the action
 * touches payment routing for the entire org.
 */
export const POST = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.GATEWAY_MANAGE);
  if (!actor.orgId) {
    // Defense in depth: requireOrgId in the service would also throw,
    // but bouncing here is friendlier.
    throw new Error("Your account is not attached to an organization.");
  }
  const body = await req.json();
  const input = saveGatewayCredentialSchema.parse(body);
  const ctx = await getRequestContext();
  const saved = await saveGatewayCredential(input, {
    actor: { id: actor.id, name: actor.name, role: actor.role },
    orgId: actor.orgId,
    request: ctx,
  });
  return jsonOk(saved, { status: 201 });
});
