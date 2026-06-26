import type { NextRequest } from "next/server";

import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import {
  getPublicAcknowledgementView,
  recordTermsAcknowledgement,
} from "@/server/services/acknowledgement.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ token: string }>;
}

/**
 * Public terms-acknowledgement endpoint. Both GET (load) and POST (agree) are
 * unauthenticated — auth is the HMAC-signed token in the URL. Reached from the
 * "I Agree" button in the confirmation email.
 */
export const GET = withApi(async (_req: NextRequest, { params }: Params) => {
  const { token } = await params;
  const view = await getPublicAcknowledgementView(token);
  return jsonOk(view);
});

export const POST = withApi(
  async (_req: NextRequest, { params }: Params) => {
    const { token } = await params;
    const reqCtx = await getRequestContext();
    const view = await recordTermsAcknowledgement(token, { request: reqCtx });
    return jsonOk(view);
  },
  {
    rateLimit: { route: "terms-acknowledge", max: 20, windowMs: 5 * 60_000 },
    bodyLimitBytes: 2 * 1024,
  },
);
