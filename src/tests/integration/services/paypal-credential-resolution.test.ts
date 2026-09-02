import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PaymentGatewayKey } from "@/lib/constants/enums";
import { _resetEnvCacheForTests } from "@/lib/env";
import { Organization } from "@/server/db/models";
import { _resetOrganizationCacheForTests } from "@/server/auth/organization";
import { connectMongo } from "@/server/db/mongoose";
import {
  PaymentProviderNotConfiguredError,
  getGatewayForOrganization,
} from "@/server/payments/resolve-gateway";
import { ensureMongo } from "@/tests/utils/db";
import {
  seedTestOrganization,
  setEnabledProviders,
  TEST_ORG_SLUG,
} from "@/tests/utils/organization";

/**
 * Where PayPal credentials come from, and — more importantly — where they
 * must NOT come from.
 *
 * PayPal previously resolved only from `ORG_<SLUG>_PAYPAL_*` or the vault,
 * while Stripe had a deployment-level pair the default organization falls
 * back to. That asymmetry forced a per-organization credential namespace onto
 * single-tenant deployments that have exactly one organization. These tests
 * pin the symmetry that closes it, and the safety rules that must survive it:
 *
 *   - the DEFAULT organization may use deployment PAYPAL_* credentials
 *   - a NON-default organization may NOT — it would take its money through
 *     the deployment's merchant account
 *   - a PARTIAL deployment set configures nothing, rather than half a gateway
 *   - `ORG_<SLUG>_PAYPAL_*` still wins, so a future second organization keeps
 *     its own credentials
 *   - PayPal is LIVE-ONLY: no env var, no per-organization override and no
 *     Stripe-derived flag can select an environment, because the switch was
 *     removed rather than defaulted
 */

const DEPLOYMENT_PAYPAL = {
  PAYPAL_CLIENT_ID: "deployment-live-client-id",
  PAYPAL_CLIENT_SECRET: "deployment-live-client-secret",
  PAYPAL_WEBHOOK_ID: "deployment-live-webhook-id",
} as const;

function stub(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
  // The env module memoises its parse on first read, which already happened
  // during setup. Without this the stubs above are invisible to `env.server`.
  _resetEnvCacheForTests();
}

