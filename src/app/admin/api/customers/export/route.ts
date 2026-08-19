import type { NextRequest } from "next/server";

import { getAdminEmail } from "@/console/server/auth/session";
import {
  listCustomersForExport,
  type CustomerRow,
} from "@/console/server/services/customers";
import { csvCell, jsonError } from "@/console/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = [
  "id",
  "name",
  "email",
  "phone",
  "company",
  "tags",
  "ordersCount",
  "org",
  "lastOrderAt",
  "createdAt",
] as const;

export async function GET(req: NextRequest) {
  const admin = await getAdminEmail();
  if (!admin) return jsonError(401, "UNAUTHORIZED", "Unauthorized");

  const sp = new URL(req.url).searchParams;
  const rows = await listCustomersForExport({
    q: sp.get("q") ?? undefined,
    org: sp.get("org") ?? undefined,
    hasOrders: sp.get("hasOrders") ?? undefined,
    tag: sp.get("tag") ?? undefined,
    sort: sp.get("sort") ?? undefined,
  });

  const body = [
    HEADERS.join(","),
    ...rows.map((r: CustomerRow) =>
      HEADERS.map((h) => csvCell(r[h as keyof CustomerRow])).join(","),
    ),
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="customers.csv"',
      "Cache-Control": "no-store",
    },
  });
}
