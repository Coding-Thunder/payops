import { clearAdminCookie } from "@/console/server/auth/session";
import { assertSameOrigin, jsonOk } from "@/console/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  await clearAdminCookie();
  return jsonOk({ ok: true });
}
