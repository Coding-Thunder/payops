import { describe, expect, it, vi, beforeEach } from "vitest";

import { FirebaseAuthForm } from "@/components/auth/firebase-auth-form";
import { act } from "react";

import { renderWithUser, screen, waitFor } from "@/tests/utils/render";

/**
 * The configured sign-in form: both providers, and what the visitor is told
 * when it fails.
 *
 * ── Why these tests exist ────────────────────────────────────────────────
 *
 * A production user saw "signups are invite-only. Please use an invitation to
 * create an account." while signing IN. The server half of that is fixed in
 * `firebase-signin-authorization.test.ts`. This file covers the client half,
 * which had its own compounding bug: the Turnstile token is single-use and was
 * cleared after every attempt, with nothing issuing a replacement — so the
 * screen that reported the failure also disabled both buttons until a reload.
 * The visitor could not even retry with the right Google account.
 *
 * `firebase/auth` and the API client are mocked: the real SDK does network I/O
 * at module scope and must never be reached from a unit test.
 */

const signInWithEmailAndPassword = vi.fn();
const signInWithPopup = vi.fn();
// One typed parameter, referenced, so the forwarding wrapper below both
// typechecks (a spread into a zero-arg signature is TS2556) and leaves no
// unused binding for lint. The async body matters too: the SDK returns a
// promise and the component chains off it.
const signOut = vi.fn(async (auth: unknown) => {
  void auth;
});
const apiPost = vi.fn();
const getIdToken = vi.fn(async () => "id-token-abc");

vi.mock("@/lib/firebase/client", () => ({
  isFirebaseConfigured: () => true,
  // Truthy stand-in for the Auth instance; the mocked SDK ignores it.
  getFirebaseAuth: () => ({ __auth: true }),
}));

vi.mock("firebase/auth", () => ({
  GoogleAuthProvider: class {
    setCustomParameters() {}
  },
  createUserWithEmailAndPassword: vi.fn(),
  signInWithEmailAndPassword: (...a: unknown[]) =>
    signInWithEmailAndPassword(...a),
  signInWithPopup: (...a: unknown[]) => signInWithPopup(...a),
  signOut: (auth: unknown) => signOut(auth),
}));

// Observable stand-in for the Turnstile widget. The real one injects a remote
// script and renders a Cloudflare iframe; neither exists under jsdom, and the
// prop contract (`resetSignal` in, `onVerify` out) is what this file needs to
// assert. The widget's own behaviour is covered by turnstile-reset.test.tsx.
const widgetProps: { resetSignal?: number; onVerify?: (t: string) => void }[] =
  [];

vi.mock("@/components/common/turnstile-widget", () => ({
  TurnstileWidget: (props: {
    resetSignal?: number;
    onVerify?: (t: string) => void;
  }) => {
    widgetProps.push(props);
    return null;
  },
}));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    api: {
      get: vi.fn(),
      post: (p: string, b: unknown) => apiPost(p, b),
      patch: vi.fn(),
      del: vi.fn(),
    },
  };
});

/** A Firebase credential whose token the form will exchange. */
const credential = { user: { getIdToken } };

const SITE_KEY = "1x00000000000000000000AA";

/** The newest `resetSignal` the form handed the widget. */
function lastResetSignal(): number {
  return widgetProps[widgetProps.length - 1]?.resetSignal ?? -1;
}

/** Deliver a verified token the way Turnstile's callback would. */
function emitToken(token: string): void {
  const onVerify = widgetProps[widgetProps.length - 1]?.onVerify;
  if (!onVerify) throw new Error("widget was never rendered");
  act(() => onVerify(token));
}

beforeEach(() => {
  widgetProps.length = 0;
  signInWithEmailAndPassword.mockReset();
  signInWithPopup.mockReset();
  // mockClear, NOT mockReset: in vitest 2.x mockReset wipes the
  // implementation, so signOut() would return undefined and the
  // production `.catch()` on its promise would throw. That produced 7
  // unhandled rejections and a non-zero exit code while every assertion
  // still passed — the call-count test could not see it.
  signOut.mockClear();
  apiPost.mockReset();
  getIdToken.mockClear();
  // The success path hard-navigates; jsdom cannot, so stub it.
  Object.defineProperty(window, "location", {
    writable: true,
    value: { assign: vi.fn(), href: "http://localhost/login" },
  });
});

