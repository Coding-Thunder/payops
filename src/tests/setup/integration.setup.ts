import { loadEnvFile } from "./load-env";

loadEnvFile(".env.test");

import crypto from "node:crypto";

/**
 * Claim this file's private logical database *at module scope*, before the
 * test file's own imports are evaluated.
 *
 * This has to happen here rather than in `beforeAll`. `src/lib/env.ts`
 * memoises its parse on the first `env.server` read, and
 * `payments/gateways/stripe.ts` reads `env.server` at module scope — so
 * merely importing anything that reaches the gateway registry freezes the
 * whole env snapshot, database name included. `beforeAll` runs *after* the
 * test file's imports, so a name assigned there was silently ignored and
 * every file quietly shared `payops-it-root`. Combined with
 * `fileParallelism: true` and the `afterEach` collection wipe below, files
 * deleted each other's rows mid-test.
 *
 * Vitest evaluates setup files before the test module, so assigning here is
 * early enough for the frozen snapshot to capture the right name.
 */
const PER_FILE_DB = `it-${crypto.randomUUID().slice(0, 8)}`;
if (process.env.PAYOPS_IT_MONGO_URI) {
  process.env.MONGODB_URI = process.env.PAYOPS_IT_MONGO_URI;
}
process.env.MONGODB_DB = PER_FILE_DB;
process.env.PAYOPS_TEST_MODE = "integration";

// Fixed master key for the organization credential vault. Set here for the
// same reason as the database name: `env.server` memoises on first read, so
// anything assigned after the test module's imports is ignored. A constant
// (rather than a random) key keeps failures reproducible. This is a test
// value and has never been used to seal anything real.
// (decodes to the 32 ASCII bytes "test-only-master-key-for-payops!")
process.env.CREDENTIALS_MASTER_KEY ??=
  "dGVzdC1vbmx5LW1hc3Rlci1rZXktZm9yLXBheW9wcyE=";

import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";

import { setStripeForTesting } from "@/server/payments/stripe";
import { createStripeStub, type StripeStub } from "@/tests/mocks/stripe-stub";
import { _nextHeadersState } from "@/tests/utils/next-headers";

/**
 * Mock `next/headers` globally for every integration test. The module's
 * exports are non-configurable getters, so `vi.spyOn` won't fly — we
 * register the mock via `vi.mock`, which Vitest hoists. The mock reads
 * its live cookie / header state from a global accessor so tests can
 * mutate it without re-installing the mock.
 */
vi.mock("next/headers", () => ({
  cookies: async () => {
    const state = _nextHeadersState();
    return {
      get: (name: string) =>
        state.cookies.has(name)
          ? { name, value: state.cookies.get(name)! }
          : undefined,
      set: (arg: { name: string; value: string } | string, value?: string) => {
        if (typeof arg === "string") {
          state.cookies.set(arg, value ?? "");
        } else {
          state.cookies.set(arg.name, arg.value);
        }
      },
      delete: (name: string) => {
        state.cookies.delete(name);
      },
      has: (name: string) => state.cookies.has(name),
      getAll: () =>
        Array.from(state.cookies.entries()).map(([name, value]) => ({
          name,
          value,
        })),
    };
  },
  headers: async () => {
    const state = _nextHeadersState();
    return {
      get: (name: string) => state.headers.get(name.toLowerCase()) ?? null,
      has: (name: string) => state.headers.has(name.toLowerCase()),
      forEach: (cb: (value: string, key: string) => void) =>
        state.headers.forEach((v, k) => cb(v, k)),
      entries: () => state.headers.entries(),
      keys: () => state.headers.keys(),
      values: () => state.headers.values(),
    };
  },
}));

/**
 * Per-file integration setup.
 *
 *   - Picks a unique logical database on the shared in-memory mongod
 *     instance — every test file gets a fresh namespace, no shared state.
 *   - Installs a Stripe stub fresh for each test (`beforeEach`) so call
 *     records never leak between tests.
 *   - Disconnects Mongo at the end of the file so the worker exits clean.
 *
 * `getCurrentTestStripe()` is exported so tests can introspect calls
 * ("did we ask Stripe to create a session?") and pre-stage failures.
 */

let stripeStub: StripeStub | null = null;

export function getCurrentTestStripe(): StripeStub {
  if (!stripeStub) {
    throw new Error(
      "Stripe stub is not initialised — make sure beforeEach has run.",
    );
  }
  return stripeStub;
}

beforeAll(async () => {
  if (!process.env.PAYOPS_IT_MONGO_URI) {
    throw new Error(
      "PAYOPS_IT_MONGO_URI not set — did integration.global-setup.ts run?",
    );
  }
  // The database name itself is claimed at module scope above — reassigning
  // it here would be too late to reach the memoised env snapshot.

  // Force a clean module-level cache for the shared mongoose connection.
  delete (globalThis as { __payopsMongoose?: unknown }).__payopsMongoose;
});

beforeEach(() => {
  stripeStub = createStripeStub({
    successBaseUrl: process.env.APP_URL ?? "http://localhost:3000",
  });
  setStripeForTesting(stripeStub.asStripe());
});

afterEach(async () => {
  setStripeForTesting(null);
  // Drop every collection between tests so each test starts from a clean slate.
  // We do this rather than dropping the database to keep indexes in place,
  // which avoids per-test re-index cost.
  if (mongoose.connection.readyState === 1) {
    const collections = await mongoose.connection.db?.collections();
    if (collections) {
      await Promise.all(collections.map((c) => c.deleteMany({})));
    }
  }
});

afterAll(async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  delete (globalThis as { __payopsMongoose?: unknown }).__payopsMongoose;
});
