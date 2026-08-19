import { NextResponse } from "next/server";

import { isEncryptionAvailable } from "@/lib/crypto/envelope";
import { logger } from "@/lib/logger";
import { GatewayCredential } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { type ResendKeyProbe, resendKeyProbe } from "@/server/email/resend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Process-scoped cache: re-check at most every 5 minutes. The
 *  precondition state changes rarely (env tweak or a credential save)
 *  and we don't want every load-balancer health probe pinging Mongo. */
const CHECK_TTL_MS = 5 * 60_000;

interface Checks {
  warnings: string[];
  email: ResendKeyProbe;
  /** When these checks actually ran — NOT when the response was built. */
  checkedAt: string;
}
let cachedCheck: { ts: number; checks: Checks } | null = null;
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
  const { warnings, email, checkedAt } = await computeChecks();
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
        // Reported unconditionally, not only when it is broken. A silent
        // "unknown" (probe timed out) and a genuine "ok" used to produce the
        // identical empty-warnings payload, which is how console sign-in
        // stayed down under a green health check. `source` names the env var
        // the key came from — never the key.
        email: {
          status: email.status,
          source: email.source,
          httpStatus: email.httpStatus,
          // `ts` above is when this response was built; these checks are
          // cached for 5 minutes, so without a separate timestamp a verdict
          // up to CHECK_TTL_MS stale reads as if it were just measured.
          checkedAt,
        },
        warnings,
      },
    },
    { status: dbOk ? 200 : 503 },
  );
}

async function computeChecks(): Promise<Checks> {
  const now = Date.now();
  if (cachedCheck && now - cachedCheck.ts < CHECK_TTL_MS) {
    return cachedCheck.checks;
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
  const email = await resendKeyProbe();
  if (email.status === "invalid") {
    const msg = `Email transport credential is INVALID — Resend rejected the API key (HTTP ${email.httpStatus}), supplied by ${email.source}. Every outbound email will fail. Replace the key in the runtime env.`;
    warnings.push(msg);
    if (!warnedEmailOnce) {
      logger.error("health.email_key_invalid", { msg });
      warnedEmailOnce = true;
    }
  } else if (email.status === "unconfigured") {
    // Previously silent. "No key at all" and "key works" produced the same
    // empty payload, so a deploy that simply never received the secret looked
    // perfectly healthy while delivering nothing.
    warnings.push(
      "No email transport credential is configured (neither RESEND_API_KEY nor an re_-prefixed SMTP_PASS). Every outbound email will fail.",
    );
  } else if (email.status === "unknown") {
    // Also previously silent: a probe that times out is not evidence of health.
    warnings.push(
      `Email transport credential could not be verified — the Resend probe returned ${
        email.httpStatus !== null ? `HTTP ${email.httpStatus}` : `no response (${email.error ?? "timeout"})`
      }. This is not a confirmation that email works.`,
    );
  }

  const checks: Checks = {
    warnings,
    email,
    checkedAt: new Date(now).toISOString(),
  };
  cachedCheck = { ts: now, checks };
  return checks;
}