describe("email + password sign-in", () => {
  it("exchanges the Firebase token for a session, with no invite code", async () => {
    signInWithEmailAndPassword.mockResolvedValue(credential);
    apiPost.mockResolvedValue({ user: { id: "u1" }, isNewUser: false });

    const { user } = renderWithUser(<FirebaseAuthForm mode="signin" />);
    await user.type(screen.getByLabelText(/work email/i), "dana@acme.test");
    await user.type(screen.getByLabelText(/password/i), "Hunter2!x");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost.mock.calls[0][0]).toBe("/api/auth/firebase-session");
    const body = apiPost.mock.calls[0][1] as Record<string, unknown>;
    expect(body.idToken).toBe("id-token-abc");
    // A sign-in must not claim an invite; that is what makes the server treat
    // it as a sign-in rather than a refused signup.
    expect(body.inviteCode).toBeUndefined();
  });

  it("shows the server's reason verbatim when the identity has no account", async () => {
    const { ApiClientError } = await import("@/lib/api-client");
    signInWithEmailAndPassword.mockResolvedValue(credential);
    const serverMessage =
      "No TraceTxn account is linked to dana.personal@gmail.test. If you have more than one Google or email identity, sign in with the one your workspace was created for.";
    apiPost.mockRejectedValue(
      new ApiClientError(403, { code: "FORBIDDEN", message: serverMessage }),
    );

    const { user } = renderWithUser(<FirebaseAuthForm mode="signin" />);
    await user.type(screen.getByLabelText(/work email/i), "dana@acme.test");
    await user.type(screen.getByLabelText(/password/i), "Hunter2!x");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/no tracetxn account is linked/i);
    expect(alert).toHaveTextContent(/dana\.personal@gmail\.test/);
    expect(alert).toHaveTextContent(/sign-in failed/i);
    expect(window.location.assign).not.toHaveBeenCalled();
  });

  it("maps invalid credentials to a non-enumerating message", async () => {
    signInWithEmailAndPassword.mockRejectedValue({
      code: "auth/invalid-credential",
    });

    const { user } = renderWithUser(<FirebaseAuthForm mode="signin" />);
    await user.type(screen.getByLabelText(/work email/i), "dana@acme.test");
    await user.type(screen.getByLabelText(/password/i), "wrong-one");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/incorrect email or password/i);
    // Must not reveal whether the address exists.
    expect(alert).not.toHaveTextContent(/no such user|not found|unregistered/i);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("does not mislabel a server outage as an invitation problem", async () => {
    const { ApiClientError } = await import("@/lib/api-client");
    signInWithEmailAndPassword.mockResolvedValue(credential);
    apiPost.mockRejectedValue(
      new ApiClientError(503, {
        code: "EXTERNAL_SERVICE_ERROR",
        message: "Firebase Auth is not configured on the server",
      }),
    );

    const { user } = renderWithUser(<FirebaseAuthForm mode="signin" />);
    await user.type(screen.getByLabelText(/work email/i), "dana@acme.test");
    await user.type(screen.getByLabelText(/password/i), "Hunter2!x");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent(/invite|invitation|private beta/i);
  });
});

