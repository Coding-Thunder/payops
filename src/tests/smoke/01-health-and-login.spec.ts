import { test, expect } from "@playwright/test";

import { getSmokeCreds, loginAs } from "./_helpers";

/**
 * Smallest possible smoke: the server is alive, the login form exists,
 * and a seeded admin can authenticate and land on the dashboard.
 *
 * If this file fails every other smoke spec will fail too — keep it
 * first so a broken environment surfaces cheaply.
 */

test.describe("system health + login", () => {
  test("GET /api/health returns 200", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("unauthenticated visit to / redirects to /login", async ({ page }) => {
    const res = await page.goto("/");
    expect(res?.status()).toBeLessThan(400);
    await expect(page).toHaveURL(/\/login/);
  });

  test("admin can log in via the UI and reach the dashboard", async ({ page }) => {
    const { admin } = getSmokeCreds();
    await loginAs(page, admin);
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("invalid credentials surface an inline error and stay on /login", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel(/work email/i).fill("nobody@tracetxn.test");
    await page.getByLabel(/password/i).fill("WrongPass1234");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByText(/invalid email or password/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });
});
