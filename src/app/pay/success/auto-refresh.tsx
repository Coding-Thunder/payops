"use client";

import { useEffect, useState } from "react";

interface PaymentSuccessAutoRefreshProps {
  /**
   * The gateway actually handling this payment, e.g. "Stripe" or "PayPal".
   * Passed in rather than assumed: this component is rendered for every
   * gateway, and naming the wrong one to a customer mid-payment is both
   * confusing and, on a page about their money, alarming.
   *
   * Null when the order could not be resolved — the copy then says
   * "the payment provider" rather than guessing.
   */
  gatewayLabel?: string | null;
  /** Total seconds the customer will see "still confirming" before the
   *  banner stops auto-refreshing. After the cap we still show a manual
   *  refresh hint so they're never stuck. */
  capSeconds?: number;
  /** How often we reload the page to re-query the server, which
   *  reconciles with the gateway on each render. */
  intervalSeconds?: number;
}

/**
 * Tiny client component the customer sees ONLY when the gateway sent them
 * to the success page but our backend hasn't recorded PAID yet — typically
 * because the webhook hasn't landed and our server-side reconcile couldn't
 * reach the gateway (offline / transient error).
 *
 * Strategy: reload the whole page on a short interval. Each reload
 * re-runs the server-side reconcile which is the only thing that
 * matters — once the order flips to PAID the page will paint with the
 * normal "Payment confirmed" hero and this component unmounts.
 *
 * We cap the loop so we don't spin forever for a genuinely failed
 * payment; after the cap we tell the customer to refresh manually.
 */
export function PaymentSuccessAutoRefresh({
  gatewayLabel,
  capSeconds = 30,
  intervalSeconds = 3,
}: PaymentSuccessAutoRefreshProps) {
  const gateway = gatewayLabel?.trim() || "the payment provider";
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (elapsed >= capSeconds) return;
    const t = window.setTimeout(() => {
      window.location.reload();
    }, intervalSeconds * 1_000);
    return () => window.clearTimeout(t);
  }, [elapsed, capSeconds, intervalSeconds]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setElapsed((s) => s + 1);
    }, 1_000);
    return () => window.clearInterval(interval);
  }, []);

  const exhausted = elapsed >= capSeconds;
  return (
    <div
      role="status"
      aria-live="polite"
      className="mt-4 text-[11px] text-slate-500"
    >
      {exhausted ? (
        <>
          Still confirming with {gateway}. Try refreshing this page in a
          minute, or contact support if the charge appears on your card.
        </>
      ) : (
        <>Confirming with {gateway}…</>
      )}
    </div>
  );
}
