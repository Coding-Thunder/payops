import type { NextRequest } from "next/server";

import { getAdminEmail } from "@/server/auth/session";
import { listOrdersForExport, type OrderRow } from "@/server/services/orders";
import { jsonError } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = [
  "id",
  "orderNumber",
  "customerName",
  "customerEmail",
  "amount",
  "currency",
  "status",
  "paid",
  "gateway",
  "refundedAmount",
  "org",
  "createdAt",
  "paidAt",
] as const;

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET(req: NextRequest) {
  const admin = await getAdminEmail();
  if (!admin) return jsonError(401, "Unauthorized");

  const sp = new URL(req.url).searchParams;
  const rows = await listOrdersForExport({
    status: sp.get("status") ?? undefined,
    gateway: sp.get("gateway") ?? undefined,
    paid: sp.get("paid") ?? undefined,
    q: sp.get("q") ?? undefined,
    org: sp.get("org") ?? undefined,
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    sort: sp.get("sort") ?? undefined,
  });

  const body = [
    HEADERS.join(","),
    ...rows.map((r: OrderRow) =>
      HEADERS.map((h) => csvCell(r[h as keyof OrderRow])).join(","),
    ),
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="orders.csv"',
      "Cache-Control": "no-store",
    },
  });
}
