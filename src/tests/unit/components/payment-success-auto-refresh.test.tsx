import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

// One router object for the component's lifetime, as Next's `useRouter()`
// returns (it reads a stable context value).
const { refresh, router } = vi.hoisted(() => {
  const refresh = vi.fn();
  return { refresh, router: { refresh } };
});
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { PaymentSuccessAutoRefresh } from "@/app/pay/success/auto-refresh";

/**
 * The "still confirming" line on /pay/success, shown while the gateway has
 * not yet reported the payment.
 *
 * It used to say "Confirming with Stripe…" to every customer, including a
 * PayPal brand's — naming the wrong processor while it holds their money.
 * It now names the ORDER's gateway; a Stripe order reads exactly as before.
 */

describe("PaymentSuccessAutoRefresh", () => {
  it("reads exactly as before for a Stripe order", () => {
    render(<PaymentSuccessAutoRefresh gatewayLabel="Stripe" />);
    expect(screen.getByRole("status")).toHaveTextContent(/^Confirming with Stripe…$/);
  });

  it("names PayPal for a PayPal order", () => {
    render(<PaymentSuccessAutoRefresh gatewayLabel="PayPal" />);
    expect(screen.getByRole("status")).toHaveTextContent(/^Confirming with PayPal…$/);
    expect(screen.getByRole("status")).not.toHaveTextContent("Stripe");
  });

  it("names no processor when the order has no gateway", () => {
    render(<PaymentSuccessAutoRefresh />);
    expect(screen.getByRole("status")).toHaveTextContent(
      /^Confirming with the payment provider…$/,
    );
  });

  it("names the order's gateway in the give-up message too", () => {
    // A zero-second cap renders the exhausted state on the first paint.
    render(<PaymentSuccessAutoRefresh gatewayLabel="PayPal" capSeconds={0} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Still confirming with PayPal. Try refreshing this page in a minute, or contact support if the charge appears on your card.",
    );
  });
});

describe("PaymentSuccessAutoRefresh — it actually refreshes, and stops at the cap", () => {
  beforeEach(() => {
    refresh.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function advance(seconds: number) {
    for (let i = 0; i < seconds; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
    }
  }

  it("re-renders the page from the server every interval — it never sat on one timer that a ticker kept resetting", async () => {
    render(<PaymentSuccessAutoRefresh gatewayLabel="PayPal" intervalSeconds={3} capSeconds={30} />);
    await advance(2);
    expect(refresh).not.toHaveBeenCalled();
    await advance(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await advance(6);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("stops refreshing at the cap and asks the customer to refresh by hand", async () => {
    render(<PaymentSuccessAutoRefresh gatewayLabel="PayPal" intervalSeconds={3} capSeconds={9} />);
    await advance(9);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("status")).toHaveTextContent("Still confirming with PayPal.");
    await advance(30);
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
