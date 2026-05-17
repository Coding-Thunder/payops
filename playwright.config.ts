import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

/**
 * Playwright smoke + e2e configuration.
 *
 * Smoke tests boot a real Next.js server against a dedicated
 * "payops-smoke" MongoDB so they never touch dev or prod data. The
 * global-setup file seeds deterministic fixtures (admin user, staff user,
 * settings document); global-teardown drops the database.
 */

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const SMOKE_ENV_FILE = path.resolve(__dirname, ".env.smoke");

export default defineConfig({
  testDir: "./src/tests/smoke",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [["github"], ["html", { outputFolder: "reports/playwright-html", open: "never" }]]
    : [["list"], ["html", { outputFolder: "reports/playwright-html", open: "never" }]],
  outputDir: "reports/playwright-artifacts",
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  globalSetup: "./src/tests/setup/playwright.global-setup.ts",
  globalTeardown: "./src/tests/setup/playwright.global-teardown.ts",

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    // Default: `next start` against a pre-built artifact — production-
    // shaped and deterministic. PLAYWRIGHT_USE_DEV=1 boots `next dev`
    // for fast iteration, but Next 16's dev lock means it can't run
    // alongside a developer's existing `npm run dev` on the same repo.
    command: process.env.PLAYWRIGHT_USE_DEV
      ? `npx next dev --turbopack -p ${PORT}`
      : `npx next start -p ${PORT}`,
    cwd: __dirname,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...loadEnvFile(SMOKE_ENV_FILE),
      NODE_ENV: process.env.PLAYWRIGHT_USE_DEV ? "development" : "production",
      PLAYWRIGHT: "1",
    },
  },
});

function loadEnvFile(file: string): Record<string, string> {

  const fs = require("node:fs") as typeof import("node:fs");
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  const text = fs.readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
