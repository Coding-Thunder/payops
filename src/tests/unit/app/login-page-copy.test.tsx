import { describe, expect, it, vi, beforeEach } from "vitest";

import { renderWithUser, screen } from "@/tests/utils/render";

/**
 * What /login tells the visitor, as a whole page.
 *
 * `firebase-auth-form-unavailable.test.tsx` pins the FORM's copy. That was not
 * enough: the page around the form carried its own subtitle — "Use Google or
 * your work email + password." — which rendered directly above the form's
 * "sign-in is temporarily unavailable" alert. So the page simultaneously told
 * the visitor to use a Google button and a password field that the form does
 * not render in that state, and apologised for not being able to sign them in.
 *
 * The component test could never have caught it, because the sentence is not
 * in the component. This file asserts the page's rendered text as one thing,
 * which is how a visitor reads it.
 *
 * Both states are covered, because the subtitle is correct and wanted when
 * sign-in actually works.
 */

const isFirebaseConfigured = vi.fn<() => boolean>();

vi.mock("@/lib/firebase/client", () => ({
  isFirebaseConfigured: () => isFirebaseConfigured(),
  getFirebaseAuth: () => null,
}));

vi.mock("@/server/auth/session", () => ({
  getCurrentUser: async () => null,
}));

vi.mock("@/server/auth/turnstile", () => ({
  turnstileSiteKey: () => null,
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("redirect() should not run for an anonymous visitor");
  }),
  usePathname: () => "/login",
}));

vi.mock("firebase/auth", () => ({
  GoogleAuthProvider: class {
    setCustomParameters() {}
  },
  createUserWithEmailAndPassword: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signInWithPopup: vi.fn(),
}));

async function renderLoginPage() {
  const { default: LoginPage } = await import("@/app/login/page");
  const element = await LoginPage({ searchParams: Promise.resolve({}) });
  return renderWithUser(element);
}

describe("/login — page copy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("when sign-in is unavailable", () => {
    beforeEach(() => {
      isFirebaseConfigured.mockReturnValue(false);
    });

    it("does not point at credentials that are not on the page", async () => {
      await renderLoginPage();

      // Precondition: there really is no form in this state.
      expect(screen.queryByLabelText(/work email/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /continue with google/i }),
      ).not.toBeInTheDocument();

      // So nothing on the page may tell the visitor to use them.
      const text = (document.body.textContent ?? "").replace(/\s+/g, " ");
      for (const pattern of [
        /use google/i,
        /email \+ password/i,
        /your work email/i,
        /form below/i,
        /firebase/i,
      ]) {
        expect(text, `page copy must not match ${pattern}`).not.toMatch(pattern);
      }
    });

    it("still explains itself and offers a real route out", async () => {
      await renderLoginPage();

      expect(
        screen.getByRole("heading", { name: /sign in to your account/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/sign-in is temporarily unavailable/i),
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /get in touch/i })).toHaveAttribute(
        "href",
        "/contact",
      );
    });
  });

  describe("when sign-in is available", () => {
    beforeEach(() => {
      isFirebaseConfigured.mockReturnValue(true);
    });

    it("keeps the subtitle, because now it is true", async () => {
      await renderLoginPage();

      expect(
        screen.getByText(/use google or your work email \+ password/i),
      ).toBeInTheDocument();
      // And the controls it names actually exist.
      expect(screen.getByLabelText(/work email/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /continue with google/i }),
      ).toBeInTheDocument();
    });

    it("does not show the unavailable notice", async () => {
      await renderLoginPage();
      expect(
        screen.queryByText(/sign-in is temporarily unavailable/i),
      ).not.toBeInTheDocument();
    });
  });
});
