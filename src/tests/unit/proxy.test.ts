// @vitest-environment node
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { proxy } from "@/proxy";

function reqFor(path: string) {
  // No session cookie → unauthenticated customer/visitor.
  return new NextRequest(new URL(`https://app.example.com${path}`));
}

/**
 * The auth gate (Next 16 `proxy`) must let customer-facing, token-bound
 * surfaces through WITHOUT a staff session. Regression guard for the P0 where
 * the confirmation email's "I Agree" link (/acknowledge) 307'd customers to
 * the internal /login.
 */
describe("proxy auth gate — public customer surfaces", () => {
  it("lets the acknowledge page through without a session", async () => {
    const res = await proxy(reqFor("/acknowledge/sometoken"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("lets the acknowledge API through without a session", async () => {
    const res = await proxy(reqFor("/api/acknowledge/sometoken"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("keeps the consent page public (regression)", async () => {
    const res = await proxy(reqFor("/consent/sometoken"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("keeps the pay surfaces public (regression)", async () => {
    const res = await proxy(reqFor("/pay/success"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("STILL redirects a protected /app route to /login without a session", async () => {
    const res = await proxy(reqFor("/app/orders"));
    expect(res.headers.get("location")).toContain("/login");
  });
});

describe("proxy auth gate — API calls without a session", () => {
  it("answers 401 JSON instead of redirecting to the login page", async () => {
    const res = await proxy(reqFor("/api/orders"));
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("does the same for an invalid session cookie", async () => {
    const req = new NextRequest(new URL("https://app.example.com/api/orders/x/modify"), {
      method: "POST",
      headers: { cookie: `${process.env.COOKIE_NAME || "payops_session"}=not-a-jwt` },
    });
    const res = await proxy(req);
    expect(res.status).toBe(401);
  });
});

describe("proxy auth gate — the client router's own requests", () => {
  it("answers a signed-out RSC request with a bare 401, not a redirect", async () => {
    const req = new NextRequest(new URL("https://app.example.com/app/orders/create?_rsc=abc"), {
      headers: { rsc: "1" },
    });
    const res = await proxy(req);
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    // Not a flight response, so the router falls back to a full page load.
    expect(res.headers.get("content-type") ?? "").not.toContain("text/x-component");
  });

  it("still redirects the full page load that follows", async () => {
    const res = await proxy(reqFor("/app/orders/create"));
    expect(res.headers.get("location")).toContain("/login");
  });
});
