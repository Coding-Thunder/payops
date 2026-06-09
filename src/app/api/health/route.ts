import { NextResponse } from "next/server";

import { isEncryptionAvailable } from "@/lib/crypto/envelope";
import { logger } from "@/lib/logger";
import { GatewayCredential } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Process-scoped cache: re-check at most every 5 minutes. The
 *  precondition state changes rarely (env tweak or a credential save)
 *  and we don't want every load-balancer health probe pinging Mongo. */
const CHECK_TTL_MS = 5 * 60_000;
let cachedCheck: { ts: number; warnings: string[] } | null = null;
let warnedOnce = false;

/**
 * GET /api/health
 *
 * Public liveness probe. Always returns 200 + `ok: true` so this
 * endpoint stays cheap for load balancers, but the `data.status`
 * field plus a `warnings` array surface ops-grade preconditions the
 * tenant should fix. Today the only check is:
 *
 *   - encrypted `GatewayCredential` rows exist AND
 *     `TRACETXN_MASTER_KEY` is missing/malformed → "degraded"
 *
 * (Decryption would otherwise fail on the next payment-link request.)
 *
 * The first detection of the misconfiguration logs once at ERROR so
 * an operator tailing logs sees it in the boot trail, not just on
 * their monitoring dashboard.
 */
export async function GET() {
  const warnings = await computeWarnings();
  const status = warnings.length === 0 ? "healthy" : "degraded";
  return NextResponse.json({
    ok: true,
    data: { status, ts: new Date().toISOString(), warnings },
  });
}

async function computeWarnings(): Promise<string[]> {
  const now = Date.now();
  if (cachedCheck && now - cachedCheck.ts < CHECK_TTL_MS) {
    return cachedCheck.warnings;
  }
  const warnings: string[] = [];

  if (!isEncryptionAvailable()) {
    try {
      await connectMongo();
      const hasEncryptedRows = await GatewayCredential.exists({});
      if (hasEncryptedRows) {
        const msg =
          "TRACETXN_MASTER_KEY is not configured but encrypted gateway credentials exist. Decryption will fail on the next payment-link request. Set TRACETXN_MASTER_KEY in the runtime env.";
        warnings.push(msg);
        if (!warnedOnce) {
          logger.error("health.master_key_missing_with_credentials", { msg });
          warnedOnce = true;
        }
      }
    } catch (err) {
      warnings.push(
        `Health check could not reach Mongo: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  cachedCheck = { ts: now, warnings };
  return warnings;
}
