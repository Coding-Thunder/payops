import type { NextRequest } from "next/server";

import { jsonOk, withApi } from "@/server/api/respond";
import { getSelectedOrganization } from "@/server/auth/organization";
import { requireUser } from "@/server/auth/session";
import { listActiveProviders } from "@/server/services/provider.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public-ish catalog for the create-order selector. Authenticated staff
 * need this; we intentionally don't gate it behind PROVIDER_VIEW because
 * even STAFF (who can create orders) need to see the options.
 *
 * Scoped to the selected organization exactly as the create page is: a
 * supplier an admin confined to another organization is never listed (and
 * the server refuses to book it).
 */
export const GET = withApi(async (_req: NextRequest) => {
  await requireUser();
  const selected = await getSelectedOrganization();
  const items = await listActiveProviders({ organizationId: selected?.id ?? null });
  return jsonOk({ items });
});
