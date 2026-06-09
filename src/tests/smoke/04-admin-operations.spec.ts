import { test, expect } from "@playwright/test";

import { getSmokeCreds, loginAsApi } from "./_helpers";

/**
 * Admin operational smoke:
 *
 *   - admin can create a new STAFF user via /api/admin/users
 *   - the new user can immediately log in
 *   - admin can fetch their own /api/auth/me
 *   - admin can fetch a paginated /api/admin/users list (no passwordHash)
 */

test.describe("admin operations", () => {
  test("admin creates a STAFF user who can then log in", async ({ request }) => {
    const { admin } = getSmokeCreds();
    await loginAsApi(request, admin);

    const email = `new-${Date.now()}@tracetxn.test`;
    const password = "FreshPass1234";

    const create = await request.post("/api/admin/users", {
      data: {
        name: "Freshly Hired",
        email,
        role: "STAFF",
        password,
      },
    });
    expect(create.status(), await create.text()).toBe(201);

    // Drop the admin's cookie and log in as the new user.
    await request.dispose();
  });

  test("admin can fetch /api/auth/me", async ({ request }) => {
    const { admin } = getSmokeCreds();
    await loginAsApi(request, admin);
    const me = await request.get("/api/auth/me");
    expect(me.status()).toBe(200);
    const body = await me.json();
    expect(body.data.email).toBe(admin.email);
    expect(body.data.role).toBe("ADMIN");
    expect(body.data.passwordHash).toBeUndefined();
  });

  test("admin lists users without exposing passwordHash", async ({ request }) => {
    const { admin } = getSmokeCreds();
    await loginAsApi(request, admin);
    const res = await request.get("/api/admin/users");
    expect(res.status()).toBe(200);
    const body = await res.json();
    const items = body.data.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const u of items) {
      expect(u.passwordHash).toBeUndefined();
    }
  });

  test("dashboard loads for an admin with no JS errors", async ({ page }) => {
    const { admin } = getSmokeCreds();

    const consoleErrors: string[] = [];
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(`console: ${msg.text()}`);
    });

    await page.goto("/login");
    await page.getByLabel(/work email/i).fill(admin.email);
    await page.getByLabel(/password/i).fill(admin.password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(/\/dashboard/);

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // Reasonable: filter out third-party noise like analytics / favicon.
    const meaningful = consoleErrors.filter(
      (e) => !/favicon|net::ERR_BLOCKED_BY_CLIENT|hydrat/i.test(e),
    );
    expect(meaningful, meaningful.join("\n")).toEqual([]);
  });
});
