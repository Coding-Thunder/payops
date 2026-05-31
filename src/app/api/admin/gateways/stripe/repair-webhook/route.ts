import { Permission } from "@/lib/constants/permissions";
import { env } from "@/lib/env";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { repairStripeWebhookForOrg } from "@/server/payments/gateway-credentials.service";
import { TRACETXN_STRIPE_EVENTS } from "@/server/payments/stripe-onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/gateways/stripe/repair-webhook
 *
 * Idempotent: backfills the canonical `TRACETXN_STRIPE_EVENTS` list
 * onto the org's existing Stripe webhook endpoint. Doesn't change the
 * endpoint id or signing secret — our stored webhookSecret still
 * verifies signatures after this call.
 *
 * Surfaced by the admin gateways page when the health probe reports
 * `missing_events`. Re-running has no effect after the first successful
 * repair (Stripe accepts the full event list as the new value of
 * enabled_events; no extra side-effects).
 */
export const POST = withApi(async () => {
  const actor = await requirePermission(Permission.GATEWAY_MANAGE);
  if (!actor.orgId) {
    throw new Error("Your account is not attached to an organization.");
  }
  const result = await repairStripeWebhookForOrg({
    orgId: actor.orgId,
    appUrl: env.server.APP_URL,
  });
  if (!result.ok) {
    if (result.reason === "no_credential") {
      throw new ValidationError(
        "No Stripe credential configured. Connect Stripe first, then re-run repair.",
      );
    }
    // no_endpoint — credential exists but Stripe has no webhook for us
    throw new NotFoundError(
      "No Stripe webhook endpoint is registered for this workspace yet. Re-connect Stripe to register one.",
    );
  }
  return jsonOk({
    subscribedEvents: result.subscribedEvents,
    requiredEvents: [...TRACETXN_STRIPE_EVENTS],
  });
});
