import { NextResponse, type NextRequest } from "next/server";

import { PaymentGatewayKey, RecordState } from "@/lib/constants/enums";
import { logger } from "@/lib/logger";
import { Organization } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { handleStripeWebhook } from "@/server/api/stripe-webhook";
import { getGatewayForOrganization } from "@/server/payments/resolve-gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ orgSlug: string }>;
}

/**
 * Per-organization Stripe webhook endpoint.
 *
 * Each organization points its own Stripe account at its own path and signs
 * with its own secret. That is not a stylistic choice: a Stripe signature
 * can only be verified with the signing secret of the account that produced
 * it, and the payload must not be parsed before verification succeeds — so
 * the tenant cannot be derived from the event itself. It has to be in the
 * URL.
 *
 * Security properties:
 *   - the slug selects WHICH SECRET to verify against, and nothing else. It
 *     grants no access on its own; an event signed with the wrong account's
 *     key fails verification exactly as an unsigned one would.
 *   - a slug is therefore safe to expose in a URL, and knowing one buys an
 *     attacker nothing.
 *   - an unknown, disabled, or unconfigured organization — or one with no
 *     Stripe enabled — returns 404 with a flat message, so the endpoint is
 *     not an oracle for which brands exist on this deployment.
 *
 * The default organization keeps using /api/webhooks/stripe. It could use
 * this path too once its credentials live in the vault, but its existing
 * Stripe dashboard configuration must not be disturbed to make that true.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { orgSlug } = await params;

  await connectMongo();
  const org = await Organization.findOne({
    slug: orgSlug.toLowerCase(),
    status: RecordState.ACTIVE,
  })
    .select("_id slug")
    .lean<{ _id: unknown; slug: string } | null>();

  if (!org) {
    logger.warn("stripe.webhook.unknown_organization", { orgSlug });
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Unknown endpoint" } },
      { status: 404 },
    );
  }

  let gateway;
  try {
    // This endpoint serves Stripe and nothing else, so it asks for the
    // organization's STRIPE gateway — not its default. A brand that takes
    // PayPal by default and Stripe as a second enabled provider signs its
    // Stripe events with its own Stripe secret, and verifying them with its
    // default (PayPal) gateway rejected every one. The override is honoured
    // only for an ENABLED provider, so a single-provider brand resolves
    // exactly what it always did.
    gateway = await getGatewayForOrganization(
      String(org._id),
      PaymentGatewayKey.STRIPE,
    );
  } catch (err) {
    // The organization exists but has no usable credentials. Same flat 404
    // as an unknown slug — a distinguishable response would reveal which
    // brands are configured.
    logger.error("stripe.webhook.gateway_unavailable", {
      orgSlug,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Unknown endpoint" } },
      { status: 404 },
    );
  }

  if (gateway.key !== PaymentGatewayKey.STRIPE) {
    // The organization has no Stripe enabled; a Stripe delivery here is a
    // misconfiguration, not a valid event — the same flat 404, as the
    // PayPal endpoint answers a brand without PayPal.
    logger.warn("stripe.webhook.provider_mismatch", {
      orgSlug,
      configured: gateway.key,
    });
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Unknown endpoint" } },
      { status: 404 },
    );
  }

  return handleStripeWebhook(req, gateway, String(org._id), org.slug);
}
