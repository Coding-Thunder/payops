import { test, expect } from "@playwright/test";

import { getSmokeCreds, loginAs } from "./_helpers";

/**
 * Smallest possible smoke: the server is alive, the login form exists,
 * and a seeded admin can authenticate and land on the dashboard.
 *
 * If this file fails every other smoke spec will fail too, keep it
 * first so a broken environment surfaces cheaply.
 */

test.describe("system health + login", () => {
  test("GET /api/health returns 200", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("unauthenticated visit to / serves the public marketing page", async ({
    page,
  }) => {
    // `/` stopped redirecting to /login when the authed product moved behind
    // the `/app` prefix so the root could serve marketing (see src/proxy.ts).
    const res = await page.goto("/");
    expect(res?.status()).toBeLessThan(400);
    await expect(page).toHaveURL(/:\d+\/$/);
  });

  test("unauthenticated visit to /app/dashboard redirects to /login", async ({
    page,
  }) => {
    await page.goto("/app/dashboard");
    await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fdashboard/);
  });

  test("admin can authenticate and reach the dashboard", async ({ page }) => {
    const { admin } = getSmokeCreds();
    await loginAs(page, admin);
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("invalid credentials are rejected", async ({ request }) => {
    // Asserted at the API: /login renders the Firebase form, which is inert
    // without NEXT_PUBLIC_FIREBASE_* and cannot be driven in a smoke run.
    const res = await request.post("/api/auth/login", {
      data: { email: "nobody@tracetxn.test", password: "WrongPass1234" },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});
