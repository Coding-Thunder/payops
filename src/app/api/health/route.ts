import { NextResponse } from "next/server";

import { isEncryptionAvailable } from "@/lib/crypto/envelope";
import { logger } from "@/lib/logger";
import { GatewayCredential } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { resendKeyStatus } from "@/server/email/resend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Process-scoped cache: re-check at most every 5 minutes. The
 *  precondition state changes rarely (env tweak or a credential save)
 *  and we don't want every load-balancer health probe pinging Mongo. */
const CHECK_TTL_MS = 5 * 60_000;
let cachedCheck: { ts: number; warnings: string[] } | null = null;
let warnedOnce = false;
let warnedEmailOnce = false;

/** DB reachability is checked on a short 15s cache — long enough not to ping
 *  Mongo on every probe, short enough that a wedged connection surfaces fast
 *  so the platform can recycle the instance. */
const DB_TTL_MS = 15_000;
let dbCheck: { ts: number; ok: boolean } | null = null;

/**
 * Is Mongo actually reachable right now? A `connect + admin().ping()` bounded
 * to 3s. Unlike the readyState flag, this catches a "connected but wedged"
 * socket (stale connection Mongo can't answer on).
 */
async function isDbReachable(): Promise<boolean> {
  const now = Date.now();
  if (dbCheck && now - dbCheck.ts < DB_TTL_MS) return dbCheck.ok;
  let ok = false;
  try {
    await Promise.race([
      (async () => {
        const m = await connectMongo();
        await m.connection.db?.admin().ping();
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("db probe timeout")), 3_000),
      ),
    ]);
    ok = true;
  } catch (err) {
    ok = false;
    logger.error("health.db_unreachable", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  dbCheck = { ts: now, ok };
  return ok;
}

/**
 * GET /api/health
 *
 * Readiness probe. Returns HTTP **503 + status "unhealthy"** when Mongo is
 * unreachable (a hard dependency — the app can't serve), so the platform's
 * health check recycles a wedged instance instead of leaving it up forever.
 * Otherwise **200**, with `data.status` = "healthy" | "degraded" and a
 * `warnings[]` array surfacing ops preconditions:
 *
 *   - `TRACETXN_MASTER_KEY` missing while encrypted credentials exist
 *   - the email transport credential being rejected by Resend
 *
 * The body (incl. `version`/`builtAt`) is returned on 503 too, so deploy
 * verification keeps working during a DB blip.
 */
export async function GET() {
  const dbOk = await isDbReachable();
  const warnings = await computeWarnings();
  const status = !dbOk
    ? "unhealthy"
    : warnings.length === 0
      ? "healthy"
      : "degraded";
  return NextResponse.json(
    {
      ok: dbOk,
      data: {
        status,
        ts: new Date().toISOString(),
        // Frozen at build time (next.config.ts) — the commit + build time of
        // the running deploy. `curl /api/health` answers "is my push live?".
        version: process.env.APP_VERSION ?? "unknown",
        builtAt: process.env.BUILT_AT ?? null,
        warnings,
      },
    },
    { status: dbOk ? 200 : 503 },
  );
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

  // Email transport preflight. A REJECTED Resend key means every payment-
  // request / consent / template email silently fails — the outage that
  // stalled all orders at LINK_GENERATED. Bounded (5s), cached (this whole
  // function is 5-min cached), and never fails the probe — only a warning.
  const emailStatus = await resendKeyStatus();
  if (emailStatus === "invalid") {
    const msg =
      "Email transport credential is INVALID — Resend rejected the API key (401). Payment-request, consent, and template emails will all fail. Fix RESEND_API_KEY / SMTP_PASS in the runtime env.";
    warnings.push(msg);
    if (!warnedEmailOnce) {
      logger.error("health.email_key_invalid", { msg });
      warnedEmailOnce = true;
    }
  }

  cachedCheck = { ts: now, warnings };
  return warnings;
}
