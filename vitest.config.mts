import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Root Vitest configuration.
 *
 * The actual unit + integration project configs live in
 * `vitest.unit.config.mts` and `vitest.integration.config.mts` and are
 * stitched together by `vitest.workspace.ts`. This file exists only to
 * carry shared coverage thresholds and reporters that apply to every run.
 *
 * Run a single project with:
 *   npx vitest --project unit
 *   npx vitest --project integration
 */
export default defineConfig({
  test: {
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: {
      junit: "./reports/vitest-junit.xml",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./reports/coverage",
      include: [
        "src/lib/**/*.{ts,tsx}",
        "src/server/**/*.{ts,tsx}",
        "src/components/**/*.{ts,tsx}",
      ],
      exclude: [
        "src/**/*.d.ts",
        "src/components/ui/**",
        "src/tests/**",
        "src/**/index.ts",
        "src/app/**",
      ],
      thresholds: {
        statements: 50,
        branches: 50,
        functions: 50,
        lines: 50,
      },
    },
  },
  resolve: {
    alias: {
      "server-only": path.resolve(
        __dirname,
        "src/tests/mocks/server-only.ts",
      ),
    },
  },
});