beforeEach(async () => {
  await ensureMongo();
  await seedTestOrganization({
    enabledProviders: [PaymentGatewayKey.STRIPE, PaymentGatewayKey.PAYPAL],
    provider: PaymentGatewayKey.STRIPE,
  });
  await setEnabledProviders([
    PaymentGatewayKey.STRIPE,
    PaymentGatewayKey.PAYPAL,
  ]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetEnvCacheForTests();
  _resetOrganizationCacheForTests();
});

describe("PayPal credentials — deployment level", () => {
  it("resolves a PayPal gateway for the DEFAULT organization from PAYPAL_*", async () => {
    stub(DEPLOYMENT_PAYPAL);
    const orgId = await seedTestOrganization();

    const gateway = await getGatewayForOrganization(
      orgId,
      PaymentGatewayKey.PAYPAL,
    );

    expect(gateway.key).toBe(PaymentGatewayKey.PAYPAL);
    expect(gateway.enabled).toBe(true);
  });

  it("reports LIVE — the gateway has no sandbox mode at all", async () => {
    stub(DEPLOYMENT_PAYPAL);
    const orgId = await seedTestOrganization();

    const gateway = await getGatewayForOrganization(
      orgId,
      PaymentGatewayKey.PAYPAL,
    );

    expect(gateway.sandbox).toBe(false);
  });

  it("does NOT derive PayPal's environment from a Stripe test key", async () => {
    // The seed writes `payments.sandbox` from whether STRIPE_SECRET_KEY starts
    // with sk_test. Coupling the two once sent live PayPal credentials to
    // api-m.sandbox.paypal.com, where they cannot authenticate. The switch is
    // gone entirely now, so this asserts the flag is inert.
    stub({ ...DEPLOYMENT_PAYPAL, STRIPE_SECRET_KEY: "sk_test_something" });
    const orgId = await seedTestOrganization();
    await connectMongo();
    await Organization.updateOne(
      { slug: TEST_ORG_SLUG },
      { $set: { "payments.sandbox": true } },
    );
    _resetOrganizationCacheForTests();

    const gateway = await getGatewayForOrganization(
      orgId,
      PaymentGatewayKey.PAYPAL,
    );

    expect(gateway.sandbox).toBe(false);
  });

  it("stays LIVE even when PAYPAL_SANDBOX=true is set", async () => {
    // The variable no longer exists in the schema and nothing reads it.
    // Setting it must be completely inert — this is the regression guard
    // against anyone reintroducing an environment switch for a live-only
    // deployment.
    stub({ ...DEPLOYMENT_PAYPAL, PAYPAL_SANDBOX: "true" });
    const orgId = await seedTestOrganization();

    const gateway = await getGatewayForOrganization(
      orgId,
      PaymentGatewayKey.PAYPAL,
    );

    expect(gateway.sandbox).toBe(false);
  });

  it("refuses a PARTIAL deployment set rather than half-configuring", async () => {
    // A client id paired with a missing webhook id fails at webhook time,
    // long after the money moved. Refuse at configuration time instead.
    stub({
      PAYPAL_CLIENT_ID: DEPLOYMENT_PAYPAL.PAYPAL_CLIENT_ID,
      PAYPAL_CLIENT_SECRET: DEPLOYMENT_PAYPAL.PAYPAL_CLIENT_SECRET,
    });
    const orgId = await seedTestOrganization();

    await expect(
      getGatewayForOrganization(orgId, PaymentGatewayKey.PAYPAL),
    ).rejects.toBeInstanceOf(PaymentProviderNotConfiguredError);
  });

  it("refuses when the deployment has no PayPal credentials at all", async () => {
    const orgId = await seedTestOrganization();

    await expect(
      getGatewayForOrganization(orgId, PaymentGatewayKey.PAYPAL),
    ).rejects.toBeInstanceOf(PaymentProviderNotConfiguredError);
  });
});

describe("PayPal credentials — isolation", () => {
  it("does NOT let a NON-default organization use deployment credentials", async () => {
    // The whole safety story. Falling back here would take a second brand's
    // money through the deployment's PayPal merchant account, with refunds and
    // disputes surfacing against the wrong merchant.
    stub(DEPLOYMENT_PAYPAL);
    await connectMongo();
    const other = await Organization.create({
      slug: "someothertenant",
      name: "Some Other Tenant",
      brandName: "Some Other Tenant",
      status: "ACTIVE",
      isDefault: false,
      payments: {
        provider: PaymentGatewayKey.PAYPAL,
        enabledProviders: [PaymentGatewayKey.PAYPAL],
      },
    });

    await expect(
      getGatewayForOrganization(String(other._id), PaymentGatewayKey.PAYPAL),
    ).rejects.toBeInstanceOf(PaymentProviderNotConfiguredError);
  });

  it("lets ORG_<SLUG>_PAYPAL_* win over the deployment credentials", async () => {
    // A future second organization must keep its own credentials even on a
    // deployment that has its own set.
    stub({
      ...DEPLOYMENT_PAYPAL,
      [`ORG_${TEST_ORG_SLUG.toUpperCase()}_PAYPAL_CLIENT_ID`]: "org-client-id",
      [`ORG_${TEST_ORG_SLUG.toUpperCase()}_PAYPAL_CLIENT_SECRET`]:
        "org-client-secret",
      [`ORG_${TEST_ORG_SLUG.toUpperCase()}_PAYPAL_WEBHOOK_ID`]:
        "org-webhook-id",
    });
    const orgId = await seedTestOrganization();

    const gateway = await getGatewayForOrganization(
      orgId,
      PaymentGatewayKey.PAYPAL,
    );

    // The ORG_ credentials resolve a working gateway, and it is still LIVE —
    // a per-organization override cannot select an environment either.
    expect(gateway.key).toBe(PaymentGatewayKey.PAYPAL);
    expect(gateway.enabled).toBe(true);
    expect(gateway.sandbox).toBe(false);
  });

  it("never accepts a Stripe publishable key as the PayPal client id", async () => {
    // `payments.publishableKey` is one field documented as "publishable /
    // client id", and the seed always writes the STRIPE publishable key into
    // it. Used as a PayPal client id it makes the configured-check pass with a
    // pk_live_, and PayPal then answers 401 — which reads as "PayPal is
    // broken" rather than "PayPal is not configured".
    stub({
      PAYPAL_CLIENT_SECRET: DEPLOYMENT_PAYPAL.PAYPAL_CLIENT_SECRET,
      PAYPAL_WEBHOOK_ID: DEPLOYMENT_PAYPAL.PAYPAL_WEBHOOK_ID,
    });
    const orgId = await seedTestOrganization();
    await connectMongo();
    await Organization.updateOne(
      { slug: TEST_ORG_SLUG },
      { $set: { "payments.publishableKey": "pk_live_stripe_key_not_paypal" } },
    );
    _resetOrganizationCacheForTests();

    // No deployment PAYPAL_CLIENT_ID and no ORG_ override, so the only
    // candidate is the Stripe key on the document. It must be rejected.
    await expect(
      getGatewayForOrganization(orgId, PaymentGatewayKey.PAYPAL),
    ).rejects.toBeInstanceOf(PaymentProviderNotConfiguredError);
  });
});
