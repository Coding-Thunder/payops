import { test, expect } from "@playwright/test";

import { getSmokeCreds, loginAs, loginAsApi } from "./_helpers";

/**
 * RBAC smoke, the security boundary the middleware enforces.
 *
 *   - An anonymous visitor to /admin is redirected to /login.
 *   - A STAFF user reaching /admin is bounced to /dashboard.
 *   - A STAFF user calling /api/admin/users via fetch gets a 403 JSON.
 *   - An ADMIN reaching /admin renders the admin overview.
 */

test.describe("middleware RBAC", () => {
  test("anonymous visit to /admin redirects to /login with ?next", async ({
    page,
  }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/login\?next=%2Fadmin/);
  });

  test("STAFF visiting /admin is bounced to /dashboard", async ({ page }) => {
    const { staff } = getSmokeCreds();
    await loginAs(page, staff);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/dashboard/);
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

  test("ADMIN reaches /admin successfully", async ({ page }) => {
    const { admin } = getSmokeCreds();
    await loginAs(page, admin);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin/);
    await expect(page.getByRole("heading").first()).toBeVisible();
  });
});
