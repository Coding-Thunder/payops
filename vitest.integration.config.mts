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
 * `integration.setup.ts`) so cross-file pollution is impossible.
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
    poolOptions: {
      forks: { singleFork: false },
    },
    fileParallelism: true,
    sequence: { concurrent: false },
    clearMocks: true,
    restoreMocks: true,
    mockReset: false,
  },
});
