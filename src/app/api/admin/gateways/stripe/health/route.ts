import { Permission } from "@/lib/constants/permissions";
import { env } from "@/lib/env";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { probeStripeWebhookForOrg } from "@/server/payments/gateway-credentials.service";
import { TRACETXN_STRIPE_EVENTS } from "@/server/payments/stripe-onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/gateways/stripe/health
 *
 * Operator-facing diagnostic: hits the connected Stripe account, finds
 * our webhook endpoint, diffs subscribed events against the canonical
 * required-events list. Returns a structured report the admin UI
 * renders verbatim (status pill + missing-events checklist + repair CTA).
 *
 * Returns the full list of REQUIRED events so the UI doesn't have to
 * import them itself, keeps the canonical list server-owned.
 *
 * Gated by GATEWAY_MANAGE (SUPER_ADMIN-only), same guardrail as
 * connect/disable; webhook health probes the saved secret key.
 */
export const GET = withApi(async () => {
  const actor = await requirePermission(Permission.GATEWAY_MANAGE);
  if (!actor.orgId) {
    throw new Error("Your account is not attached to an organization.");
  }
  const probe = await probeStripeWebhookForOrg({
    orgId: actor.orgId,
    appUrl: env.server.APP_URL,
  });

  if (!probe.ok) {
    return jsonOk({
      configured: false,
      requiredEvents: [...TRACETXN_STRIPE_EVENTS],
    });
  }

  return jsonOk({
    configured: true,
    requiredEvents: [...TRACETXN_STRIPE_EVENTS],
    report: probe.report,
  });
});
