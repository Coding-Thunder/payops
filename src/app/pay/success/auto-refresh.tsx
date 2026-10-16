"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface PaymentSuccessAutoRefreshProps {
  /** Customer-facing name of the order's gateway ("Stripe", "PayPal").
   *  Null when the order names none — the copy then names no processor
   *  rather than guessing one. */
  gatewayLabel?: string | null;
  /** Total seconds the customer will see "still confirming" before the
   *  banner stops auto-refreshing. After the cap we still show a manual
   *  refresh hint so they're never stuck. */
  capSeconds?: number;
  /** How often we reload the page to re-query the server (which
   *  reconciles with the gateway on each render). */
  intervalSeconds?: number;
  /** The wait is for a manual-capture HOLD, which is never a charge — the
   *  fallback hint must not call it one. */
  hold?: boolean;
}

/**
 * Tiny client component the customer sees ONLY when the gateway sent them
 * to the success page but our backend hasn't recorded PAID yet — typically
 * because the webhook hasn't landed and our server-side reconcile
 * couldn't reach the gateway (offline / transient error).
 *
 * Strategy: refresh the page on a short interval (`router.refresh()`).
 * Each refresh re-renders it on the server, which re-runs the reconcile
 * with the gateway — the only thing that matters: once the order flips to
 * PAID the page paints the normal "Payment confirmed" hero and this
 * component unmounts. A refresh keeps client state, so the count below
 * survives it and the cap holds (a full reload restarted it from zero).
 *
 * We cap the loop so we don't spin forever for a genuinely failed
 * payment; after the cap we tell the customer to refresh manually.
 */
export function PaymentSuccessAutoRefresh({
  gatewayLabel = null,
  capSeconds = 30,
  intervalSeconds = 3,
  hold = false,
}: PaymentSuccessAutoRefreshProps) {
  const [elapsed, setElapsed] = useState(0);

  // ONE ticker drives the count and, through it, the refreshes. (Two
  // timers — a reload timeout re-armed by a per-second counter — never let
  // the reload fire.)
  useEffect(() => {
    if (elapsed >= capSeconds) return;
    const t = window.setTimeout(() => setElapsed((s) => s + 1), 1_000);
    return () => window.clearTimeout(t);
  }, [elapsed, capSeconds]);

  // The nth refresh is due once `n * intervalSeconds` seconds have passed,
  // up to the cap.
  const refreshes = Math.floor(
    Math.min(elapsed, capSeconds) / Math.max(1, intervalSeconds),
  );

  const exhausted = elapsed >= capSeconds;
  // Was hardcoded "Stripe", which told a PayPal brand's customer the wrong
  // processor was holding their money.
  const processor = gatewayLabel ?? "the payment provider";
  return (
    <div
      role="status"
      aria-live="polite"
      className="mt-4 text-[11px] text-slate-500"
    >
      {refreshes > 0 ? <RefreshPage times={refreshes} /> : null}
      {exhausted ? (
        <>
          {`Still confirming with ${processor}. Try refreshing this page in a minute, or contact support if the ${hold ? "hold" : "charge"} appears on your card.`}
        </>
      ) : (
        <>{`Confirming with ${processor}…`}</>
      )}
    </div>
  );
}

/**
 * Refreshes the page each time `times` grows. Mounted only once the first
 * refresh is due — after the first tick in the browser — so a server
 * render never reaches the router.
 */
function RefreshPage({ times }: { times: number }) {
  const router = useRouter();
  useEffect(() => {
    router.refresh();
  }, [times, router]);
  return null;
}
