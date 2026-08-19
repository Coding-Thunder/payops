import { test, expect } from "@playwright/test";

import { getSmokeCreds, loginAs } from "./_helpers";

/**
 * Platform super-admin console at /admin — the cross-boundary contract.
 *
 * The console was merged in from a standalone Next app. These assertions pin
 * the four things that break if the proxy exemption, the redirect targets or
 * the layout scoping regress:
 *
 *   1. /admin is PUBLIC and renders the console's own login form. If the
 *      proxy gated it, the login page itself would 307 to /login and nobody
 *      could ever sign in.
 *   2. A protected console page with no admin_session bounces to /admin —
 *      the console's login — never to the tenant /login.
 *   3. The console's API is namespaced under /admin/api and does not collide
 *      with the main app's /api.
 *   4. A tenant session grants nothing in the console: the two apps have
 *      separate cookies, and holding one must not admit you to the other.
 */

test.describe("platform console", () => {
  test("GET /admin is public and renders the console login", async ({
    page,
  }) => {
    const res = await page.goto("/admin");
    expect(res?.status()).toBe(200);
    await expect(page).toHaveURL(/\/admin$/);
    await expect(
      page.getByRole("heading", { name: /tracetxn admin/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /email me a code/i }),
    ).toBeVisible();
  });

  test("a protected console page redirects to the console login, not /login", async ({
    page,
  }) => {
    await page.goto("/admin/dashboard");
    // Carries the intended destination so login can return the operator there.
    await expect(page).toHaveURL(/\/admin\?next=%2Fadmin%2Fdashboard$/);
  });

  test("the console API is namespaced under /admin/api and 404s otherwise", async ({
    request,
  }) => {
    // `/admin/api/health` was a leftover probe from when the console was its
    // own DigitalOcean app. The merged app has one health endpoint.
    expect((await request.get("/admin/api/health")).status()).toBe(404);
    expect((await request.get("/api/health")).status()).toBe(200);
  });

  test("a console API route refuses a request with no admin session", async ({
    request,
  }) => {
    const res = await request.post("/admin/api/notes", {
      data: { subjectType: "user", subjectId: "x", body: "nope" },
    });
    expect(res.status()).toBe(401);
  });

  test("a tenant ADMIN session does not admit you to the console", async ({
    page,
  }) => {
    const { admin } = getSmokeCreds();
    await loginAs(page, admin);
    await page.goto("/admin/dashboard");
    // Separate cookie, separate allow-list — the tenant session is invisible
    // to the console guard.
    await expect(page).toHaveURL(/\/admin\?next=/);
  });

  test("the console does not repaint the main app", async ({ page }) => {
    // The console's palette is scoped to [data-console="admin"]. If it ever
    // leaks back onto :root/body, the marketing page turns dark. Soft-navigate
    // console -> marketing, which is the case CSS chunking makes fragile.
    await page.goto("/admin");
    await page.goto("/");
    const bodyBg = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );
    // #0b1220 — the console background. Anything else is fine.
    expect(bodyBg).not.toBe("rgb(11, 18, 32)");
  });
});
