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
 * The "still confirming" line on /pay/success while a MANUAL-capture
 * checkout waits for the gateway to confirm the HOLD on the customer's card.
 *
 * Once the refresh loop gives up, the line tells the customer what to do if
 * money shows up on their card. It used to say "the charge" to everyone, but
 * a manual-capture checkout charges nothing: it places a hold. With `hold`
 * set (the page sets it only while a manual-capture order is waiting on its
 * authorization), the hint now says "the hold". Nothing else changes: the
 * wording before the cap, the gateway it names, how often it refreshes and
 * when it stops. An automatic order passes no `hold` and reads exactly as
 * before.
 */

/** The give-up hint, word for word, for a gateway and what may appear. */
function hint(processor: string, appears: "hold" | "charge"): string {
  return `Still confirming with ${processor}. Try refreshing this page in a minute, or contact support if the ${appears} appears on your card.`;
}

/** The status line's whole text: there is nothing else inside it. */
function statusLine(): string {
  return screen.getByRole("status").textContent ?? "";
}

describe("PaymentSuccessAutoRefresh while a manual-capture hold is being confirmed", () => {
  it("tells the customer to contact support if the HOLD appears on their card, not a charge", () => {
    // A zero-second cap renders the exhausted state on the first paint.
    render(<PaymentSuccessAutoRefresh gatewayLabel="Stripe" capSeconds={0} hold />);
    expect(statusLine()).toBe(hint("Stripe", "hold"));
    expect(statusLine()).not.toContain("charge");
  });

  it("names no processor in the hold hint when the order has no gateway", () => {
    render(<PaymentSuccessAutoRefresh capSeconds={0} hold />);
    expect(statusLine()).toBe(hint("the payment provider", "hold"));
  });

  it("keeps the line before the cap exactly as it was: 'Confirming with Stripe…'", () => {
    render(<PaymentSuccessAutoRefresh gatewayLabel="Stripe" hold />);
    expect(statusLine()).toBe("Confirming with Stripe…");
  });
});

describe("PaymentSuccessAutoRefresh without a hold reads exactly as before", () => {
  it.each([
    ["no hold prop at all (every automatic order)", {}],
    ["hold={false}", { hold: false }],
  ])("says 'the charge' with %s", (_case, props) => {
    render(<PaymentSuccessAutoRefresh gatewayLabel="Stripe" capSeconds={0} {...props} />);
    expect(statusLine()).toBe(hint("Stripe", "charge"));
    expect(statusLine()).not.toContain("hold");
  });
});

describe("PaymentSuccessAutoRefresh: a hold changes the words, not the refresh loop", () => {
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

  it("refreshes every interval, switches to the hold hint at the cap, and then stops refreshing", async () => {
    render(
      <PaymentSuccessAutoRefresh gatewayLabel="Stripe" intervalSeconds={3} capSeconds={9} hold />,
    );
    await advance(8);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(statusLine()).toBe("Confirming with Stripe…");

    await advance(1);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(statusLine()).toBe(hint("Stripe", "hold"));

    await advance(30);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(statusLine()).toBe(hint("Stripe", "hold"));
  });

  it("reaches the cap the same way with no hold, ending on 'the charge'", async () => {
    render(<PaymentSuccessAutoRefresh gatewayLabel="Stripe" intervalSeconds={3} capSeconds={9} />);
    await advance(9);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(statusLine()).toBe(hint("Stripe", "charge"));
  });
});
