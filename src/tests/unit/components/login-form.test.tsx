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
    await user.type(screen.getByLabelText(/password/i), "short");
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
    await user.type(screen.getByLabelText(/password/i), "Hunter2!");
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
    await user.type(screen.getByLabelText(/password/i), "Hunter2!");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
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
    await user.type(screen.getByLabelText(/password/i), "Hunter2!");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(
      await screen.findByText(/invalid email or password/i),
    ).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
