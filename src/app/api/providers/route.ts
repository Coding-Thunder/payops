import type { NextRequest } from "next/server";

import { jsonOk, withApi } from "@/server/api/respond";
import { requireUser } from "@/server/auth/session";
import { listActiveProviders } from "@/server/services/provider.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public-ish catalog for the create-order selector. Authenticated staff
 * need this; we intentionally don't gate it behind PROVIDER_VIEW because
 * even STAFF (who can create orders) need to see the options.
 */
export const GET = withApi(async (_req: NextRequest) => {
  await requireUser();
  const items = await listActiveProviders();
  return jsonOk({ items });
});
