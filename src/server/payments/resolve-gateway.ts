import "server-only";

import { Types } from "mongoose";

import { PaymentGatewayKey } from "@/lib/constants/enums";
import { env } from "@/lib/env";
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
import { createPayPalGateway } from "./gateways/paypal";
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
/**
 * The provider is understood, but this deployment has not switched it on.
 *
 * Deliberately distinct from PaymentProviderNotConfiguredError: "we do not
 * offer PayPal yet" and "PayPal is offered but its keys are missing" are
 * different operational problems with different fixes, and an operator who
 * cannot tell them apart will go looking for credentials that were never
 * supposed to exist.
 */
export class PaymentProviderNotEnabledError extends ConflictError {
  constructor(provider: string, enabled: readonly string[]) {
    super(
      `${provider} is not enabled on this deployment. Enabled provider(s): ${
        enabled.join(", ") || "none"
      }.`,
    );
    this.name = "PaymentProviderNotEnabledError";
  }
}

export class PaymentProviderNotConfiguredError extends ConflictError {
  constructor(brand: string, provider: string) {
    super(
      `${brand} has no ${provider} credentials configured. Add them in organization settings before generating a payment link.`,
    );
    this.name = "PaymentProviderNotConfiguredError";
  }
}

type OrgPaymentConfig = Pick<
  OrganizationDoc,
  "slug" | "brandName" | "isDefault"
> & {
  payments: OrganizationDoc["payments"];
};

async function loadOrg(organizationId: string): Promise<OrgPaymentConfig | null> {
  if (!Types.ObjectId.isValid(organizationId)) return null;
  await connectMongo();
  return Organization.findById(organizationId)
    .select("slug brandName isDefault payments")
    .lean<OrgPaymentConfig | null>();
}

/**
 * Per-organization credentials from the ENVIRONMENT.
 *
 * `ORG_<SLUG>_STRIPE_SECRET_KEY`, `ORG_<SLUG>_PAYPAL_CLIENT_SECRET`, and so
 * on — slug uppercased with non-alphanumerics as underscores, so
 * `tripreservations` reads `ORG_TRIPRESERVATIONS_PAYPAL_CLIENT_SECRET`.
 *
 * This is the primary path, ahead of the encrypted vault, and it exists
 * because this deployment is operated by one person: adding a brand should
 * be editing a env file and redeploying, not building a credential-entry UI
 * and storing ciphertext in Mongo. The vault stays in place underneath for
 * whenever that stops being true — nothing has to be migrated to switch,
 * since env simply wins when present.
 *
 * Env vars are already the deployment's secret channel (DigitalOcean holds
 * them, they are never in git), so this adds no new exposure.
 */
function envKey(slug: string, suffix: string): string {
  return `ORG_${slug.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${suffix}`;
}

