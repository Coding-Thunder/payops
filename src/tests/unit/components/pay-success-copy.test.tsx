import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { PaymentSuccessAutoRefresh } from "@/app/pay/success/auto-refresh";

/**
 * The copy a customer reads on the return page while their payment is still
 * being confirmed.
 *
 * This banner shipped naming Stripe unconditionally, and a live PayPal
 * payment showed a customer "Still confirming with Stripe" under a heading
 * that correctly said PayPal. On a page about money that has left their
 * account, naming the wrong company is not a cosmetic problem.
 *
 * The component reloads the page on a timer, so the clock is faked and the
 * reload is stubbed — otherwise jsdom throws on navigation and the test
 * would be measuring the harness rather than the copy.
 */

const reload = vi.fn();

function renderBanner(gatewayLabel?: string | null) {
  vi.stubGlobal("location", { ...window.location, reload });
  return render(
    <PaymentSuccessAutoRefresh gatewayLabel={gatewayLabel} capSeconds={30} />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  reload.mockReset();
});

describe("while the payment is still being confirmed", () => {
  it("names PayPal for a PayPal payment", () => {
    renderBanner("PayPal");
    const status = screen.getByRole("status");

    expect(status).toHaveTextContent(/Confirming with PayPal/i);
    expect(status).not.toHaveTextContent(/Stripe/i);
  });

  it("names Stripe for a Stripe payment", () => {
    renderBanner("Stripe");
    const status = screen.getByRole("status");

    expect(status).toHaveTextContent(/Confirming with Stripe/i);
    expect(status).not.toHaveTextContent(/PayPal/i);
  });

  it("says neither when the gateway could not be resolved", () => {
    // The page renders this banner even when the order lookup came back
    // empty. Guessing a provider there would be worse than a neutral noun.
    renderBanner(null);
    const status = screen.getByRole("status");

    expect(status).toHaveTextContent(/the payment provider/i);
    expect(status).not.toHaveTextContent(/Stripe|PayPal/i);
  });

  it("falls back to the neutral noun for a blank label", () => {
    renderBanner("   ");
    expect(screen.getByRole("status")).toHaveTextContent(/the payment provider/i);
  });
});

describe("after the auto-refresh gives up", () => {
  it("still names the right gateway in the manual-refresh hint", () => {
    vi.useFakeTimers();
    renderBanner("PayPal");

    // Past the cap, where the copy switches to the "try refreshing" hint —
    // the branch that carried the hardcoded name.
    act(() => {
      vi.advanceTimersByTime(31_000);
    });

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/Still confirming with PayPal/i);
    expect(status).not.toHaveTextContent(/Stripe/i);
  });

  it("names Stripe in the same branch for a Stripe payment", () => {
    vi.useFakeTimers();
    renderBanner("Stripe");
    act(() => {
      vi.advanceTimersByTime(31_000);
    });

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/Still confirming with Stripe/i);
    expect(status).not.toHaveTextContent(/PayPal/i);
  });
});
