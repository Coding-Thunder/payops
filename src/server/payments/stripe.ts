import "server-only";

import Stripe from "stripe";

import { env } from "@/lib/env";

let cached: Stripe | null = null;

/**
 * Returns the env-backed singleton Stripe client.
 *
 * This is the LEGACY path. Tenant #1's existing single-tenant flow
 * uses it unchanged. Per-org code paths should call
 * `getStripeForSecret(secretKey)` instead so the credential resolved
 * from a `GatewayCredential` row drives the client.
 *
 * Test-mode escape hatch: when `TRACETXN_TEST_MODE` is set to "smoke" or
 * "integration", an in-process stub is returned. The stub implements
 * only the methods TraceTxn uses (checkout sessions + webhook helpers)
 * and never opens a network socket. Production never sets this env
 * var, so the real Stripe client is always used in real deployments.
 *
 * Tests should call `setStripeForTesting(stub.asStripe())` from their
 * setup hook for a richer, observable stub (recorded calls,
 * fail-next-create, etc.).
 */
export function getStripe(): Stripe {
  if (cached) return cached;

  const testStub = buildTestStubIfActive();
  if (testStub) {
    cached = testStub;
    return cached;
  }

  cached = new Stripe(env.server.STRIPE_SECRET_KEY, {
    typescript: true,
    appInfo: { name: "TraceTxn", version: "1.0.0" },
    maxNetworkRetries: 2,
    timeout: 15_000,
  });
  return cached;
}

/**
 * Build a per-org Stripe client from a secret key resolved out of a
 * `GatewayCredential` row. NOT cached at module scope — caching a
 * per-org client globally would leak Tenant A's connection pool into
 * Tenant B's request when the module is hot-loaded.
 *
 * In test mode the shared in-process stub is returned regardless of
 * the secret key, so existing test suites (which set up the stub via
 * `setStripeForTesting`) keep observing one set of calls. This routes
 * through the same `cached` slot as `getStripe()` because Vitest's
 * tsconfig-paths plugin doesn't rewrite runtime CJS `require()` — we
 * MUST reuse the pre-set test stub rather than reach for a fresh one.
 */
export function getStripeForSecret(secretKey: string): Stripe {
  if (!secretKey) {
    throw new Error("getStripeForSecret called without a secret key");
  }
  const testMode = process.env.TRACETXN_TEST_MODE;
  if (testMode === "smoke" || testMode === "integration") {
    // Reuse the test stub installed by `setStripeForTesting` in the
    // integration / smoke setup. The stub is gateway-agnostic — it
    // doesn't care which secret key fired it — so per-org isolation
    // in tests is observed via the call-record arrays + the routing
    // path inside the gateway, not via the Stripe client itself.
    if (cached) return cached;
    // No-one called setStripeForTesting yet — bootstrap via the legacy
    // env path which knows how to build the stub.
    return getStripe();
  }
  return new Stripe(secretKey, {
    typescript: true,
    appInfo: { name: "TraceTxn", version: "1.0.0" },
    maxNetworkRetries: 2,
    timeout: 15_000,
  });
}

/**
 * Replace the cached env-backed Stripe client. Test-only. Production
 * code paths never import this — Next.js tree-shakes it out of client
 * bundles because the whole file is `server-only`.
 */
export function setStripeForTesting(client: Stripe | null): void {
  cached = client;
}

function buildTestStubIfActive(): Stripe | null {
  const testMode = process.env.TRACETXN_TEST_MODE;
  if (testMode !== "smoke" && testMode !== "integration") return null;
  // Lazy-loaded so production bundles never include test code.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional: lazy CJS require keeps test mocks out of prod bundle
  const { createStripeStub } = require("@/tests/mocks/stripe-stub") as
    typeof import("@/tests/mocks/stripe-stub");
  return createStripeStub({
    successBaseUrl: process.env.APP_URL ?? "http://127.0.0.1:3100",
  }).asStripe();
}
