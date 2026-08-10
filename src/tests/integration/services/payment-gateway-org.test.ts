import { beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import { PaymentGatewayKey } from "@/lib/constants/enums";
import { type AppError, isAppError } from "@/lib/errors";
import {
  CredentialField,
  CredentialProvider,
  Organization,
} from "@/server/db/models";
import {
  PaymentProviderNotConfiguredError,
  getGatewayForOrganization,
} from "@/server/payments/resolve-gateway";
import {
  _resetCredentialCacheForTests,
  putSecret,
} from "@/server/services/organization-credential.service";
import { ensureMongo } from "@/tests/utils/db";

/**
 * Which merchant account an organization's payments run on.
 *
 * The rule this file exists to pin is asymmetric, and getting it backwards
 * would move real money:
 *
 *   the DEFAULT organization falls back to the deployment's env
 *   credentials, because RentalConfirmation is already running on them and
 *   must keep doing so, unchanged, until someone deliberately migrates its
 *   keys into the vault;
 *
 *   any OTHER organization with missing credentials must FAIL LOUDLY. A
 *   fallback there would mean a second brand silently taking payments
 *   through the first brand's Stripe account — money in the wrong bank
 *   account, disputes against the wrong merchant, and nothing on screen to
 *   say so.
 *
 * `.env.test` sets a TEST-mode secret key, so `sandbox` is true for the env
 * gateway. Storing a LIVE-prefixed key for an organization therefore gives
 * an observable signal that the stored credential — not the env one — is
 * the credential in use.
 */

async function makeOrg(slug: string, isDefault: boolean) {
  const doc = await Organization.create({
    slug,
    name: slug,
    brandName: `${slug} brand`,
    isDefault,
    payments: { provider: PaymentGatewayKey.STRIPE },
  });
  return String(doc._id as Types.ObjectId);
}

async function storeStripeCredentials(orgId: string, secretKey: string) {
  await putSecret({
    organizationId: orgId,
    provider: CredentialProvider.STRIPE,
    field: CredentialField.SECRET_KEY,
    value: secretKey,
  });
  await putSecret({
    organizationId: orgId,
    provider: CredentialProvider.STRIPE,
    field: CredentialField.WEBHOOK_SECRET,
    value: `whsec_${orgId}`,
  });
}

beforeEach(async () => {
  await ensureMongo();
});

describe("an unmigrated deployment is untouched", () => {
  it("resolves the deployment gateway when there is no organization", async () => {
    const gateway = await getGatewayForOrganization(null);
    expect(gateway.key).toBe("STRIPE");
    expect(gateway.enabled).toBe(true);
    // From .env.test's sk_test_… key.
    expect(gateway.sandbox).toBe(true);
  });

  it("resolves the deployment gateway for an unknown organization id", async () => {
    const gateway = await getGatewayForOrganization(
      String(new Types.ObjectId()),
    );
    expect(gateway.key).toBe("STRIPE");
  });
});

describe("the default organization keeps running on env credentials", () => {
  it("falls back when it has nothing stored", async () => {
    const org = await makeOrg("rentalconfirmation", true);
    const gateway = await getGatewayForOrganization(org);
    expect(gateway.enabled).toBe(true);
    expect(gateway.sandbox).toBe(true); // env key, unchanged
  });

  it("prefers its OWN credentials once they are stored", async () => {
    const org = await makeOrg("rentalconfirmation", true);
    await storeStripeCredentials(org, "sk_live_rentalconfirmation_key");

    const gateway = await getGatewayForOrganization(org);
    // A live-prefixed stored key flips sandbox off — proof the vault
    // credential is what the gateway is built from, not the env one.
    expect(gateway.sandbox).toBe(false);
  });
});

describe("a second organization must never borrow the first's account", () => {
  it("REFUSES to create a gateway when its credentials are missing", async () => {
    const org = await makeOrg("tripreservations", false);
    await expect(getGatewayForOrganization(org)).rejects.toBeInstanceOf(
      PaymentProviderNotConfiguredError,
    );
  });

  it("refuses when only one of the two secrets is present", async () => {
    // A half-configured organization is not "configured enough" — without a
    // webhook secret its payments could never be confirmed.
    const org = await makeOrg("tripreservations", false);
    await putSecret({
      organizationId: org,
      provider: CredentialProvider.STRIPE,
      field: CredentialField.SECRET_KEY,
      value: "sk_live_trip_only",
    });
    await expect(getGatewayForOrganization(org)).rejects.toThrow(
      /no Stripe credentials configured/i,
    );
  });

  it("names the brand in the error so the operator knows what to fix", async () => {
    const org = await makeOrg("tripreservations", false);
    await expect(getGatewayForOrganization(org)).rejects.toThrow(
      /tripreservations brand/i,
    );
  });

  it("surfaces as a 409, not a generic 500", async () => {
    // `withApi` maps thrown errors through `isAppError`, which is a bare
    // `instanceof AppError`. A duck-typed error would fall through to the
    // catch-all and the operator would see "Something went wrong" with no
    // clue that the fix is to add their Stripe keys.
    const org = await makeOrg("tripreservations", false);
    const err = await getGatewayForOrganization(org).catch((e) => e);
    expect(isAppError(err)).toBe(true);
    expect((err as AppError).statusCode).toBe(409);
    expect((err as AppError).code).toBe("CONFLICT");
  });

  it("never puts a secret or ciphertext in the error message", async () => {
    const org = await makeOrg("tripreservations", false);
    await putSecret({
      organizationId: org,
      provider: CredentialProvider.STRIPE,
      field: CredentialField.SECRET_KEY,
      value: "sk_live_SUPER_SECRET_VALUE",
    });
    const err = await getGatewayForOrganization(org).catch((e) => e);
    expect(String((err as Error).message)).not.toContain("sk_live");
    expect(String((err as Error).message)).not.toContain("SUPER_SECRET");
  });

  it("works once its own credentials are stored", async () => {
    const org = await makeOrg("tripreservations", false);
    await storeStripeCredentials(org, "sk_live_tripreservations_key");
    const gateway = await getGatewayForOrganization(org);
    expect(gateway.key).toBe("STRIPE");
    expect(gateway.enabled).toBe(true);
    expect(gateway.sandbox).toBe(false);
  });
});

describe("an explicit provider override selects the PROVIDER, never the credentials", () => {
  // REGRESSION GUARD. An earlier version short-circuited to the registry
  // singleton whenever a provider was supplied — and the email composer
  // sends `gateway: "STRIPE"` on EVERY "Generate Payment Link" click. So the
  // per-organization path would never have run in production and every brand
  // would have charged through the deployment's Stripe account. The
  // unit-level tests all passed, because they called the resolver without an
  // override. These do not.

  it("still REFUSES an unconfigured non-default organization", async () => {
    const org = await makeOrg("tripreservations", false);
    await expect(
      getGatewayForOrganization(org, PaymentGatewayKey.STRIPE),
    ).rejects.toBeInstanceOf(PaymentProviderNotConfiguredError);
  });

  it("still uses the organization's own credentials, not the env ones", async () => {
    const org = await makeOrg("tripreservations", false);
    await storeStripeCredentials(org, "sk_live_trip_key");
    const gateway = await getGatewayForOrganization(
      org,
      PaymentGatewayKey.STRIPE,
    );
    expect(gateway.sandbox).toBe(false); // env key is sk_test_
  });

  it("still falls back to env for the default organization", async () => {
    const org = await makeOrg("rentalconfirmation", true);
    const gateway = await getGatewayForOrganization(
      org,
      PaymentGatewayKey.STRIPE,
    );
    expect(gateway.sandbox).toBe(true);
  });
});

describe("a malformed master key degrades instead of breaking payments", () => {
  it("does not stop the default organization generating links", async () => {
    // resolveMasterKey throws on a key that is not 32 bytes. On the
    // payment-link hot path that would turn "the vault is misconfigured"
    // into "nobody can take payments" — including the default organization,
    // which does not even use the vault yet.
    const org = await makeOrg("rentalconfirmation", true);
    const previous = process.env.CREDENTIALS_MASTER_KEY;
    process.env.CREDENTIALS_MASTER_KEY = "obviously-not-32-bytes";
    _resetCredentialCacheForTests();
    try {
      const gateway = await getGatewayForOrganization(org);
      expect(gateway.enabled).toBe(true);
    } finally {
      process.env.CREDENTIALS_MASTER_KEY = previous;
      _resetCredentialCacheForTests();
    }
  });
});

describe("two organizations resolve to different merchant accounts", () => {
  it("keeps their gateways independent", async () => {
    const rc = await makeOrg("rentalconfirmation", true);
    const trip = await makeOrg("tripreservations", false);
    await storeStripeCredentials(rc, "sk_test_rc_key");
    await storeStripeCredentials(trip, "sk_live_trip_key");

    const rcGateway = await getGatewayForOrganization(rc);
    const tripGateway = await getGatewayForOrganization(trip);

    // Distinguishable purely by their own credentials.
    expect(rcGateway.sandbox).toBe(true);
    expect(tripGateway.sandbox).toBe(false);
  });
});

describe("a non-Stripe provider without an implementation is refused", () => {
  it("does not silently fall back to Stripe", async () => {
    // PayPal is still a registry placeholder until P7. The important part
    // is that an organization configured for PayPal does NOT quietly get a
    // Stripe checkout instead.
    const doc = await Organization.create({
      slug: "paypal-brand",
      name: "paypal-brand",
      brandName: "PayPal Brand",
      isDefault: false,
      payments: { provider: PaymentGatewayKey.PAYPAL },
    });
    await expect(
      getGatewayForOrganization(String(doc._id as Types.ObjectId)),
    ).rejects.toBeInstanceOf(PaymentProviderNotConfiguredError);
  });
});
