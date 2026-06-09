import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Vitest "unit" project — jsdom environment, no DB, no network.
 *
 *   - Loads .env.test before any module import (see unit.setup.ts).
 *   - Stubs `server-only` so server modules can be imported from tests.
 *   - Fails loudly on real `fetch` calls — unit tests must mock them.
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
    name: "unit",
    environment: "jsdom",
    include: ["src/tests/unit/**/*.test.{ts,tsx}"],
    setupFiles: [path.resolve(__dirname, "src/tests/setup/unit.setup.ts")],
    testTimeout: 5_000,
    hookTimeout: 5_000,
    pool: "forks",
    clearMocks: true,
    restoreMocks: true,
    mockReset: false,
  },
});
