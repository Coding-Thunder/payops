import type { NextRequest } from "next/server";

import { recordConsentSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { getBranding } from "@/server/services/branding.service";
import {
  getPublicConsentView,
  recordConsentFromToken,
  resolveOrderOrgIdFromConsentToken,
} from "@/server/services/consent.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ token: string }>;
}

/**
 * Public consent endpoint. Both GET (load) and POST (confirm) are
 * unauthenticated, auth is the HMAC-signed token in the URL.
 *
 * The trimmed PublicConsentView is the ONLY shape we return; never the
 * internal PaymentConsentDTO. That keeps audit metadata (IP, UA,
 * verifier identity) server-side.
 */
export const GET = withApi(async (_req: NextRequest, { params }: Params) => {
  const { token } = await params;
  // CRITICAL: resolve the order's orgId from the consent token so we
  // read THAT tenant's branding, not the legacy singleton (env defaults).
  const orgId = await resolveOrderOrgIdFromConsentToken(token);
  const branding = await getBranding(orgId);
  const view = await getPublicConsentView(token, {
    brandName: branding.brandName,
  });
  return jsonOk(view);
});

export const POST = withApi(
  async (req: NextRequest, { params }: Params) => {
    const { token } = await params;
    const body = await req.json().catch(() => ({}));
    const input = recordConsentSchema.parse(body);
    const reqCtx = await getRequestContext();
    // CRITICAL: resolve the order's orgId from the consent token so we
  // read THAT tenant's branding, not the legacy singleton (env defaults).
  const orgId = await resolveOrderOrgIdFromConsentToken(token);
  const branding = await getBranding(orgId);
    const view = await recordConsentFromToken(
      {
        token,
        acknowledgement: input.acknowledgement,
        signedName: input.signedName ?? null,
        method: input.method,
      },
      { request: reqCtx, branding: { brandName: branding.brandName } },
    );
    return jsonOk(view);
  },
  {
    // Public endpoint authed by HMAC token in the URL. 20 attempts /
    // 5 min lets a legitimate customer retry a flaky submit a few times
    // while blocking automation that's harvesting tokens (HMAC makes
    // brute-forcing the token computationally infeasible anyway).
    rateLimit: { route: "consent-submit", max: 20, windowMs: 5 * 60_000 },
    bodyLimitBytes: 4 * 1024,
  },
);
