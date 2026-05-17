import { UnauthorizedError } from "@/lib/errors";
import { jsonOk, withApi } from "@/server/api/respond";
import { getCurrentUser } from "@/server/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi(async () => {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return jsonOk(user);
});
