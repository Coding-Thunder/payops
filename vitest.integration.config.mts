import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Vitest "integration" project — node environment, real Mongoose against
 * mongodb-memory-server. Stripe is mocked at the SDK boundary so tests
 * exercise our own code end to end without external network calls.
 *
 * Each test file gets its own logical database (assigned in
 * `integration.setup.ts`).
 *
 * `fileParallelism` is OFF. Every fork shares the ONE in-memory mongod started
 * by the global setup, and running files concurrently against it produced
 * widespread, non-deterministic failures (31 of 36 in four representative
 * files) that vanish entirely when the same files run serially. Per-file
 * databases prevent data collisions but not contention on the single server.
 * Correctness beats the few seconds parallelism buys here.
 */
export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  resolve: {
    alias: {
      "server-only": path.resolve(
        __dirname,
        "src/tests/mocks/server-only.ts",
      ),
    },
  },
  test: {
    name: "integration",
    environment: "node",
    include: ["src/tests/integration/**/*.test.{ts,tsx}"],
    globalSetup: [
      path.resolve(
        __dirname,
        "src/tests/setup/integration.global-setup.ts",
      ),
    ],
    setupFiles: [
      path.resolve(__dirname, "src/tests/setup/integration.setup.ts"),
    ],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: "forks",
      // A fork PER FILE, not one shared fork: each file needs a fresh module
      // registry so Mongoose rebuilds indexes against that file's database.
      // Reusing a single fork across files skips those builds and silently
      // breaks every uniqueness assertion (duplicate SKU, (orgId,key),
      // idempotency dedup). Serialisation comes from `fileParallelism`.
    poolOptions: {
      forks: { singleFork: false },
    },
    fileParallelism: false,
    sequence: { concurrent: false },
    clearMocks: true,
    restoreMocks: true,
    mockReset: false,
  },
});
