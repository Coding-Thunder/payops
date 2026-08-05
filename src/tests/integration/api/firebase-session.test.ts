import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecordState, UserRole } from "@/lib/constants/enums";
import { POST as firebaseSessionRoute } from "@/app/api/auth/firebase-session/route";
import { User } from "@/server/db/models";
import { env } from "@/lib/env";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { mockNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

// Firebase Admin SDK — controllable per test.
vi.mock("@/lib/firebase/admin", () => ({ getFirebaseAdminAuth: vi.fn() }));
// Turnstile bot-check — no-op so the route reaches the Firebase verify.
vi.mock("@/server/auth/turnstile", async (importActual) => ({
  ...(await importActual<typeof import("@/server/auth/turnstile")>()),
  verifyTurnstile: vi.fn().mockResolvedValue(undefined),
}));

import { getFirebaseAdminAuth } from "@/lib/firebase/admin";
const mockGetAdminAuth = vi.mocked(getFirebaseAdminAuth);

type Decoded = Record<string, unknown>;
function adminAuthWith(verify: (idToken: string) => Promise<Decoded>) {
  return { verifyIdToken: vi.fn((t: string) => verify(t)) } as unknown as ReturnType<
    typeof getFirebaseAdminAuth
  >;
}

let handle: Awaited<ReturnType<typeof mockNextHeaders>>;

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
  mockGetAdminAuth.mockReset();
  handle = await mockNextHeaders();
});
afterEach(async () => {
  await handle.restore();
});

function post() {
  return firebaseSessionRoute(
    buildRequest("/api/auth/firebase-session", {
      method: "POST",
      body: { idToken: "x".repeat(40) },
    }),
  );
}

describe("POST /api/auth/firebase-session", () => {
  it("503s when Firebase Admin isn't configured", async () => {
    mockGetAdminAuth.mockReturnValue(null);
    const { status } = await jsonBody(await post());
    expect(status).toBe(503);
  });

  it("401s on an invalid/expired Firebase token", async () => {
    mockGetAdminAuth.mockReturnValue(
      adminAuthWith(async () => {
        throw new Error("token expired");
      }),
    );
    const { status } = await jsonBody(await post());
    expect(status).toBe(401);
  });

  it("401s when the token carries no email claim", async () => {
    mockGetAdminAuth.mockReturnValue(
      adminAuthWith(async () => ({ uid: "uid_no_email" })),
    );
    const { status } = await jsonBody(await post());
    expect(status).toBe(401);
  });

  it("issues a session for a returning user matched by firebaseUid", async () => {
    const uid = "firebase_uid_123";
    await User.create({
      name: "Returning Owner",
      email: "owner@tracetxn.test",
      passwordHash: "$2b$12$" + "x".repeat(53),
      role: UserRole.SUPER_ADMIN,
      status: RecordState.ACTIVE,
      primaryOrgId: new Types.ObjectId(),
      externalAuth: { firebaseUid: uid },
    });
    mockGetAdminAuth.mockReturnValue(
      adminAuthWith(async () => ({
        uid,
        email: "owner@tracetxn.test",
        email_verified: true,
        name: "Returning Owner",
      })),
    );

    const { status, body } = await jsonBody<{
      data: { user: { email: string }; isNewUser: boolean };
    }>(await post());

    expect(status).toBe(200);
    expect(body.data.user.email).toBe("owner@tracetxn.test");
    expect(body.data.isNewUser).toBe(false);
    // A session cookie was actually issued (token verification → cookie).
    expect(handle.cookieJar.has(env.server.COOKIE_NAME)).toBe(true);
  });

  it("401s an unverified email that isn't already linked (takeover guard)", async () => {
    // No pre-existing uid link → firebaseExchange must refuse an unverified
    // email before linking-by-email or provisioning.
    mockGetAdminAuth.mockReturnValue(
      adminAuthWith(async () => ({
        uid: "stranger_uid",
        email: "stranger@tracetxn.test",
        email_verified: false,
      })),
    );
    const { status } = await jsonBody(await post());
    expect(status).toBe(401);
  });
});
