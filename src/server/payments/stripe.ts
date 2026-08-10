import "server-only";

import Stripe from "stripe";

import { env } from "@/lib/env";

/** Clients keyed by secret key, so each organization reuses one pooled
 *  client instead of constructing a new one per checkout. */
const clients = new Map<string, Stripe>();
/** Test override. When set it wins for EVERY key — a test asserting on
 *  recorded calls must not be bypassed by an organization supplying its
 *  own credentials. */
let testClient: Stripe | null = null;

function stubClient(): Stripe {
  // Lazy-loaded so production bundles never include test code.

  // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional: lazy CJS require keeps test mocks out of prod bundle
  const { createStripeStub } = require("@/tests/mocks/stripe-stub") as
    typeof import("@/tests/mocks/stripe-stub");
  return createStripeStub({
    successBaseUrl: process.env.APP_URL ?? "http://127.0.0.1:3100",
  }).asStripe();
}

/**
 * Stripe client for a specific secret key.
 *
 * Multi-tenancy needs one client per set of credentials — two organizations
 * on different Stripe accounts cannot share a client, because the key is
 * baked in at construction. Clients are cached by key so this stays a
 * lookup on the hot path.
 *
 * Test-mode escape hatch is unchanged and deliberately key-INDEPENDENT:
 * when `PAYOPS_TEST_MODE` is "smoke"/"integration", or a test installed a
 * client via `setStripeForTesting`, that instance is returned no matter
 * which key was asked for. Otherwise a test that exercised a per-org
 * credential path would silently open a real network client.
 */
export function getStripeFor(secretKey: string): Stripe {
  if (testClient) return testClient;

  const testMode = process.env.PAYOPS_TEST_MODE;
  if (testMode === "smoke" || testMode === "integration") {
    testClient = stubClient();
    return testClient;
  }

  const cached = clients.get(secretKey);
  if (cached) return cached;

  const client = new Stripe(secretKey, {
    typescript: true,
    appInfo: { name: "PayOps", version: "1.0.0" },
    maxNetworkRetries: 2,
    timeout: 15_000,
  });
  clients.set(secretKey, client);
  return client;
}

/**
 * The deployment-level Stripe client, from `STRIPE_SECRET_KEY`.
 *
 * Still the path every existing caller takes, and still what an
 * organization with no stored credentials falls back to — which is what
 * keeps RentalConfirmation byte-identical through the multi-tenant
 * migration.
 */
export function getStripe(): Stripe {
  return getStripeFor(env.server.STRIPE_SECRET_KEY);
}

/**
 * Replace the client for every key. Test-only. Production code paths never
 * import this — Next.js tree-shakes it out of client bundles because the
 * whole file is `server-only`.
 */
export function setStripeForTesting(client: Stripe | null): void {
  testClient = client;
  if (!client) clients.clear();
}
