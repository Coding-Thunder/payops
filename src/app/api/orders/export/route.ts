import { NextResponse, type NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { listOrdersQuerySchema } from "@/lib/validation";
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
 * Download charging data as a real .xlsx workbook, one row per charge line.
 *
 * Takes the SAME query parameters as the order list and runs the same filter,
 * so what downloads is exactly what the caller can already see — including
 * the organization scope and the STAFF own-orders narrowing.
 *
 * Deliberately not wrapped in the JSON envelope helper's success path: this
 * returns binary. `withApi` still provides the error envelope, auth plumbing
 * and rate limiting.
 */
export const GET = withApi(
  async (req: NextRequest) => {
    const actor = await requirePermission(Permission.ORDER_VIEW_OWN);
    const query = listOrdersQuerySchema.parse(
      Object.fromEntries(req.nextUrl.searchParams),
    );
    const ctx = await getRequestContext();

    const result = await buildOrderChargeExport(query, { actor, request: ctx });

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
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
  { rateLimit: { route: "order-export", max: 10, windowMs: 60_000 } },
);
