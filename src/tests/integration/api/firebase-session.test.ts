import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecordState, UserRole } from "@/lib/constants/enums";
import { POST as firebaseSessionRoute } from "@/app/api/auth/firebase-session/route";
import { Organization, User } from "@/server/db/models";
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

function post(extraBody: Record<string, unknown> = {}) {
  return firebaseSessionRoute(
    buildRequest("/api/auth/firebase-session", {
      method: "POST",
      // `intent` is what the real form sends; it selects the wording of a
      // refusal and never the authorization.
      body: { idToken: "x".repeat(40), ...extraBody },
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

describe("POST /api/auth/firebase-session — public signup", () => {
  /**
   * The route is the only place the signup MODE is consulted; `firebaseExchange`
   * just obeys the `allowSignup` it is handed. So this is where opening signup
   * has to be proved, and where a regression would hide: every service-level
   * test passes `allowSignup` explicitly and would stay green if the route
   * stopped reading the mode at all.
   */
  let savedMode: string | undefined;

  beforeEach(() => {
    savedMode = process.env.SIGNUP_MODE;
    delete process.env.SIGNUP_MODE;
  });
  afterEach(() => {
    if (savedMode === undefined) delete process.env.SIGNUP_MODE;
    else process.env.SIGNUP_MODE = savedMode;
  });

  /** A verified identity for an address with no account — a brand-new user. */
  function newVerifiedUser() {
    return adminAuthWith(async () => ({
      uid: "uid_brand_new",
      email: "brand.new@example.test",
      email_verified: true,
      name: "Brand New",
    }));
  }

  it("provisions a stranger with NO invitation, in public mode", async () => {
    mockGetAdminAuth.mockReturnValue(newVerifiedUser());

    const { status, body } = await jsonBody(await post({ intent: "signup" }));

    expect(status).toBe(200);
    expect((body as { data?: { isNewUser?: boolean } }).data?.isNewUser).toBe(true);
    // The account really exists, not just a 200.
    expect(
      await User.countDocuments({ email: "brand.new@example.test" }),
    ).toBe(1);
  });

  it("still refuses a stranger when SIGNUP_MODE=invite_only", async () => {
    process.env.SIGNUP_MODE = "invite_only";
    mockGetAdminAuth.mockReturnValue(newVerifiedUser());

    const { status, body } = await jsonBody(await post({ intent: "signup" }));

    expect(status).toBe(403);
    expect(JSON.stringify(body)).toMatch(/invite-only/i);
    // And nothing was created on the way to refusing.
    expect(
      await User.countDocuments({ email: "brand.new@example.test" }),
    ).toBe(0);
  });

  it("still refuses an UNVERIFIED email even with signup open", async () => {
    // The whole safety of opening signup rests on this: the public door is
    // the ownership-proving one. An email/password identity arrives
    // unverified, and no amount of openness may provision it.
    mockGetAdminAuth.mockReturnValue(
      adminAuthWith(async () => ({
        uid: "uid_unverified",
        email: "unverified@example.test",
        email_verified: false,
      })),
    );

    const { status, body } = await jsonBody(await post());

    expect(status).toBe(401);
    expect(JSON.stringify(body)).toMatch(/verify your email/i);
    expect(
      await User.countDocuments({ email: "unverified@example.test" }),
    ).toBe(0);
  });

  it("does not create a second account when a signup is retried", async () => {
    mockGetAdminAuth.mockReturnValue(newVerifiedUser());

    const first = await jsonBody(await post({ intent: "signup" }));
    const second = await jsonBody(await post({ intent: "signup" }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // The second call matches the existing row by uid, so it signs in rather
    // than provisioning again.
    expect(
      (second.body as { data?: { isNewUser?: boolean } }).data?.isNewUser,
    ).toBe(false);
    expect(
      await User.countDocuments({ email: "brand.new@example.test" }),
    ).toBe(1);
  });

  /**
   * The regression that opening signup introduced, and the reason
   * `allowSignup` is conjoined with the intent rather than set from the mode
   * alone.
   *
   * /login posts through this same route with no invite code. When
   * `allowSignup` came from `signupAllowed(inviteCode)` by itself — true for
   * everyone in public mode — a returning customer who authenticated as the
   * WRONG Google identity was silently provisioned a new empty workspace and
   * navigated into it, instead of being told which address their workspace
   * belongs to. The refusal message exists precisely for that case; this
   * keeps it reachable.
   */
  it("does NOT provision from a sign-in, even with signup wide open", async () => {
    mockGetAdminAuth.mockReturnValue(newVerifiedUser());

    const { status, body } = await jsonBody(await post({ intent: "signin" }));

    expect(status).toBe(403);
    // The message has to name the address and talk about identities, not
    // invitations — a returning user sent to ask for an invite is the bug
    // this whole branch was written to fix.
    expect(JSON.stringify(body)).toMatch(/no tracetxn account is linked/i);
    expect(JSON.stringify(body)).not.toMatch(/invite/i);
    expect(
      await User.countDocuments({ email: "brand.new@example.test" }),
    ).toBe(0);
    expect(await Organization.countDocuments({})).toBe(0);
  });

  it("treats a request with NO intent as a sign-in, not a signup", async () => {
    // A cached bundle mid-deploy, or any direct caller. The safe reading is
    // "signin": it can refuse, but it cannot create a tenant.
    mockGetAdminAuth.mockReturnValue(newVerifiedUser());

    const { status } = await jsonBody(await post());

    expect(status).toBe(403);
    expect(
      await User.countDocuments({ email: "brand.new@example.test" }),
    ).toBe(0);
  });
});
