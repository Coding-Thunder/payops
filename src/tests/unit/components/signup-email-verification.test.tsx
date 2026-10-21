import { describe, expect, it, vi, beforeEach } from "vitest";

import { renderWithUser, screen, waitFor } from "@/tests/utils/render";

/**
 * J3: a validly invited new user signing up with email + password.
 *
 * ── The dead end this covers ─────────────────────────────────────────────
 *
 * `createUserWithEmailAndPassword` mints an identity with emailVerified=false.
 * In `firebaseExchange` the unverified-email throw sits ELEVEN lines before
 * `allowSignup` is read, so a correct invite code was never consulted — and a
 * repo-wide grep for `sendEmailVerification` and every sibling API returned
 * zero hits, so the gate was unsatisfiable. A validly invited user was
 * refused permanently, and the Firebase identity they had just created was
 * left orphaned — the same orphan state that produces "No TraceTxn account is
 * linked to …" on a later sign-in attempt.
 *
 * Reproduced in a real browser against real Firebase before the fix
 * (401 "Please verify your email address with your sign-in provider before
 * continuing."). The fix could NOT be re-confirmed in the browser afterwards,
 * because Firebase began throttling account creation from this IP
 * (auth/too-many-requests) — its own abuse protection working. Hence this
 * file: the evidence for the fix is mocked, and labelled as such.
 *
 * The emailVerified gate is deliberately NOT weakened anywhere. It is the
 * guard against stamping a stranger's UID onto an existing account; this path
 * satisfies it instead of routing around it.
 */

const createUserWithEmailAndPassword = vi.fn();
const signInWithEmailAndPassword = vi.fn();
const sendEmailVerification = vi.fn(async (...a: unknown[]) => {
  void a;
});
const signOut = vi.fn(async (auth: unknown) => {
  void auth;
});
const apiPost = vi.fn();

vi.mock("@/lib/firebase/client", () => ({
  isFirebaseConfigured: () => true,
  getFirebaseAuth: () => ({ __auth: true }),
}));

vi.mock("firebase/auth", () => ({
  GoogleAuthProvider: class {
    setCustomParameters() {}
  },
  createUserWithEmailAndPassword: (...a: unknown[]) =>
    createUserWithEmailAndPassword(...a),
  signInWithEmailAndPassword: (...a: unknown[]) =>
    signInWithEmailAndPassword(...a),
  signInWithPopup: vi.fn(),
  sendEmailVerification: (...a: unknown[]) => sendEmailVerification(...a),
  signOut: (auth: unknown) => signOut(auth),
}));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    api: { get: vi.fn(), post: (p: string, b: unknown) => apiPost(p, b), patch: vi.fn(), del: vi.fn() },
  };
});

/** An identity as Firebase actually returns it from a fresh signup. */
const unverified = { user: { emailVerified: false, getIdToken: vi.fn(async () => "tok") } };
const verified = { user: { emailVerified: true, getIdToken: vi.fn(async () => "tok") } };

beforeEach(() => {
  createUserWithEmailAndPassword.mockReset();
  signInWithEmailAndPassword.mockReset();
  sendEmailVerification.mockClear();
  signOut.mockClear();
  apiPost.mockReset();
  Object.defineProperty(window, "location", {
    writable: true,
    value: { assign: vi.fn(), href: "http://localhost/signup?invite=CODE-123" },
  });
});

async function renderSignup() {
  const { FirebaseAuthForm } = await import("@/components/auth/firebase-auth-form");
  return renderWithUser(
    <FirebaseAuthForm mode="signup" inviteCode="CODE-123" />,
  );
}

async function submitSignup(user: Awaited<ReturnType<typeof renderSignup>>["user"]) {
  await user.type(screen.getByLabelText(/work email/i), "invited@acme.test");
  await user.type(screen.getByLabelText(/password/i), "NewUserPass!1");
  await user.click(screen.getByRole("button", { name: /create account/i }));
}

describe("J3 — invited new user, email + password", () => {
  it("sends a verification mail instead of an exchange that must fail", async () => {
    createUserWithEmailAndPassword.mockResolvedValue(unverified);
    const { user } = await renderSignup();
    await submitSignup(user);

    await waitFor(() => expect(sendEmailVerification).toHaveBeenCalledTimes(1));
    // Posting the token could only ever return the unverified refusal.
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("returns the visitor to the invite URL, because provisioning needs the code", async () => {
    createUserWithEmailAndPassword.mockResolvedValue(unverified);
    const { user } = await renderSignup();
    await submitSignup(user);

    await waitFor(() => expect(sendEmailVerification).toHaveBeenCalled());
    const settings = sendEmailVerification.mock.calls[0]![1] as { url?: string };
    // /login would refuse them for lack of an invite; the code lives in this URL.
    expect(settings.url).toContain("invite=CODE-123");
  });

  it("falls back to the plain mail when the origin is not allowlisted", async () => {
    createUserWithEmailAndPassword.mockResolvedValue(unverified);
    sendEmailVerification.mockRejectedValueOnce(
      Object.assign(new Error("Domain not allowlisted by project"), {
        code: "auth/unauthorized-continue-uri",
      }),
    );
    const { user } = await renderSignup();
    await submitSignup(user);

    // Second call with no actionCodeSettings — a Firebase configuration gap
    // must not read to the visitor as "Could not create your account".
    await waitFor(() => expect(sendEmailVerification).toHaveBeenCalledTimes(2));
    expect(sendEmailVerification.mock.calls[1]!.length).toBe(1);
    expect(
      screen.queryByText(/could not create your account/i),
    ).not.toBeInTheDocument();
  });

  it("does not leave the visitor holding a session the server will refuse", async () => {
    createUserWithEmailAndPassword.mockResolvedValue(unverified);
    const { user } = await renderSignup();
    await submitSignup(user);
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });

  it("replaces the form with the one instruction that moves signup forward", async () => {
    createUserWithEmailAndPassword.mockResolvedValue(unverified);
    const { user } = await renderSignup();
    await submitSignup(user);

    expect(
      await screen.findByText(/confirm your email to finish/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/invited@acme\.test/)).toBeInTheDocument();
    // Re-submitting the same credentials would only rebuild the dead end.
    expect(
      screen.queryByRole("button", { name: /create account/i }),
    ).not.toBeInTheDocument();
  });

  it("exchanges normally when the identity IS already verified", async () => {
    createUserWithEmailAndPassword.mockResolvedValue(verified);
    apiPost.mockResolvedValue({ user: { id: "u1" }, isNewUser: true });
    const { user } = await renderSignup();
    await submitSignup(user);

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    // The invite code must reach the server, or provisioning is refused.
    expect(
      (apiPost.mock.calls[0]![1] as Record<string, unknown>).inviteCode,
    ).toBe("CODE-123");
    expect(sendEmailVerification).not.toHaveBeenCalled();
  });

  it("leaves sign-in mode untouched", async () => {
    signInWithEmailAndPassword.mockResolvedValue(unverified);
    apiPost.mockResolvedValue({ user: { id: "u1" }, isNewUser: false });
    const { FirebaseAuthForm } = await import("@/components/auth/firebase-auth-form");
    const { user } = renderWithUser(<FirebaseAuthForm mode="signin" />);
    await user.type(screen.getByLabelText(/work email/i), "existing@acme.test");
    await user.type(screen.getByLabelText(/password/i), "ExistingPass!1");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    // An existing user with an unverified identity must still be allowed to
    // try — the server decides, and it may match them by uid.
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(sendEmailVerification).not.toHaveBeenCalled();
  });
});
