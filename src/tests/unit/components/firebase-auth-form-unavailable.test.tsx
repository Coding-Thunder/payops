import { describe, expect, it, vi, beforeEach } from "vitest";

import { FirebaseAuthForm } from "@/components/auth/firebase-auth-form";
import { renderWithUser, screen } from "@/tests/utils/render";

/**
 * The unconfigured-sign-in notice on /login.
 *
 * It used to read "Firebase Auth isn't configured for this environment. Use
 * the email + password form below." Both halves were wrong in a way that cost
 * the visitor time:
 *
 *   - there is no form below. `login/page.tsx` renders this component and
 *     nothing else, so the sentence sent people hunting for a control that
 *     does not exist in the DOM. (`app/login/_components/login-form.tsx` is
 *     an orphan — nothing imports it.)
 *   - naming the provider and the missing configuration tells a visitor
 *     nothing they can act on, and tells anyone probing the deployment
 *     something about its internals.
 *
 * So these tests assert three things: the notice offers a route that really
 * exists (/contact), it names no infrastructure, and — the part a copy fix
 * could quietly break — the CONFIGURED path still renders the real form.
 *
 * `@/lib/firebase/client` is the switch; `firebase/auth` is mocked because
 * the real SDK is imported at module scope and must never be reached here.
 */

const isFirebaseConfigured = vi.fn<() => boolean>();

vi.mock("@/lib/firebase/client", () => ({
  isFirebaseConfigured: () => isFirebaseConfigured(),
  getFirebaseAuth: () => null,
}));

vi.mock("firebase/auth", () => ({
  GoogleAuthProvider: class {
    setCustomParameters() {}
  },
  createUserWithEmailAndPassword: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signInWithPopup: vi.fn(),
}));

/** Words that would either mislead the visitor or describe our internals. */
const FORBIDDEN = [
  /firebase/i,
  /form below/i,
  /below/i,
  /not configured/i,
  /isn't configured/i,
  /environment/i,
  /api key/i,
  /config/i,
];

describe("FirebaseAuthForm — sign-in unavailable", () => {
  beforeEach(() => {
    isFirebaseConfigured.mockReturnValue(false);
  });

  it("does not promise a form that is not on the page", () => {
    renderWithUser(<FirebaseAuthForm mode="signin" />);

    // No credential inputs exist in this state, so any reference to one is a
    // dead end by construction.
    expect(screen.queryByLabelText(/work email/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /sign in|continue with google/i }),
    ).not.toBeInTheDocument();

    const text = document.body.textContent ?? "";
    for (const pattern of FORBIDDEN) {
      expect(text, `user-visible copy must not match ${pattern}`).not.toMatch(
        pattern,
      );
    }
  });

  it("states the situation and reassures about the account", () => {
    renderWithUser(<FirebaseAuthForm mode="signin" />);

    expect(
      screen.getByText(/sign-in is temporarily unavailable/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/your account and your data are unaffected/i),
    ).toBeInTheDocument();
  });

  it("offers one real route out, /contact", () => {
    renderWithUser(<FirebaseAuthForm mode="signin" />);

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/contact");

    // No invented recovery path: a password-reset link here would 404 or,
    // worse, imply a fallback that does not exist while auth is down.
    for (const l of links) {
      const href = l.getAttribute("href") ?? "";
      expect(href).not.toMatch(/forgot|reset|signup/i);
    }
  });

  it("says the same thing in signup mode, without terms boilerplate", () => {
    renderWithUser(<FirebaseAuthForm mode="signup" />);

    expect(
      screen.getByText(/sign-in is temporarily unavailable/i),
    ).toBeInTheDocument();
    // The Terms/Privacy consent line belongs to a form that can submit.
    expect(screen.queryByRole("link", { name: /terms/i })).not.toBeInTheDocument();
  });

  it("still renders the real form when auth IS configured", async () => {
    isFirebaseConfigured.mockReturnValue(true);

    renderWithUser(<FirebaseAuthForm mode="signin" />);

    expect(
      screen.queryByText(/sign-in is temporarily unavailable/i),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText(/work email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /continue with google/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeEnabled();
    expect(screen.getByRole("link", { name: /forgot/i })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });

  it("gates submit on Turnstile when a site key is configured", () => {
    isFirebaseConfigured.mockReturnValue(true);

    renderWithUser(
      <FirebaseAuthForm mode="signin" turnstileSiteKey="1x00000000000000000000AA" />,
    );

    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeDisabled();
  });
});
