export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness probe for DigitalOcean App Platform.
 *
 * Deliberately dependency-free: no DB, no env read, no auth. It returns
 * 200 the moment the server process accepts connections, so a slow or
 * unreachable MongoDB can never flap the health check and trigger a
 * rollback. The admin console has no background keep-alive need (only an
 * in-process OTP limiter), so this is pure liveness.
 *
 * There is no proxy/middleware in this app, and this route sits outside
 * the (protected) group, so it is reachable without an admin session —
 * which is exactly what the platform health checker needs.
 */
export function GET() {
  return Response.json({ ok: true, service: "tracetxn-admin" });
}
