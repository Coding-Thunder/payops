import { NextResponse, type NextRequest } from "next/server";

import { resetPasswordSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { completePasswordReset } from "@/server/services/password-reset.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Complete a password reset by exchanging an HMAC-signed token for a
 * new password. The token auto-invalidates once the password changes
 * (see `password-reset.service`) so a replayed link can't undo the
 * change after the fact.
 *
 * No session cookie is set, the caller must log in fresh with the
 * new password. That's deliberate: a "set new password AND log in
 * the same browser session" flow makes it harder to detect a
 * compromised token mid-flight, since the attacker would already
 * be inside.
 */
export const POST = withApi(
  async (req: NextRequest) => {
    const body = await req.json();
    const input = resetPasswordSchema.parse(body);
    const ctx = await getRequestContext();
    await completePasswordReset(input.token, input.newPassword, {
      request: ctx,
    });
    return jsonOk({ reset: true }) as NextResponse;
  },
  {
    rateLimit: { route: "auth-reset-password", max: 10, windowMs: 15 * 60_000 },
    bodyLimitBytes: 4 * 1024,
  },
);
