import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";

import { renderWithUser, screen, waitFor } from "@/tests/utils/render";

/**
 * A lapsed challenge must never be a dead end.
 *
 * A Turnstile token is single-use and expires after roughly five minutes. Every
 * auth form gates its submit button on holding one, and each of them used to
 * respond to expiry and to widget errors by clearing the token and nothing
 * else — so `ready`/`canSubmit` went false, the button went dead, and the only
 * way back was a page reload. Nothing on screen said so.
 *
 * It is the quiet version of the bug that produced a support report: a visitor
 * opens /login, reads the page, and by the time they submit their challenge has
 * lapsed. `1e65faa` fixed the server-refusal path on /login only; expiry,
 * widget errors, and the whole of /activate and /forgot-password were still
 * dead ends.
 *
 * The widget is stubbed so the prop contract — `resetSignal` in, callbacks out
 * — is observable. The widget's own reset behaviour is covered by
 * turnstile-reset.test.tsx.
 */

interface Captured {
  resetSignal?: number;
  onVerify?: (t: string) => void;
  onExpire?: () => void;
  onError?: () => void;
}

const widgetProps: Captured[] = [];

vi.mock("@/components/common/turnstile-widget", () => ({
  TurnstileWidget: (props: Captured) => {
    widgetProps.push(props);
    return null;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/login",
}));

vi.mock("@/lib/firebase/client", () => ({
  isFirebaseConfigured: () => true,
  getFirebaseAuth: () => ({ __auth: true }),
}));

vi.mock("firebase/auth", () => ({
  GoogleAuthProvider: class {
    setCustomParameters() {}
  },
  createUserWithEmailAndPassword: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signInWithPopup: vi.fn(),
  signOut: vi.fn(async (auth: unknown) => {
    void auth;
  }),
}));

const SITE_KEY = "1x00000000000000000000AA";

function latest(): Captured {
  const p = widgetProps[widgetProps.length - 1];
  if (!p) throw new Error("the widget was never rendered");
  return p;
}

const signal = () => latest().resetSignal ?? -1;
const verify = (t: string) => act(() => latest().onVerify?.(t));
const expire = () => act(() => latest().onExpire?.());
const error = () => act(() => latest().onError?.());

beforeEach(() => {
  widgetProps.length = 0;
  vi.clearAllMocks();
});

/**
 * Every auth surface that gates submission on a Turnstile token, with the
 * selector for the control that must come back to life.
 */
const SURFACES = [
  {
    name: "/login (FirebaseAuthForm)",
    async render() {
      const { FirebaseAuthForm } = await import(
        "@/components/auth/firebase-auth-form"
      );
      renderWithUser(
        <FirebaseAuthForm mode="signin" turnstileSiteKey={SITE_KEY} />,
      );
    },
    gated: () => screen.getByRole("button", { name: /^sign in$/i }),
  },
  {
    name: "/activate (ActivateForm)",
    async render() {
      const { ActivateForm } = await import("@/app/activate/activate-form");
      renderWithUser(
        <ActivateForm
          token="tok-abc-123456789012"
          email="demo@example.test"
          defaultName="Demo User"
          turnstileSiteKey={SITE_KEY}
        />,
      );
    },
    gated: () => screen.getByRole("button", { name: /activate|set password|continue/i }),
  },
  {
    name: "/forgot-password (ForgotPasswordForm)",
    async render() {
      const { ForgotPasswordForm } = await import(
        "@/app/forgot-password/_components/forgot-password-form"
      );
      renderWithUser(<ForgotPasswordForm turnstileSiteKey={SITE_KEY} />);
    },
    gated: () => screen.getByRole("button", { name: /send|reset|link/i }),
  },
];

describe.each(SURFACES)("$name", ({ render, gated }) => {
  it("is gated until a token arrives, then enabled", async () => {
    await render();
    expect(gated()).toBeDisabled();
    verify("token-1");
    await waitFor(() => expect(gated()).toBeEnabled());
  });

  it("asks for a new challenge when the token EXPIRES", async () => {
    await render();
    verify("token-1");
    await waitFor(() => expect(gated()).toBeEnabled());

    const before = signal();
    expire();

    // Gate re-closes — Turnstile stays authoritative, a lapsed token is not
    // reused…
    await waitFor(() => expect(gated()).toBeDisabled());
    // …and a replacement is requested, so this is recoverable without a reload.
    await waitFor(() => expect(signal()).toBeGreaterThan(before));

    verify("token-2");
    await waitFor(() => expect(gated()).toBeEnabled());
  });

  it("asks for a new challenge when the widget ERRORS", async () => {
    await render();
    verify("token-1");
    await waitFor(() => expect(gated()).toBeEnabled());

    const before = signal();
    error();

    await waitFor(() => expect(gated()).toBeDisabled());
    await waitFor(() => expect(signal()).toBeGreaterThan(before));

    verify("token-2");
    await waitFor(() => expect(gated()).toBeEnabled());
  });

  it("never enables submission without a token", async () => {
    await render();
    verify("token-1");
    await waitFor(() => expect(gated()).toBeEnabled());
    expire();
    // The important half of the contract: re-arming must not mean
    // "assume verified". The server is the authority; the client must not
    // let a request through that the server will reject on the captcha.
    await waitFor(() => expect(gated()).toBeDisabled());
  });
});
