import "server-only";

import Stripe from "stripe";

import { env } from "@/lib/env";

let cached: Stripe | null = null;

/**
 * Returns the singleton Stripe client.
 *
 * Test-mode escape hatch: when `PAYOPS_TEST_MODE` is set to "smoke" or
 * "integration", an in-process stub is returned instead. The stub
 * implements only the methods PayOps uses (checkout sessions + webhook
 * helpers) and never opens a network socket. Production never sets this
 * env var, so the real Stripe client is always used in real deployments.
 *
 * Tests should call `setStripeForTesting(stub.asStripe())` from their
 * setup hook for a richer, observable stub (recorded calls,
 * fail-next-create, etc.).
 */
export function getStripe(): Stripe {
  if (cached) return cached;

  const testMode = process.env.PAYOPS_TEST_MODE;
  if (testMode === "smoke" || testMode === "integration") {
    // Lazy-loaded so production bundles never include test code.

    const { createStripeStub } = require("@/tests/mocks/stripe-stub") as
      typeof import("@/tests/mocks/stripe-stub");
    cached = createStripeStub({
      successBaseUrl: process.env.APP_URL ?? "http://127.0.0.1:3100",
    }).asStripe();
    return cached;
  }

  cached = new Stripe(env.server.STRIPE_SECRET_KEY, {
    typescript: true,
    appInfo: { name: "PayOps", version: "1.0.0" },
    maxNetworkRetries: 2,
    timeout: 15_000,
  });
  return cached;
}

/**
 * Replace the cached Stripe client. Test-only. Production code paths never
 * import this — Next.js tree-shakes it out of client bundles because the
 * whole file is `server-only`.
 */
export function setStripeForTesting(client: Stripe | null): void {
  cached = client;
}
