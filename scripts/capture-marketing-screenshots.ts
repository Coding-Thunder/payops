/* eslint-disable no-console */
/**
 * Marketing screenshot capture.
 *
 * Drives the running dev server with Playwright, signs in with a
 * supplied admin credential, and saves WebP screenshots of the
 * authed surfaces the landing page features. Tolerant of empty
 * databases — captures whatever it can find and reports what it
 * skipped.
 *
 * Usage:
 *   1. `npm run dev` (or have the app running on port 3000)
 *   2. Set MARKETING_CAPTURE_EMAIL + MARKETING_CAPTURE_PASSWORD env
 *      vars (or the BOOTSTRAP_ADMIN_* legacy names).
 *   3. `npm run capture:marketing`
 *
 * Output: WebP files under public/marketing/
 *
 *   - dashboard.webp        — /app/dashboard
 *   - orders-list.webp      — /app/orders
 *   - order-detail.webp     — /app/orders/[first-active-order]
 *   - evidence-chain.webp   — /app/orders/[first-with-evidence]/evidence
 *   - disputes-admin.webp   — /app/admin/disputes
 *
 * Each capture is best-effort: missing pages are skipped with a
 * warning, not a hard failure.
 *
 * Encoding: Playwright captures PNG natively; we pipe the buffer
 * through `sharp` (already a transitive Next.js dep) to encode WebP
 * at quality 82 — visually indistinguishable from the source at
 * landing-page sizes, ~70% smaller on disk than the PNG.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import mongoose from "mongoose";
import { chromium, type Page } from "@playwright/test";
import sharp from "sharp";

const BASE_URL =
  process.env.MARKETING_CAPTURE_BASE_URL ?? "http://localhost:3000";

/** Resolved at runtime: explicit env vars → first SUPER_ADMIN in Mongo →
 *  interactive prompt. Lets `npm run capture:marketing` work with zero
 *  extra arguments once you have a seeded admin. */
let EMAIL =
  process.env.MARKETING_CAPTURE_EMAIL ??
  process.env.BOOTSTRAP_ADMIN_EMAIL ??
  "";
let PASSWORD =
  process.env.MARKETING_CAPTURE_PASSWORD ??
  process.env.BOOTSTRAP_ADMIN_PASSWORD ??
  "";

const OUT_DIR = path.resolve(process.cwd(), "public/marketing");

// Marketing visuals look best framed at 1440×900-ish; the hero mock
// renders in a ~600px column on desktop, so 1440 wide gives the
// downsampled screenshot enough density to stay sharp.
const VIEWPORT = { width: 1440, height: 900 };

async function main(): Promise<void> {
  if (!EMAIL) {
    EMAIL = await discoverSuperAdminEmail();
    if (!EMAIL) {
      console.error(
        "[capture] No SUPER_ADMIN found in MongoDB and MARKETING_CAPTURE_EMAIL is not set.\n" +
          "         Run `npm run seed` first, or export MARKETING_CAPTURE_EMAIL=...",
      );
      process.exit(1);
    }
    console.log(`[capture] using admin email from Mongo: ${EMAIL}`);
  }
  if (!PASSWORD) {
    PASSWORD = await promptHidden(`[capture] password for ${EMAIL}: `);
    if (!PASSWORD) {
      console.error("[capture] empty password — aborting.");
      process.exit(1);
    }
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2, // retina-style crispness in the landing
    colorScheme: "light",
  });
  const page = await context.newPage();

  try {
    await ensureServerReachable(page);
    await signIn(page);

    // 1) Dashboard — always present, even on a fresh DB
    await capture(page, "/app/dashboard", "dashboard.webp");

    // 2) Orders list — present even if empty (renders empty state)
    await capture(page, "/app/orders", "orders-list.webp");

    // 3) First order's detail (and evidence) — only if any exist
    const firstOrderId = await pickFirstOrderId(page);
    if (firstOrderId) {
      await capture(page, `/app/orders/${firstOrderId}`, "order-detail.webp");
      await capture(
        page,
        `/app/orders/${firstOrderId}/evidence`,
        "evidence-chain.webp",
      );
    } else {
      // No orders → the landing's Lifecycle + Fight-Disputes sections
      // would 404 if we leave those filenames missing. Fall back to
      // the closest real surface so the landing always has a coherent
      // visual; the next capture run (after seeding orders/disputes)
      // overwrites these with the real screenshots.
      console.warn(
        "[capture] no orders found — falling back order-detail.webp ← orders-list.webp",
      );
      fallback("orders-list.webp", "order-detail.webp");
    }

    // 4) Admin disputes page — renders even when no disputes exist
    await capture(page, "/app/admin/disputes", "disputes-admin.webp");

    // If no real evidence-chain screenshot exists, mirror the disputes
    // admin page into its slot — same reasoning as above.
    if (!fs.existsSync(path.join(OUT_DIR, "evidence-chain.webp"))) {
      console.warn(
        "[capture] no evidence chain found — falling back evidence-chain.webp ← disputes-admin.webp",
      );
      fallback("disputes-admin.webp", "evidence-chain.webp");
    }

    console.log(`[capture] done. Wrote screenshots to ${OUT_DIR}`);
  } finally {
    await browser.close();
  }
}

async function ensureServerReachable(page: Page): Promise<void> {
  try {
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });
  } catch (err) {
    console.error(
      `[capture] Could not reach ${BASE_URL}. Is \`npm run dev\` running?`,
    );
    throw err;
  }
}

