import type { NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { findCustomerByEmail } from "@/server/services/customer.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Pass 6d, saved customer prefill lookup.
 *
 * The create-order dynamic form calls this on email-field blur. A
 * match pre-fills name + phone if those fields are still empty.
 *
 * Gated by ORDER_CREATE so staff can use it; the response is the
 * minimum the form needs and nothing more.
 */
export const GET = withApi(async (req: NextRequest) => {
  const actor = await requirePermission(Permission.ORDER_CREATE);
  const url = new URL(req.url);
  const email = (url.searchParams.get("email") ?? "").trim();
  if (!email || !actor.orgId) {
    return jsonOk({ customer: null });
  }
  const customer = await findCustomerByEmail(actor.orgId, email);
  return jsonOk({ customer });
});
