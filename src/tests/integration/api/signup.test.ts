import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserRole } from "@/lib/constants/enums";
import {
  Organization,
  OrgMember,
  OrgStatus,
  User,
} from "@/server/db/models";
import { POST as signupRoute } from "@/app/api/auth/signup/route";
import { buildRequest, expectOk, jsonBody } from "@/tests/utils/api";
import { mockNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * Phase 4: public self-serve signup.
 *
 * We exercise the route via its `POST` handler directly (no HTTP
 * server). The route delegates to `signupFounder` which is the unit
 * under test for atomicity + slug uniqueness + email uniqueness.
 */

let headers: Awaited<ReturnType<typeof mockNextHeaders>>;

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
  headers = await mockNextHeaders();
});

afterEach(async () => {
  await headers.restore();
});

const validPayload = {
  name: "Ada Lovelace",
  email: "ada@acme.test",
  password: "Hunter2Hunter2",
  orgName: "Acme Rentals",
};

describe("POST /api/auth/signup", () => {
  it("creates an org, user, and member atomically, returns the founder + slug", async () => {
    const res = await signupRoute(
      buildRequest("/api/auth/signup", {
        method: "POST",
        body: validPayload,
      }),
    );
    const { status, body } = await jsonBody(res);
    expect(status).toBe(200);
    expectOk(body as never);

    const data = (body as {
      data: {
        user: { email: string; role: string };
        orgId: string;
        orgSlug: string;
      };
    }).data;
    expect(data.user.email).toBe("ada@acme.test");
    expect(data.user.role).toBe(UserRole.SUPER_ADMIN);
    expect(data.orgSlug).toBe("acme-rentals");

    // All three documents exist and are linked.
    const user = await User.findOne({ email: "ada@acme.test" }).lean<{
      _id: unknown;
      role: string;
      primaryOrgId: unknown;
    }>();
    expect(user).toBeTruthy();
    expect(user?.role).toBe(UserRole.SUPER_ADMIN);
    expect(String(user?.primaryOrgId)).toBe(data.orgId);

    const org = await Organization.findById(data.orgId).lean<{
      slug: string;
      ownerUserId: unknown;
      status: string;
    }>();
    expect(org?.slug).toBe("acme-rentals");
    expect(String(org?.ownerUserId)).toBe(String(user!._id));
    expect(org?.status).toBe(OrgStatus.ACTIVE);

    const member = await OrgMember.findOne({
      orgId: data.orgId,
      userId: user!._id as never,
    }).lean<{ role: string; status: string }>();
    expect(member?.role).toBe(UserRole.SUPER_ADMIN);
    expect(member?.status).toBe("ACTIVE");
  });

  it("sets the session cookie so the founder lands logged-in", async () => {
    await signupRoute(
      buildRequest("/api/auth/signup", {
        method: "POST",
        body: validPayload,
      }),
    );
    // Cookie name comes from env; default is `tracetxn_session`.
    expect(headers.cookieJar.has("tracetxn_session")).toBe(true);
  });

  it("disambiguates duplicate org names with a numeric suffix", async () => {
    await signupRoute(
      buildRequest("/api/auth/signup", {
        method: "POST",
        body: { ...validPayload, email: "first@x.test" },
      }),
    );
    const second = await signupRoute(
      buildRequest("/api/auth/signup", {
        method: "POST",
        body: { ...validPayload, email: "second@x.test" },
      }),
    );
    const { status, body } = await jsonBody(second);
    expect(status).toBe(200);
    expect((body as { data: { orgSlug: string } }).data.orgSlug).toBe(
      "acme-rentals-2",
    );
  });

  it("refuses to register a duplicate email, generic message (no enumeration)", async () => {
    await signupRoute(
      buildRequest("/api/auth/signup", {
        method: "POST",
        body: validPayload,
      }),
    );
    const dupe = await signupRoute(
      buildRequest("/api/auth/signup", {
        method: "POST",
        body: { ...validPayload, orgName: "Different Co" },
      }),
    );
    const { status } = await jsonBody(dupe);
    expect(status).toBe(409);

    // Only one user, one org with that founder.
    const userCount = await User.countDocuments({
      email: validPayload.email,
    });
    expect(userCount).toBe(1);
    const orgCount = await Organization.countDocuments({
      name: "Different Co",
    });
    expect(orgCount).toBe(0);
  });

  it("422 on a short password", async () => {
    const res = await signupRoute(
      buildRequest("/api/auth/signup", {
        method: "POST",
        body: { ...validPayload, password: "short" },
      }),
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(422);
  });

  it("422 on a missing org name", async () => {
    const res = await signupRoute(
      buildRequest("/api/auth/signup", {
        method: "POST",
        body: { ...validPayload, orgName: "" },
      }),
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(422);
  });

  it("422 on a malformed email", async () => {
    const res = await signupRoute(
      buildRequest("/api/auth/signup", {
        method: "POST",
        body: { ...validPayload, email: "not-an-email" },
      }),
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(422);
  });

  it("normalises a name with punctuation/whitespace into a valid slug", async () => {
    const res = await signupRoute(
      buildRequest("/api/auth/signup", {
        method: "POST",
        body: { ...validPayload, orgName: "  !! Foo & Bar !! " },
      }),
    );
    const { body } = await jsonBody(res);
    expect((body as { data: { orgSlug: string } }).data.orgSlug).toBe(
      "foo-bar",
    );
  });

  it("prepends a letter when the slug would start with a digit", async () => {
    const res = await signupRoute(
      buildRequest("/api/auth/signup", {
        method: "POST",
        body: { ...validPayload, orgName: "404 Studios" },
      }),
    );
    const { body } = await jsonBody(res);
    expect(
      (body as { data: { orgSlug: string } }).data.orgSlug.startsWith("o-"),
    ).toBe(true);
  });
});

