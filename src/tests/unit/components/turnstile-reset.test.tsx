import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { TurnstileWidget } from "@/components/common/turnstile-widget";
import { renderWithUser, waitFor } from "@/tests/utils/render";

/**
 * The `resetSignal` contract.
 *
 * A Turnstile token is single-use. The sign-in form clears its token after
 * every attempt, so without a way to ask for a new one the widget sits there
 * holding nothing, `captchaReady` stays false, and both sign-in buttons are
 * disabled until the visitor reloads the page. That turned any failed sign-in
 * into a dead end — the screen reported the problem and then refused to let
 * anyone try again.
 *
 * `window.turnstile` is stubbed because the real script is remote.
 */

const render = vi.fn(() => "widget-1");
const reset = vi.fn();
const remove = vi.fn();

beforeEach(() => {
  render.mockClear();
  reset.mockClear();
  remove.mockClear();
  (window as unknown as { turnstile: unknown }).turnstile = {
    render,
    reset,
    remove,
  };
});

afterEach(() => {
  delete (window as unknown as { turnstile?: unknown }).turnstile;
});

describe("TurnstileWidget — resetSignal", () => {
  it("renders the challenge once on mount and does not reset it", async () => {
    renderWithUser(
      <TurnstileWidget siteKey="1x0000" onVerify={() => {}} resetSignal={0} />,
    );

    await waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    // A reset on first render would throw away the token the widget just
    // produced, before anything had a chance to spend it.
    expect(reset).not.toHaveBeenCalled();
  });

  it("asks for a fresh token when the signal changes", async () => {
    const { rerender } = renderWithUser(
      <TurnstileWidget siteKey="1x0000" onVerify={() => {}} resetSignal={0} />,
    );
    await waitFor(() => expect(render).toHaveBeenCalledTimes(1));

    rerender(
      <TurnstileWidget siteKey="1x0000" onVerify={() => {}} resetSignal={1} />,
    );

    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    expect(reset).toHaveBeenCalledWith("widget-1");
    // Reset, not re-render: tearing the widget down and rebuilding it would
    // lose the interaction-only appearance and flicker.
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("does not reset on an unrelated re-render", async () => {
    const { rerender } = renderWithUser(
      <TurnstileWidget
        siteKey="1x0000"
        onVerify={() => {}}
        resetSignal={3}
        className="a"
      />,
    );
    await waitFor(() => expect(render).toHaveBeenCalledTimes(1));

    rerender(
      <TurnstileWidget
        siteKey="1x0000"
        onVerify={() => {}}
        resetSignal={3}
        className="b"
      />,
    );

    expect(reset).not.toHaveBeenCalled();
  });

  it("survives a reset arriving after the widget is gone", async () => {
    const { rerender, unmount } = renderWithUser(
      <TurnstileWidget siteKey="1x0000" onVerify={() => {}} resetSignal={0} />,
    );
    await waitFor(() => expect(render).toHaveBeenCalledTimes(1));
    reset.mockImplementation(() => {
      throw new Error("widget not found");
    });

    // Must not propagate: Turnstile throws if the widget was torn down
    // between the bump and the effect.
    expect(() =>
      rerender(
        <TurnstileWidget siteKey="1x0000" onVerify={() => {}} resetSignal={1} />,
      ),
    ).not.toThrow();
    expect(() => unmount()).not.toThrow();
  });

  it("renders nothing, and never touches the API, without a site key", () => {
    renderWithUser(<TurnstileWidget siteKey={null} onVerify={() => {}} />);
    expect(render).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });
});
