import type { NextRequest } from "next/server";

import { quotationSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { verifyTurnstile } from "@/server/auth/turnstile";
import { submitQuotation } from "@/server/services/quotation.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/quotations, landing-page contact endpoint.
 *
 * Public (no auth). Persists the quotation and best-effort dispatches
 * an internal notification email to the sales address. Always returns
 * 200 once the record is written; SMTP failures stamp `notificationStatus`
 * on the record so the lead is recoverable.
 */
export const POST = withApi(
  async (req: NextRequest) => {
    const body = await req.json().catch(() => ({}));
    const input = quotationSchema.parse(body);
    const reqCtx = await getRequestContext();
    // Cloudflare Turnstile pre-flight (no-op when secret unset). Runs
    // before the DB insert + outbound email so a bot wave can't fill
    // the quotations collection or flood the sales inbox.
    await verifyTurnstile({ token: input.cfToken, remoteIp: reqCtx.ip });

    const result = await submitQuotation(input, {
      ip: reqCtx.ip,
      userAgent: reqCtx.userAgent,
    });

    return jsonOk({
      id: result.id,
      notificationStatus: result.notificationStatus,
    });
  },
  {
    // Public + unauthenticated. Tight ceiling so a botnet can't flood
    // the DB or the internal sales inbox. 16 KB body cap is well above
    // the form payload size and below memory-DoS territory.
    rateLimit: { route: "quotations", max: 5, windowMs: 5 * 60_000 },
    bodyLimitBytes: 16 * 1024,
  },
);
