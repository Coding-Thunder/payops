import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { type APIRequestContext, type Page, expect } from "@playwright/test";

/**
 * Smoke test helpers shared by every spec.
 *
 *   - `getSmokeCreds()` returns the seeded admin/staff credentials the
 *     global-setup file wrote to `reports/.smoke-creds.json`.
 *   - `loginAs(page, user)` drives the real login form. Returns once the
 *     dashboard has rendered.
 *   - `loginAsApi(request, user)` short-circuits the UI for tests that
 *     don't care about the login flow itself — POSTs /api/auth/login and
 *     hands the request context back with the cookie set.
 *   - `postSignedWebhook(request, event)` signs a Stripe event with the
 *     smoke webhook secret and posts it to /api/webhooks/stripe.
 *
 * All helpers are typed end-to-end so a forgotten field surfaces at
 * compile time, not at a flaky 2 am CI run.
 */

const CREDS_FILE = path.resolve(process.cwd(), "reports/.smoke-creds.json");

export interface SmokeUser {
  id: string;
  email: string;
  password: string;
  role: "SUPER_ADMIN" | "ADMIN" | "STAFF";
}

export interface SmokeCreds {
  admin: SmokeUser;
  staff: SmokeUser;
  webhookSecret: string;
  baseUrl: string;
}

let cached: SmokeCreds | null = null;

export function getSmokeCreds(): SmokeCreds {
  if (cached) return cached;
  if (!fs.existsSync(CREDS_FILE)) {
    throw new Error(
      `[smoke] credentials file missing — did playwright.global-setup.ts run? Expected ${CREDS_FILE}`,
    );
  }
  cached = JSON.parse(fs.readFileSync(CREDS_FILE, "utf8")) as SmokeCreds;
  return cached;
}

export async function loginAs(page: Page, user: SmokeUser): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/work email/i).fill(user.email);
  await page.getByLabel(/password/i).fill(user.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/(dashboard|admin)/);
}

export async function loginAsApi(
  request: APIRequestContext,
  user: SmokeUser,
): Promise<void> {
  const res = await request.post("/api/auth/login", {
    data: { email: user.email, password: user.password },
  });
  expect(res.status(), `login failed for ${user.email}`).toBe(200);
}

export async function postSignedWebhook(
  request: APIRequestContext,
  event: unknown,
): Promise<{ status: number; body: unknown }> {
  const { webhookSecret } = getSmokeCreds();
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = crypto
    .createHmac("sha256", webhookSecret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  const res = await request.post("/api/webhooks/stripe", {
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${sig}`,
    },
    data: payload,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  return { status: res.status(), body };
}

export function buildCompletedEvent(args: {
  orderId: string;
  orderNumber: string;
  sessionId: string;
  amount: number;
  currency?: string;
}): Record<string, unknown> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    id: `evt_smoke_${ts}_${Math.floor(Math.random() * 1e6)}`,
    object: "event",
    api_version: "2024-06-20",
    created: ts,
    type: "checkout.session.completed",
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: args.sessionId,
        object: "checkout.session",
        mode: "payment",
        status: "complete",
        client_reference_id: args.orderId,
        customer_email: "smoke@tracetxn.test",
        payment_intent: `pi_smoke_${ts}`,
        amount_total: Math.round(args.amount * 100),
        currency: args.currency ?? "usd",
        metadata: { orderId: args.orderId, orderNumber: args.orderNumber },
      },
    },
  };
}
