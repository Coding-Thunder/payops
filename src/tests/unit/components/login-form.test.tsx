import { describe, expect, it, vi, beforeEach } from "vitest";

import { LoginForm } from "@/app/login/_components/login-form";
import { renderWithUser, screen, waitFor } from "@/tests/utils/render";

/**
 * LoginForm is mostly a thin wrapper around React Hook Form + the API
 * client. We assert behaviour at the boundary that matters: it submits
 * the right payload to /api/auth/login, shows API errors inline, and
 * blocks the submit while in-flight.
 *
 * `next/navigation` is mocked because the form calls
 * router.replace + router.refresh on success.
 */

const replace = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));

describe("LoginForm", () => {
  beforeEach(() => {
    replace.mockReset();
    refresh.mockReset();
  });

  it("validates that email is required before calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { user } = renderWithUser(<LoginForm />);

    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByText(/enter a valid email/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates password length client-side", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const { user } = renderWithUser(<LoginForm />);
    await user.type(screen.getByLabelText(/work email/i), "ada@payops.test");
    await user.type(screen.getByLabelText(/^password$/i), "short");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(
      await screen.findByText(/password must be at least 8 characters/i),
    ).toBeInTheDocument();
  });

  it("submits, redirects, and refreshes on success", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: { id: "u1", name: "Ada", email: "ada@payops.test", role: "ADMIN" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { user } = renderWithUser(<LoginForm nextPath="/orders" />);
    await user.type(screen.getByLabelText(/work email/i), "ada@payops.test");
    await user.type(screen.getByLabelText(/^password$/i), "Hunter2!");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const call = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit];
    expect(String(call[0])).toMatch(/\/api\/auth\/login$/);
    expect(call[1].method).toBe("POST");
    const body = JSON.parse(call[1].body as string);
    expect(body).toEqual({ email: "ada@payops.test", password: "Hunter2!" });

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/orders"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("ignores unsafe nextPath values that could open-redirect", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: { id: "u1", name: "Ada", email: "ada@payops.test", role: "ADMIN" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { user } = renderWithUser(
      <LoginForm nextPath="//evil.example.com/steal" />,
    );
    await user.type(screen.getByLabelText(/work email/i), "ada@payops.test");
    await user.type(screen.getByLabelText(/^password$/i), "Hunter2!");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    // `safeNext` rejects the protocol-relative path and falls back to the
    // authed landing page, which lives under the `/app` prefix.
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/app/dashboard"));
  });

  it("surfaces a server error message inline", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: { code: "UNAUTHORIZED", message: "Invalid email or password" },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { user } = renderWithUser(<LoginForm />);
    await user.type(screen.getByLabelText(/work email/i), "ada@payops.test");
    await user.type(screen.getByLabelText(/^password$/i), "Hunter2!");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(
      await screen.findByText(/invalid email or password/i),
    ).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  /**
   * The reveal toggle sits inside the password field, which puts a button
   * inside a form next to the thing it must not disturb. Three ways that
   * goes wrong, and one test each: it submits the form, it yanks focus out
   * of the field mid-typing, or it starts life revealed.
   */
  describe("password visibility toggle", () => {
    const passwordField = () =>
      screen.getByLabelText(/^password$/i) as HTMLInputElement;
    const toggle = () =>
      screen.getByRole("button", { name: /(show|hide) password/i });

    it("masks the password until the toggle is used", () => {
      renderWithUser(<LoginForm />);

      expect(passwordField().type).toBe("password");
      expect(toggle()).toHaveAttribute("aria-label", "Show password");
      expect(toggle()).toHaveAttribute("aria-pressed", "false");
    });

    it("reveals and re-masks, keeping the value intact", async () => {
      const { user } = renderWithUser(<LoginForm />);
      await user.type(passwordField(), "Hunter2!");

      await user.click(toggle());
      expect(passwordField().type).toBe("text");
      expect(passwordField().value).toBe("Hunter2!");
      expect(toggle()).toHaveAttribute("aria-label", "Hide password");
      expect(toggle()).toHaveAttribute("aria-pressed", "true");

      await user.click(toggle());
      expect(passwordField().type).toBe("password");
      expect(passwordField().value).toBe("Hunter2!");
      expect(toggle()).toHaveAttribute("aria-label", "Show password");
    });

    it("does not submit the form when toggled", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const { user } = renderWithUser(<LoginForm />);
      await user.type(screen.getByLabelText(/work email/i), "ada@payops.test");
      await user.type(passwordField(), "Hunter2!");

      await user.click(toggle());

      // A bare <button> inside a <form> defaults to type="submit"; with
      // valid credentials filled in, a regression here would silently log
      // the user in on a click meant only to reveal the field.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
    });

    it("leaves focus in the password field", async () => {
      const { user } = renderWithUser(<LoginForm />);
      const input = passwordField();
      await user.type(input, "Hunter2!");
      expect(input).toHaveFocus();

      await user.click(toggle());

      // The toggle cancels the default focus transfer on mousedown, so the
      // caret stays put and typing can continue uninterrupted.
      expect(input).toHaveFocus();
    });

    it("is reachable and operable by keyboard", async () => {
      const { user } = renderWithUser(<LoginForm />);
      await user.type(passwordField(), "Hunter2!");

      // Tab order runs password → toggle, so the control is not
      // mouse-only.
      await user.tab();
      expect(toggle()).toHaveFocus();

      await user.keyboard("{Enter}");
      expect(passwordField().type).toBe("text");
    });
  });
});
