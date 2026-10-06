import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

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
