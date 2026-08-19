import type { NextRequest } from "next/server";
import { z } from "zod";

import { getAdminEmail } from "@/console/server/auth/session";
import { assertSameOrigin, clientIp, jsonError, jsonOk } from "@/console/server/http";
import { rateLimit } from "@/console/server/rate-limit";
import { addAdmin } from "@/console/server/services/admins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


const addSchema = z.object({
  email: z.string().email("A valid email is required"),
  name: z.string().trim().min(1, "A name is required").max(120),
  role: z.enum(["OWNER", "ADMIN"]).optional(),
});

export async function POST(req: NextRequest) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const actor = await getAdminEmail();
  if (!actor) return jsonError(401, "UNAUTHORIZED", "Not signed in");

  const ip = clientIp(req);
  if (!rateLimit(`admin-add:${actor}`, 20, 60 * 60_000)) {
    return jsonError(429, "RATE_LIMITED", "Too many requests. Try again later.");
  }

  const body = await req.json().catch(() => ({}));
  const parsed = addSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(422, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input");
  }

  try {
    const admin = await addAdmin(parsed.data, actor, ip);
    return jsonOk({ admin });
  } catch (err) {
    return jsonError(400, "BAD_REQUEST", err instanceof Error ? err.message : "Couldn't add admin");
  }
}