describe("Google sign-in", () => {
  it("uses the same exchange and the same checks as the password path", async () => {
    signInWithPopup.mockResolvedValue(credential);
    apiPost.mockResolvedValue({ user: { id: "u1" }, isNewUser: false });

    const { user } = renderWithUser(<FirebaseAuthForm mode="signin" />);
    await user.click(
      screen.getByRole("button", { name: /continue with google/i }),
    );

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost.mock.calls[0][0]).toBe("/api/auth/firebase-session");
    expect(
      (apiPost.mock.calls[0][1] as Record<string, unknown>).inviteCode,
    ).toBeUndefined();
  });

  it("surfaces the wrong-identity refusal rather than a signup prompt", async () => {
    const { ApiClientError } = await import("@/lib/api-client");
    signInWithPopup.mockResolvedValue(credential);
    apiPost.mockRejectedValue(
      new ApiClientError(403, {
        code: "FORBIDDEN",
        message:
          "No TraceTxn account is linked to dana.personal@gmail.test. If you have more than one Google or email identity, sign in with the one your workspace was created for.",
      }),
    );

    const { user } = renderWithUser(<FirebaseAuthForm mode="signin" />);
    await user.click(
      screen.getByRole("button", { name: /continue with google/i }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/more than one google or email identity/i);
    expect(alert).not.toHaveTextContent(/create an account/i);
  });

  it("does NOT sign out when the session was already established", async () => {
    // The navigation sits inside the same try as the exchange, so a throw
    // from it lands in the catch AFTER the session cookie is set. Signing the
    // visitor out of Firebase at that point would be wrong: they hold a valid
    // app session and are mid-redirect into it.
    signInWithPopup.mockResolvedValue(credential);
    apiPost.mockResolvedValue({ user: { id: "u1" }, isNewUser: false });
    (window.location.assign as unknown as ReturnType<typeof vi.fn>)
      .mockImplementation(() => {
        throw new Error("navigation blocked");
      });

    const { user } = renderWithUser(<FirebaseAuthForm mode="signin" />);
    await user.click(
      screen.getByRole("button", { name: /continue with google/i }),
    );

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(signOut).not.toHaveBeenCalled();
  });

  it("signs out of Firebase after a refusal, so the next attempt is clean", async () => {
    const { ApiClientError } = await import("@/lib/api-client");
    signInWithPopup.mockResolvedValue(credential);
    apiPost.mockRejectedValue(
      new ApiClientError(403, { code: "FORBIDDEN", message: "No account" }),
    );

    const { user } = renderWithUser(<FirebaseAuthForm mode="signin" />);
    await user.click(
      screen.getByRole("button", { name: /continue with google/i }),
    );

    // The provider sign-in itself succeeded, so without this the browser stays
    // authenticated as the identity this app just rejected.
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });
});

describe("Turnstile", () => {
  it("blocks submission until a token is held", () => {
    renderWithUser(
      <FirebaseAuthForm mode="signin" turnstileSiteKey={SITE_KEY} />,
    );

    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /continue with google/i }),
    ).toBeDisabled();
  });

  it("spends the token on a SERVER refusal, then asks for a new one", async () => {
    // The previous version of this test ran with no site key, so the captcha
    // gate was off and it proved nothing — it passed with the fix reverted.
    // It also failed at the credential step, which never reaches the server,
    // so the token was never actually spent. This drives the real path: the
    // server refuses the exchange, which is where the token is consumed.
    const { ApiClientError } = await import("@/lib/api-client");
    signInWithEmailAndPassword.mockResolvedValue(credential);
    apiPost.mockRejectedValue(
      new ApiClientError(403, {
        code: "FORBIDDEN",
        message: "No TraceTxn account is linked to dana@acme.test.",
      }),
    );

    const { user } = renderWithUser(
      <FirebaseAuthForm mode="signin" turnstileSiteKey={SITE_KEY} />,
    );

    const before = lastResetSignal();
    emitToken("token-1");
    const submit = () => screen.getByRole("button", { name: /^sign in$/i });
    await waitFor(() => expect(submit()).toBeEnabled());

    await user.type(screen.getByLabelText(/work email/i), "dana@acme.test");
    await user.type(screen.getByLabelText(/password/i), "Hunter2!x");
    await user.click(submit());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /no tracetxn account is linked/i,
    );

    // The token was single-use and is now gone, so Turnstile is still
    // authoritative: the gate re-closes rather than reusing a spent token.
    await waitFor(() => expect(submit()).toBeDisabled());

    // And a replacement was requested — without this the form would stay
    // disabled until a page reload, which is the bug.
    await waitFor(() => expect(lastResetSignal()).toBeGreaterThan(before));

    // The new challenge re-enables it, so the visitor can retry.
    emitToken("token-2");
    await waitFor(() => expect(submit()).toBeEnabled());
  });

  it("does NOT spend the token when the credential fails client-side", async () => {
    // Firebase rejected before the server was ever called, so the token is
    // untouched and the form must remain immediately usable. Clearing it here
    // would disable the form for no reason.
    signInWithEmailAndPassword.mockRejectedValue({
      code: "auth/invalid-credential",
    });

    const { user } = renderWithUser(
      <FirebaseAuthForm mode="signin" turnstileSiteKey={SITE_KEY} />,
    );
    emitToken("token-1");
    const submit = () => screen.getByRole("button", { name: /^sign in$/i });
    await waitFor(() => expect(submit()).toBeEnabled());

    await user.type(screen.getByLabelText(/work email/i), "dana@acme.test");
    await user.type(screen.getByLabelText(/password/i), "wrong-one");
    await user.click(submit());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /incorrect email or password/i,
    );
    expect(apiPost).not.toHaveBeenCalled();
    await waitFor(() => expect(submit()).toBeEnabled());
  });
});
