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
