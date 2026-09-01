import { NextResponse, type NextRequest } from "next/server";

import { PaymentGatewayKey, RecordState } from "@/lib/constants/enums";
import { logger } from "@/lib/logger";
import { Organization } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { handleStripeWebhook } from "@/server/api/stripe-webhook";
import { runWithOrganization } from "@/server/auth/organization";
import { getGatewayForOrganization } from "@/server/payments/resolve-gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ orgSlug: string }>;
}

/**
 * Per-organization Stripe webhook endpoint.
 *
 * ═══ WHY THE TENANT MUST BE IN THE URL ═══════════════════════════════════
 *
 * A Stripe signature can only be verified with the signing secret of the
 * account that produced it, and the payload must NOT be parsed before
 * verification succeeds. So the tenant cannot be derived from the event —
 * it has to be in the path. Two merchant accounts pointing at one shared
 * `/api/webhooks/stripe` would mean every delivery is verified against
 * whichever secret the deployment happens to resolve, and one brand's
 * events would fail verification forever while its customers' cards had
 * already been charged.
 *
 * ═══ WHAT HIMANSHU KEEPS ════════════════════════════════════════════════
 *
 * The DEFAULT organization keeps using `/api/webhooks/stripe`, unchanged.
 * Its Stripe dashboard configuration is live and must not be touched to
 * make this feature work. New tenants — RCR Cruise — point their own Stripe
 * account at `/api/webhooks/stripe/<their-slug>`.
 *
 * ═══ SECURITY PROPERTIES ════════════════════════════════════════════════
 *
 *   - The slug selects WHICH SECRET to verify against, and nothing else. It
 *     grants no access on its own; an event signed with the wrong account's
 *     key fails verification exactly as an unsigned one would. A slug is
 *     therefore safe in a URL and knowing one buys an attacker nothing.
 *   - An unknown, disabled, or unconfigured organization returns a flat 404,
 *     so the endpoint is not an oracle for which brands exist here.
 *   - THE PROVIDER IS DECIDED BY THE ENDPOINT, NEVER BY CONFIGURATION. This
 *     route pins STRIPE explicitly rather than asking the organization which
 *     provider it defaults to — resolving by default on a deployment that
 *     offers both would hand a genuine Stripe delivery the PayPal adapter,
 *     fail verification, and leave the order unpaid forever.
 *   - Downstream, `findOrderForEndpoint` refuses to touch an order belonging
 *     to a different organization, so even a correctly-signed event cannot
 *     settle another brand's booking.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { orgSlug } = await params;

  await connectMongo();
  const org = await Organization.findOne({
    slug: orgSlug.toLowerCase(),
    status: RecordState.ACTIVE,
  })
    .select("_id slug isDefault")
    .lean<{ _id: unknown; slug: string; isDefault?: boolean } | null>();

  if (!org) {
    logger.warn("stripe.webhook.unknown_organization", { orgSlug });
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Unknown endpoint" } },
      { status: 404 },
    );
  }

  const organizationId = String(org._id);
  const isDefault = Boolean(org.isDefault);

  let gateway;
  try {
    gateway = await getGatewayForOrganization(organizationId, {
      kind: "pinned",
      provider: PaymentGatewayKey.STRIPE,
    });
  } catch (err) {
    // The organization exists but has no usable Stripe credentials. Same
    // flat 404 as an unknown slug — a distinguishable response would reveal
    // which brands are configured.
    logger.error("stripe.webhook.gateway_unavailable", {
      orgSlug,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Unknown endpoint" } },
      { status: 404 },
    );
  }

  // Pin the tenant for everything this delivery writes — audit rows,
  // evidence rows, outbox entries. Without it they would be attributed to
  // whatever the ambient resolver guessed, which for a webhook is nothing.
  return runWithOrganization({ organizationId, isDefault }, () =>
    handleStripeWebhook(req, gateway, organizationId, org.slug, isDefault),
  );
}
