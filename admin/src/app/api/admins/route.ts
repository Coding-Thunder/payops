import type { NextRequest } from "next/server";
import { z } from "zod";

import { getAdminEmail } from "@/server/auth/session";
import { assertSameOrigin, clientIp, jsonError, jsonOk } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { addAdmin, listAdmins } from "@/server/services/admins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await getAdminEmail();
  if (!actor) return jsonError(401, "Not signed in");
  const admins = await listAdmins();
  return jsonOk({ admins });
}

const addSchema = z.object({
  email: z.string().email("A valid email is required"),
  name: z.string().trim().min(1, "A name is required").max(120),
  role: z.enum(["OWNER", "ADMIN"]).optional(),
});

export async function POST(req: NextRequest) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const actor = await getAdminEmail();
  if (!actor) return jsonError(401, "Not signed in");

  const ip = clientIp(req);
  if (!rateLimit(`admin-add:${actor}`, 20, 60 * 60_000)) {
    return jsonError(429, "Too many requests. Try again later.");
  }

  const body = await req.json().catch(() => ({}));
  const parsed = addSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(422, parsed.error.issues[0]?.message ?? "Invalid input");
  }

  try {
    const admin = await addAdmin(parsed.data, actor, ip);
    return jsonOk({ admin });
  } catch (err) {
    return jsonError(400, err instanceof Error ? err.message : "Couldn't add admin");
  }
}
