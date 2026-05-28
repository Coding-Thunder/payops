import { loadEnvFile } from "./load-env";

loadEnvFile(".env.test");

import crypto from "node:crypto";

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
let perFileDbName: string | null = null;

export function getCurrentTestStripe(): StripeStub {
  if (!stripeStub) {
    throw new Error(
      "Stripe stub is not initialised — make sure beforeEach has run.",
    );
  }
  return stripeStub;
}

beforeAll(async () => {
  const rootUri = process.env.TRACETXN_IT_MONGO_URI;
  if (!rootUri) {
    throw new Error(
      "TRACETXN_IT_MONGO_URI not set — did integration.global-setup.ts run?",
    );
  }
  perFileDbName = `it-${crypto.randomUUID().slice(0, 8)}`;
  process.env.MONGODB_DB = perFileDbName;
  process.env.MONGODB_URI = rootUri;
  process.env.TRACETXN_TEST_MODE = "integration";

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