function fromEnv(slug: string, suffix: string): string | null {
  const v = process.env[envKey(slug, suffix)];
  return v && v.trim() ? v.trim() : null;
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

/* ─────────────────────── provider selection ─────────────────────────── */

/**
 * How the caller arrived at a provider — and it changes the rules.
 *
 * `requested` is an operator or a client asking for one on a NEW session. It
 * is a request, not an instruction: it is honoured only if the deployment has
 * that provider enabled, and refused otherwise.
 *
 * `pinned` is the provider already recorded on an existing order. It is
 * AUTHORITATIVE. It is never traded for a different one, because the session,
 * the webhook that will settle it and the money all live in that provider's
 * merchant account. If a pinned provider is not enabled the correct answer is
 * a clear failure, never a substitution.
 *
 * These two were one `providerOverride` argument, and both were silently
 * swapped for the organization's configured provider when they fell outside
 * the enabled set. That is harmless only while every organization has exactly
 * one gateway. The moment a deployment offers two, it means an order pinned to
 * PayPal can be handed a Stripe session and have `payment.gateway` rewritten
 * underneath it.
 */
export type ProviderSelection =
  | { kind: "requested"; provider: PaymentGatewayKey | null }
  | { kind: "pinned"; provider: PaymentGatewayKey };

/** Providers this codebase has a real, non-placeholder implementation for. */
const SUPPORTED: readonly PaymentGatewayKey[] = [
  PaymentGatewayKey.STRIPE,
  PaymentGatewayKey.PAYPAL,
];

function normaliseSelection(
  input?: ProviderSelection | PaymentGatewayKey | null,
): ProviderSelection {
  if (!input) return { kind: "requested", provider: null };
  if (typeof input === "string") return { kind: "requested", provider: input };
  return input;
}

/**
 * Refuse a key with no implementation behind it before anything else looks at
 * it. RAZORPAY / AUTHORIZE_NET / MANUAL are enum placeholders whose registry
 * entries throw on every operation; reaching one means a bad request got
 * further than it should have.
 */
function assertSupported(provider: PaymentGatewayKey): void {
  if (!SUPPORTED.includes(provider)) {
    throw new PaymentProviderNotEnabledError(provider, SUPPORTED);
  }
}

/** The providers this organization is actually switched on for. */
export function enabledProvidersOf(org: {
  payments?: { provider?: PaymentGatewayKey; enabledProviders?: PaymentGatewayKey[] } | null;
}): PaymentGatewayKey[] {
  const configured = org.payments?.provider ?? PaymentGatewayKey.STRIPE;
  const listed = org.payments?.enabledProviders ?? [];
  // An empty list still falls back to the configured provider so an
  // unmigrated document keeps working, but the seed now writes the list
  // explicitly — relying on "empty means Stripe" is how PayPal became
  // unreachable from the UI on a freshly seeded organization.
  const enabled = listed.length > 0 ? listed : [configured];
  return enabled.filter((p) => SUPPORTED.includes(p));
}

function selectProvider(
  org: OrgPaymentConfig,
  sel: ProviderSelection,
): PaymentGatewayKey {
  const enabled = enabledProvidersOf(org);

  if (sel.kind === "pinned") {
    assertSupported(sel.provider);
    // Authoritative. Not enabled is a hard failure, never a substitution.
    if (!enabled.includes(sel.provider)) {
      throw new PaymentProviderNotEnabledError(sel.provider, enabled);
    }
    return sel.provider;
  }

  if (sel.provider) {
    assertSupported(sel.provider);
    if (!enabled.includes(sel.provider)) {
      throw new PaymentProviderNotEnabledError(sel.provider, enabled);
    }
    return sel.provider;
  }

  // No preference expressed — the organization's own default, which must
  // itself be enabled.
  const configured = org.payments?.provider ?? PaymentGatewayKey.STRIPE;
  if (!enabled.includes(configured)) {
    throw new PaymentProviderNotEnabledError(configured, enabled);
  }
  return configured;
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
  selection?: ProviderSelection | PaymentGatewayKey | null,
): Promise<PaymentGateway> {
  const sel = normaliseSelection(selection);

  if (!organizationId) {
    // No organization to consult. Only an explicit choice can select
    // anything, and an unsupported key is still refused.
    if (sel.provider) {
      assertSupported(sel.provider);
      return getGateway(sel.provider);
    }
    return getDefaultGateway();
  }

  const org = await loadOrg(organizationId);
  if (!org) {
    if (sel.provider) {
      assertSupported(sel.provider);
      return getGateway(sel.provider);
    }
    return getDefaultGateway();
  }

  const provider = selectProvider(org, sel);

  if (provider === PaymentGatewayKey.STRIPE) {
    // Env first, vault second. See fromEnv() above for why.
    const [vaultKey, vaultHook] = await Promise.all([
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
    const secretKey = fromEnv(org.slug, "STRIPE_SECRET_KEY") ?? vaultKey;
    const webhookSecret =
      fromEnv(org.slug, "STRIPE_WEBHOOK_SECRET") ?? vaultHook;

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

  if (provider === PaymentGatewayKey.PAYPAL) {
    const clientSecret =
      fromEnv(org.slug, "PAYPAL_CLIENT_SECRET") ??
      (await getSecret({
        organizationId,
        provider: CredentialProvider.PAYPAL,
        field: CredentialField.CLIENT_SECRET,
      }));
    // `payments.publishableKey` is a single field documented as
    // "publishable / client id", and the seed always writes the STRIPE
    // publishable key into it (seed-organizations.ts). For an organization
    // running both gateways it therefore holds a `pk_live_…`, and using that
    // as a PayPal client id makes the `clientId && …` guard below pass with
    // a Stripe key. PayPal then answers 401 from its OAuth endpoint, which
    // reads as "PayPal is broken" instead of "PayPal is not configured".
    //
    // Accept the field only when it is not recognisably a Stripe key, so a
    // PayPal-only organization that legitimately stored its client id there
    // keeps working.
    const sharedPublicId = org.payments?.publishableKey?.trim() ?? "";
    const publicIdIsStripeKey = /^(pk_|sk_|rk_)/.test(sharedPublicId);
    const clientId =
      fromEnv(org.slug, "PAYPAL_CLIENT_ID") ??
      (publicIdIsStripeKey ? "" : sharedPublicId);
    const webhookId = fromEnv(org.slug, "PAYPAL_WEBHOOK_ID") ?? "";

    if (clientId && clientSecret && webhookId) {
      // PayPal is LIVE-ONLY on this deployment. There is no environment to
      // select: the adapter has a single host and no sandbox constant, so
      // neither an env var nor the organization's Stripe-derived
      // `payments.sandbox` flag can reach it. The Stripe-key coupling that
      // once silently moved PayPal to api-m.sandbox.paypal.com is gone with
      // the switch itself.
      return createPayPalGateway(() => ({
        clientId,
        clientSecret,
        webhookId,
      }));
    }

    // DEPLOYMENT-LEVEL FALLBACK, for the DEFAULT organization only —
    // exactly the rule the Stripe branch above applies, and it exists for
    // the same reason.
    //
    // A single-tenant deployment has one organization, which the seed marks
    // default, and that organization's credentials ARE the deployment's.
    // Without this, PayPal was reachable only through
    // `ORG_<SLUG>_PAYPAL_*`, so standing up one live PayPal account meant
    // inventing a per-organization credential namespace for a deployment
    // that has no second organization to distinguish it from — and silently
    // coupling the secret's name to a slug, where a slug rename breaks
    // payments with no error until someone tries to pay.
    //
    // The default-only restriction is the whole safety story, unchanged: a
    // SECOND organization must never reach these, because falling back would
    // take its money through the deployment's PayPal merchant account.
    //
    // All three values are required together. A partial set falls through to
    // the refusal below rather than half-configuring a gateway, mirroring the
    // Stripe branch's reasoning — a client id paired with the wrong webhook
    // id fails at webhook time, long after the money moved.
    const envClientId = env.server.PAYPAL_CLIENT_ID?.trim() ?? "";
    const envClientSecret = env.server.PAYPAL_CLIENT_SECRET?.trim() ?? "";
    const envWebhookId = env.server.PAYPAL_WEBHOOK_ID?.trim() ?? "";

    if (org.isDefault) {
      if (envClientId && envClientSecret && envWebhookId) {
        logger.info("payments.gateway.env_fallback", {
          organizationId,
          provider,
          reason: "default organization using deployment PayPal credentials",
        });
        return createPayPalGateway(() => ({
          clientId: envClientId,
          clientSecret: envClientSecret,
          webhookId: envWebhookId,
        }));
      }
    }

    // Refuse rather than charge through another brand's merchant account,
    // or run a half-configured gateway.
    // Report BOTH candidate sources. Logging only the organization-level
    // values said "hasClientId: false" even when the real problem was a
    // deployment set missing exactly one variable, which sends an operator
    // looking in the wrong place.
    logger.error("payments.gateway.not_configured", {
      organizationId,
      brandName: org.brandName,
      provider,
      isDefaultOrganization: org.isDefault,
      // ORG_<SLUG>_PAYPAL_* / vault / organization document
      hasClientId: Boolean(clientId),
      hasClientSecret: Boolean(clientSecret),
      hasWebhookId: Boolean(webhookId),
      // deployment-level PAYPAL_*, only consulted for the default org
      deploymentHasClientId: Boolean(envClientId),
      deploymentHasClientSecret: Boolean(envClientSecret),
      deploymentHasWebhookId: Boolean(envWebhookId),
    });
    throw new PaymentProviderNotConfiguredError(org.brandName, "PayPal");
  }

  // Remaining providers come from the registry. Placeholder entries throw
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
