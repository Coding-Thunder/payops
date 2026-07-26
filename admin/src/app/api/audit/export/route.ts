import type { NextRequest } from "next/server";

import { getAdminEmail } from "@/server/auth/session";
import {
  listAuditForExport,
  normalizeSource,
  type AuditRow,
} from "@/server/services/audit-center";
import { csvCell, jsonError } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = [
  "id",
  "source",
  "action",
  "actor",
  "entity",
  "org",
  "ip",
  "createdAt",
] as const;

export async function GET(req: NextRequest) {
  const admin = await getAdminEmail();
  if (!admin) return jsonError(401, "Unauthorized");

  const sp = new URL(req.url).searchParams;
  const source = normalizeSource(sp.get("source") ?? undefined);
  const rows = await listAuditForExport(source, {
    action: sp.get("action") ?? undefined,
    actor: sp.get("actor") ?? undefined,
    type: sp.get("type") ?? undefined,
    id: sp.get("id") ?? undefined,
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
  });

  const body = [
    HEADERS.join(","),
    ...rows.map((r: AuditRow) =>
      HEADERS.map((h) => csvCell(r[h as keyof AuditRow])).join(","),
    ),
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-${source}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
