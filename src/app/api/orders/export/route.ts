import { NextResponse, type NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { assertPaidFeaturesEnabled } from "@/lib/paid-features";
import { exportOrdersSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import {
  buildOrderChargeExport,
  XLSX_CONTENT_TYPE,
} from "@/server/services/order-export.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Download charging data for the orders the operator SELECTED, as a real
 * .xlsx workbook with one row per charge line.
 *
 * The selection is the whole scope. There is deliberately no "export
 * everything the list is filtered to" here: on an operation with thousands
 * of orders that is a bulk egress nobody asked for, so the request carries
 * the ids that were ticked and nothing else.
 *
 * POST rather than GET because a selection of hundreds of ids does not
 * belong in a URL — and because this records an audit row.
 *
 * Authorization is unchanged: the same permission the list needs, and the
 * export service applies the list's own tenancy + STAFF own-orders filter
 * to the ids, so an id from outside the operator's scope exports nothing.
 *
 * Deliberately not wrapped in the JSON envelope helper's success path: this
 * returns binary. `withApi` still provides the error envelope, auth plumbing
 * and rate limiting.
 */
export const POST = withApi(
  async (req: NextRequest) => {
    const actor = await requirePermission(Permission.ORDER_VIEW_OWN);
    // A paid feature, switched off until paid for: see src/lib/paid-features.ts.
    assertPaidFeaturesEnabled();
    const body = await req.json().catch(() => ({}));
    const selection = exportOrdersSchema.parse(body);
    const ctx = await getRequestContext();

    const result = await buildOrderChargeExport(selection, { actor, request: ctx });

    // NextResponse rather than Response so this still satisfies
    // `withApi`, keeping its auth plumbing, error envelope and rate limit.
    return new NextResponse(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        "Content-Type": XLSX_CONTENT_TYPE,
        "Content-Length": String(result.buffer.byteLength),
        // `filename` is generated from a date stamp, never from user input,
        // so there is no header-injection surface here.
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "no-store, private",
        // How many orders the workbook covers, so the page can report it.
        "X-Export-Order-Count": String(result.orderCount),
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
  { rateLimit: { route: "order-export", max: 10, windowMs: 60_000 } },
);
