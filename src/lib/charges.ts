/**
 * Charge breakdown — the SINGLE source of truth for the three figures the
 * rental flow cares about:
 *
 *   prepaid       → collected online via the initial payment link (this and
 *                   ONLY this is what the gateway is asked to charge).
 *   dueAtCounter  → collected by the rental counter at pick-up.
 *   total         → prepaid + dueAtCounter (the full rental cost).
 *
 * Every consumer (order service, DTO, admin UI, customer pages, emails,
 * evidence) derives these from `summarizeCharges` so they can never drift.
 * Pure + dependency-light on purpose: safe to import from client and server.
 */
import { PaymentTiming } from "@/lib/constants/enums";
import type { OrderCharge } from "@/types";

export interface ChargeSummary {
  /** Normalised, cent-rounded copy of the input charges (legacy orders get a
   *  single synthesised prepaid line). */
  charges: OrderCharge[];
  /** Sum of PREPAID charge amounts — the online/Stripe amount. */
  prepaid: number;
  /** Sum of DUE_AT_COUNTER charge amounts. */
  dueAtCounter: number;
  /** prepaid + dueAtCounter. */
  total: number;
}

/** Round to 2dp, killing binary-float dust (0.1 + 0.2 → 0.3, not 0.30000004). */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * The timing a charge line defaults to, given its position in the breakdown.
 *
 * The first line is what the payment link collects, so it defaults to
 * PREPAID. Everything after it is a supplementary line — an upgrade, a fuel
 * option, an extra driver — and in this operation those are settled at the
 * counter, so they default to DUE_AT_COUNTER.
 *
 * This is a DEFAULT, never a constraint: the operator can set any line to
 * either timing, and an explicit choice always wins. It exists because the
 * production data shows operators doing this by hand — 12 counter-charge
 * lines typed across four different spellings of "Due at Counter" — which is
 * a default waiting to be written down.
 *
 * Exported from here rather than duplicated in the form because this module
 * is already the shared client+server home for charge arithmetic; the form's
 * preview and the server's validation must resolve the same way or the
 * operator sees one thing and the order stores another.
 */
export function defaultTimingForIndex(index: number): PaymentTiming {
  return index === 0 ? PaymentTiming.PREPAID : PaymentTiming.DUE_AT_COUNTER;
}

type ChargeLike = Pick<OrderCharge, "name" | "amount" | "timing">;

/**
 * Reduce a charge list to its prepaid / due-at-counter / total figures.
 *
 * Backward compatibility: orders created before the charges model exists
 * carry no `charges[]`. Passing `fallbackPrepaidAmount` (the legacy
 * `pricing.amount`) synthesises a single fully-prepaid "Rental cost" line so
 * every downstream consumer renders identically with zero migration.
 */
export function summarizeCharges(
  charges: ReadonlyArray<ChargeLike> | null | undefined,
  fallbackPrepaidAmount?: number | null,
): ChargeSummary {
  const list = (charges ?? []).filter(
    (c): c is ChargeLike => !!c && Number.isFinite(c.amount),
  );

  if (list.length === 0) {
    const amt = round2(Math.max(0, fallbackPrepaidAmount ?? 0));
    return {
      charges:
        amt > 0
          ? [{ name: "Rental cost", amount: amt, timing: PaymentTiming.PREPAID }]
          : [],
      prepaid: amt,
      dueAtCounter: 0,
      total: amt,
    };
  }

  // Sum the ROUNDED lines — the same figures the customer is shown. Summing
  // the raw amounts and rounding once could make the lines a customer reads
  // add up to a cent more (or less) than the payment link charges.
  let prepaid = 0;
  let dueAtCounter = 0;
  for (const c of list) {
    const amount = round2(c.amount);
    if (c.timing === PaymentTiming.DUE_AT_COUNTER) dueAtCounter += amount;
    else prepaid += amount;
  }
  prepaid = round2(prepaid);
  dueAtCounter = round2(dueAtCounter);

  return {
    charges: list.map((c) => ({
      name: c.name,
      amount: round2(c.amount),
      timing: c.timing,
    })),
    prepaid,
    dueAtCounter,
    total: round2(prepaid + dueAtCounter),
  };
}
