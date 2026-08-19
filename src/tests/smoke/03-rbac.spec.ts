import { test, expect } from "@playwright/test";

import { getSmokeCreds, loginAs, loginAsApi } from "./_helpers";

/**
 * RBAC smoke, the security boundary the proxy enforces.
 *
 *   - An anonymous visitor to /app/admin is redirected to /login.
 *   - A STAFF user reaching /app/admin is bounced to /app/dashboard.
 *   - A STAFF user calling /api/admin/users via fetch gets a 403 JSON.
 *   - An ADMIN reaching /app/admin renders the admin overview.
 *
 * The URLs here are the TENANT (org-level) admin surface. They were written
 * as bare `/admin` before the authed product moved under `/app/`, and `/admin`
 * now serves the platform super-admin console — an entirely different
 * boundary with its own session (covered by 06-console.spec.ts).
 */

test.describe("proxy RBAC", () => {
  test("anonymous visit to /app/admin redirects to /login with ?next", async ({
    page,
  }) => {
    await page.goto("/app/admin");
    await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fadmin/);
  });

  test("STAFF visiting /app/admin is bounced to the dashboard", async ({
    page,
  }) => {
    const { staff } = getSmokeCreds();
    await loginAs(page, staff);
    await page.goto("/app/admin");
    await expect(page).toHaveURL(/\/app\/dashboard/);
  });

  test("STAFF calling /api/admin/users returns 403 JSON", async ({
    request,
  }) => {
    const { staff } = getSmokeCreds();
    await loginAsApi(request, staff);
    const res = await request.get("/api/admin/users");
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("ADMIN reaches /app/admin successfully", async ({ page }) => {
    const { admin } = getSmokeCreds();
    await loginAs(page, admin);
    await page.goto("/app/admin");
    await expect(page).toHaveURL(/\/app\/admin/);
    await expect(page.getByRole("heading").first()).toBeVisible();
  });
});
