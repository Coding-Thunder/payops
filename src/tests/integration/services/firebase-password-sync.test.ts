import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every flow that sets a tenant password must also set it in Firebase Auth.
 *
 * /login renders FirebaseAuthForm and calls `signInWithEmailAndPassword`, so
 * Firebase is the store browser sign-in reads. Four services write a bcrypt
 * hash to Mongo; each one that writes a REAL password must keep Firebase in
 * step, or the user is told the password they just chose is wrong.
 *
 * The reset flow was fixed first, but that alone left the bug live for the
 * biggest population: beta activation. A founder redeeming an invite got a
 * Mongo-only account, landed on the dashboard with a session, and only
 * discovered the problem on their NEXT visit to /login.
 */

const firebaseAuth = {
  getUserByEmail: vi.fn(),
  updateUser: vi.fn(),
  createUser: vi.fn(),
  revokeRefreshTokens: vi.fn(),
};
vi.mock("@/lib/firebase/admin", () => ({
  getFirebaseAdminAuth: () => firebaseAuth,
  isFirebaseAdminConfigured: () => true,
}));

import { syncFirebasePassword } from "@/server/auth/firebase-password";

beforeEach(() => {
  firebaseAuth.getUserByEmail.mockReset();
  firebaseAuth.updateUser.mockReset().mockResolvedValue({ uid: "u" });
  firebaseAuth.createUser.mockReset().mockResolvedValue({ uid: "new-uid" });
  firebaseAuth.revokeRefreshTokens.mockReset().mockResolvedValue(undefined);
});

describe("syncFirebasePassword", () => {
  it("verifies the email on BOTH branches", async () => {
    // The update branch is the one that used to omit it, which produced a
    // Firebase login that /api/auth/firebase-session still refused.
    firebaseAuth.getUserByEmail.mockResolvedValue({ uid: "existing-uid" });
    await syncFirebasePassword("a@x.test", "Pass123456");
    expect(firebaseAuth.updateUser).toHaveBeenCalledWith("existing-uid", {
      password: "Pass123456",
      emailVerified: true,
    });

    firebaseAuth.getUserByEmail.mockRejectedValue(
      Object.assign(new Error("nope"), { code: "auth/user-not-found" }),
    );
    await syncFirebasePassword("b@x.test", "Pass123456");
    expect(firebaseAuth.createUser).toHaveBeenCalledWith({
      email: "b@x.test",
      password: "Pass123456",
      emailVerified: true,
    });
  });

  it("revokes refresh tokens when updating an existing identity", async () => {
    firebaseAuth.getUserByEmail.mockResolvedValue({ uid: "existing-uid" });
    await syncFirebasePassword("a@x.test", "Pass123456");
    expect(firebaseAuth.revokeRefreshTokens).toHaveBeenCalledWith(
      "existing-uid",
    );
  });

  it("rethrows a non-user-not-found failure so callers can abort", async () => {
    // Callers rely on this: they run the sync BEFORE their Mongo write, so a
    // throw here must leave their own state untouched and the link/invite
    // still usable.
    firebaseAuth.getUserByEmail.mockRejectedValue(
      Object.assign(new Error("backend down"), { code: "auth/internal-error" }),
    );
    await expect(syncFirebasePassword("a@x.test", "P")).rejects.toThrow(
      "backend down",
    );
    expect(firebaseAuth.createUser).not.toHaveBeenCalled();
  });
});

describe("every real-password writer calls the sync", () => {
  it("is wired into signup, team-invite, password-reset and admin reset", async () => {
    // A source-level guard, deliberately. The bug was not that any one flow
    // was wrong — it was that a NEW writer could be added later and silently
    // skip Firebase, which is exactly how activation stayed broken after the
    // reset flow was fixed. If you add a service that writes a real password,
    // add it here.
    const fs = await import("node:fs/promises");
    const writers = [
      "signup.service.ts",
      "team-invite.service.ts",
      "password-reset.service.ts",
      "user.service.ts",
    ];
    for (const f of writers) {
      const src = await fs.readFile(`src/server/services/${f}`, "utf8");
      expect(src, `${f} writes a password without syncing Firebase`).toContain(
        "await syncFirebasePassword(",
      );
    }
  });
});
