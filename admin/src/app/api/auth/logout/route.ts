import { clearAdminCookie } from "@/server/auth/session";
import { jsonOk } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  await clearAdminCookie();
  return jsonOk({ ok: true });
}
