import "server-only";

import { Types } from "mongoose";

import { PaymentGatewayKey } from "@/lib/constants/enums";
import { ConflictError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  CredentialField,
  CredentialProvider,
  Organization,
  type OrganizationDoc,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { getSecret } from "@/server/services/organization-credential.service";

import type { PaymentGateway } from "./gateway";
import { getDefaultGateway, getGateway } from "./gateways";
import {
  createStripeGateway,
  type StripeCredentials,
} from "./gateways/stripe";

/**
 * Choosing which payment gateway an order is created on.
 *
 * The provider comes from the organization's configuration, never from a
 * brand-name check. Its credentials come from the encrypted vault, never
 * from a plaintext field on the organization document.
 *
 * THE FALLBACK RULE, which is the whole safety story here:
 *
 *   the DEFAULT organization falls back to the deployment's env
 *   credentials when it has none stored. That is what keeps
 *   RentalConfirmation byte-identical through this migration — it is
 *   already running on STRIPE_SECRET_KEY and continues to, with the same
 *   client and the same outgoing session arguments, until someone
 *   deliberately moves those keys into the vault.
 *
 *   every OTHER organization must FAIL when its credentials are missing.
 *   Falling back would mean a second brand quietly taking payments through
 *   the first brand's Stripe account: money landing in the wrong bank
 *   account, refunds and disputes surfacing against the wrong merchant, and
 *   nothing in the UI to indicate it. A hard, loud error at link-generation
 *   time is enormously preferable to a silent mis-charge.
 *
 * The failure is raised at session creation, not at boot, so a
 * half-configured organization cannot take the deployment down for anyone
 * else.
 */

/**
 * Extends ConflictError (409) rather than plain Error on purpose.
 *
 * `withApi`'s handler maps thrown errors via `isAppError`, which is a bare
 * `instanceof AppError`. A duck-typed error carrying its own `statusCode`
 * and `code` does NOT satisfy that — it falls through to the catch-all and
 * the operator gets `500 Something went wrong`, with no hint that the fix is
 * "add your Stripe keys". 409 is the right shape too: nothing upstream
 * failed, the organization's own configuration is incomplete. (PaymentError
 * would be wrong — that is 502, i.e. the gateway itself misbehaved.)
 */
export class PaymentProviderNotConfiguredError extends ConflictError {
  constructor(brand: string, provider: string) {
    super(
      `${brand} has no ${provider} credentials configured. Add them in organization settings before generating a payment link.`,
    );
    this.name = "PaymentProviderNotConfiguredError";
  }
}

type OrgPaymentConfig = Pick<OrganizationDoc, "brandName" | "isDefault"> & {
  payments: OrganizationDoc["payments"];
};

async function loadOrg(organizationId: string): Promise<OrgPaymentConfig | null> {
  if (!Types.ObjectId.isValid(organizationId)) return null;
  await connectMongo();
  return Organization.findById(organizationId)
    .select("brandName isDefault payments")
    .lean<OrgPaymentConfig | null>();
}

/**
 * An organization's stored Stripe credentials, or null when it has none.
 *
 * Returns null for a PARTIAL pair rather than half a configuration — a live
 * key paired with the wrong signing secret fails at webhook time, long after
 * the money moved, which is a far worse failure than refusing up front.
 */
export async function getStripeCredentialsForOrganization(
  organizationId: string,
): Promise<StripeCredentials | null> {
  const [secretKey, webhookSecret] = await Promise.all([
    getSecret({
      organizationId,
      provider: CredentialProvider.STRIPE,
      field: CredentialField.SECRET_KEY,
    }),
    getSecret({
      organizationId,
      provider: CredentialProvider.STRIPE,
      field: CredentialField.WEBHOOK_SECRET,
    }),
  ]);
  if (!secretKey || !webhookSecret) return null;
  return { secretKey, webhookSecret };
}

/**
 * The gateway an organization's payments run on.
 *
 * `organizationId` of null means an unmigrated deployment or a request with
 * no selected organization — both resolve to today's default gateway, so
 * nothing changes for a deployment that has not adopted organizations.
 */
export async function getGatewayForOrganization(
  organizationId: string | null,
  /**
   * Force a specific provider — used when an order is already pinned to one,
   * or an operator picked one explicitly.
   *
   * This selects the PROVIDER ONLY. Credentials are still resolved from the
   * organization. Keeping those two separate is the entire point: an earlier
   * version of this function short-circuited to the registry singleton
   * whenever a provider was supplied, and because the email composer sends
   * `gateway: "STRIPE"` on every single "Generate Payment Link" click, the
   * per-organization path would never have executed in production — every
   * brand would have charged through the deployment's Stripe account.
   */
  providerOverride?: PaymentGatewayKey | null,
): Promise<PaymentGateway> {
  if (!organizationId) {
    return providerOverride ? getGateway(providerOverride) : getDefaultGateway();
  }

  const org = await loadOrg(organizationId);
  if (!org) {
    return providerOverride ? getGateway(providerOverride) : getDefaultGateway();
  }

  const provider =
    providerOverride ?? org.payments?.provider ?? PaymentGatewayKey.STRIPE;

  if (provider === PaymentGatewayKey.STRIPE) {
    const [secretKey, webhookSecret] = await Promise.all([
      getSecret({
        organizationId,
        provider: CredentialProvider.STRIPE,
        field: CredentialField.SECRET_KEY,
      }),
      getSecret({
        organizationId,
        provider: CredentialProvider.STRIPE,
        field: CredentialField.WEBHOOK_SECRET,
      }),
    ]);

    if (secretKey && webhookSecret) {
      // Captured by value, so this gateway is permanently bound to THIS
      // organization's credentials and cannot be re-pointed later.
      return createStripeGateway(() => ({ secretKey, webhookSecret }));
    }

    if (org.isDefault) {
      // Expected during the migration: the incumbent brand is still on env
      // credentials and behaves exactly as it did before.
      //
      // Note a PARTIALLY configured default organization also lands here and
      // falls back for BOTH values rather than mixing one stored secret with
      // one env secret — a half-and-half pair would be a live key with the
      // wrong signing secret, which fails confusingly at webhook time
      // instead of at configuration time. The log distinguishes the two
      // cases so the state is diagnosable.
      logger.info("payments.gateway.env_fallback", {
        organizationId,
        provider,
        reason:
          secretKey || webhookSecret
            ? "default organization has INCOMPLETE stored credentials — using env for both"
            : "default organization has no stored credentials",
        hasSecretKey: Boolean(secretKey),
        hasWebhookSecret: Boolean(webhookSecret),
      });
      return getDefaultGateway();
    }

    // Refuse rather than charge through another brand's merchant account.
    logger.error("payments.gateway.not_configured", {
      organizationId,
      brandName: org.brandName,
      provider,
      hasSecretKey: Boolean(secretKey),
      hasWebhookSecret: Boolean(webhookSecret),
    });
    throw new PaymentProviderNotConfiguredError(org.brandName, "Stripe");
  }

  // Non-Stripe providers come from the registry. Placeholder entries throw
  // on use, which is the correct outcome until one is implemented.
  const gateway = getGateway(provider);
  if (!gateway.enabled) {
    logger.error("payments.gateway.not_configured", {
      organizationId,
      brandName: org.brandName,
      provider,
      reason: "provider not implemented or missing credentials",
    });
    throw new PaymentProviderNotConfiguredError(org.brandName, gateway.label);
  }
  return gateway;
}
