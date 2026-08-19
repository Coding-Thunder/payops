import type { NextRequest } from "next/server";

import { getAdminEmail } from "@/console/server/auth/session";
import { listEmailsForExport, type EmailRow } from "@/console/server/services/email-ops";
import { csvCell, jsonError } from "@/console/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = [
  "id",
  "kind",
  "recipient",
  "status",
  "attempts",
  "lastError",
  "orderId",
  "createdAt",
  "nextAttemptAt",
  "sentAt",
] as const;

export async function GET(req: NextRequest) {
  const admin = await getAdminEmail();
  if (!admin) return jsonError(401, "UNAUTHORIZED", "Unauthorized");

  const sp = new URL(req.url).searchParams;
  const rows = await listEmailsForExport({
    status: sp.get("status") ?? undefined,
    kind: sp.get("kind") ?? undefined,
    q: sp.get("q") ?? undefined,
    sort: sp.get("sort") ?? undefined,
  });

  const body = [
    HEADERS.join(","),
    ...rows.map((r: EmailRow) =>
      HEADERS.map((h) => csvCell(r[h as keyof EmailRow])).join(","),
    ),
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="email-ops.csv"',
      "Cache-Control": "no-store",
    },
  });
}