async function signIn(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="email"]');
  // Wait for React hydration: if we click submit before the form's
  // onSubmit is bound, the browser falls back to a plain GET form
  // submission and the credentials land in the URL bar. 1.2s covers
  // dev-mode hydration on a $5 box without making the script slow.
  await page.waitForTimeout(1_200);

  await page.fill('input[type="email"], input[name="email"]', EMAIL);
  await page.fill('input[type="password"], input[name="password"]', PASSWORD);

  // Generous timeout: dev-mode Turbopack compiles /app/dashboard on
  // first hit (often 20-40s on a cold cache). Subsequent runs are
  // fast — this only matters for the very first capture.
  await Promise.all([
    page.waitForURL(/\/app\//, { timeout: 180_000 }),
    page.click('button[type="submit"]'),
  ]);
  console.log("[capture] signed in.");
}

async function pickFirstOrderId(page: Page): Promise<string | null> {
  await page.goto(`${BASE_URL}/app/orders`, { waitUntil: "domcontentloaded" });
  // The table renders client-side after the RSC payload streams in.
  // Sample every `/app/orders/<24-hex>` href until we see one, with an
  // 8s ceiling so a broken render doesn't hang the script.
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const hrefs = await page
      .locator('a[href^="/app/orders/"]')
      .evaluateAll((nodes) =>
        nodes
          .map((n) => (n as HTMLAnchorElement).getAttribute("href"))
          .filter((h): h is string => !!h),
      );
    const match = hrefs
      .map((h) => h.match(/^\/app\/orders\/([a-f0-9]{24})(?:\/|$)/i)?.[1])
      .find(Boolean);
    if (match) return match;
    await page.waitForTimeout(500);
  }
  return null;
}

function fallback(srcName: string, dstName: string): void {
  const src = path.join(OUT_DIR, srcName);
  const dst = path.join(OUT_DIR, dstName);
  if (!fs.existsSync(src)) return;
  fs.copyFileSync(src, dst);
  console.log(
    `[capture] fallback → ${path.relative(process.cwd(), dst)} (copied from ${srcName})`,
  );
}

async function capture(
  page: Page,
  route: string,
  filename: string,
): Promise<void> {
  const url = `${BASE_URL}${route}`;
  // Cold Turbopack compile per route can be 20-40s in dev mode; bump
  // the navigation timeout accordingly. Production builds don't need
  // this margin.
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 180_000 });
  // The (app) shell mounts an SSE connection that keeps the network
  // "active" indefinitely, so we deliberately don't wait on
  // `networkidle`. A short fixed delay covers RSC streaming + React
  // Query hydration + reveal-on-scroll without coupling to the
  // socket.
  await page.waitForTimeout(2500);
  const out = path.join(OUT_DIR, filename);
  // Playwright captures PNG natively; pipe through sharp to encode as
  // WebP at quality 82. Files end up ~70% smaller than the equivalent
  // PNG with no visible artefact at landing-page render sizes.
  const png = await page.screenshot({
    fullPage: false,
    clip: { x: 0, y: 0, ...VIEWPORT },
    type: "png",
  });
  await sharp(png).webp({ quality: 82, effort: 5 }).toFile(out);
  console.log(`[capture] ${route} → ${path.relative(process.cwd(), out)}`);
}

/**
 * Connect briefly to Mongo using the existing connection string and
 * pull the email of the lowest-id SUPER_ADMIN. Disconnects before
 * returning so the Playwright phase doesn't share the connection.
 * Returns "" if Mongo isn't reachable or no SUPER_ADMIN exists.
 */
async function discoverSuperAdminEmail(): Promise<string> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return "";
  try {
    await mongoose.connect(uri, {
      dbName: process.env.MONGODB_DB,
      serverSelectionTimeoutMS: 5_000,
    });
    const db = mongoose.connection.db;
    if (!db) return "";
    const doc = await db
      .collection("users")
      .findOne(
        { role: "SUPER_ADMIN", status: "ACTIVE" },
        { projection: { email: 1 }, sort: { _id: 1 } },
      );
    return (doc?.email as string | undefined) ?? "";
  } catch (err) {
    console.warn(
      "[capture] could not auto-discover admin from Mongo:",
      err instanceof Error ? err.message : err,
    );
    return "";
  } finally {
    try {
      await mongoose.disconnect();
    } catch {
      // already disconnected
    }
  }
}

/**
 * Prompt for a password with no echo. Mirrors the pattern in
 * `scripts/seed.ts` so the interactive UX is consistent.
 */
async function promptHidden(question: string): Promise<string> {
  if (!input.isTTY) {
    // Non-interactive shell — there's no usable hidden-input mode.
    console.error(
      "[capture] stdin is not a TTY; supply MARKETING_CAPTURE_PASSWORD via env.",
    );
    process.exit(1);
  }
  const rl = readline.createInterface({ input, output });
  // Mute stdout while typing the password — readline echoes each char
  // otherwise. Re-enable on completion.
  const stdoutAny = output as unknown as {
    write: (s: string) => boolean;
    isTTY: boolean;
    _writeToOutput?: (s: string) => void;
  };
  const original = stdoutAny.write.bind(stdoutAny);
  let muted = false;
  stdoutAny.write = (s: string) => {
    if (muted && s !== "\n" && s !== "\r\n") return true;
    return original(s);
  };
  output.write(question);
  muted = true;
  const value = await rl.question("");
  muted = false;
  stdoutAny.write = original;
  output.write("\n");
  rl.close();
  return value.trim();
}

main().catch((err) => {
  console.error("[capture] failed:", err);
  process.exit(1);
});
