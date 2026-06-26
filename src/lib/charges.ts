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

  let prepaid = 0;
  let dueAtCounter = 0;
  for (const c of list) {
    if (c.timing === PaymentTiming.DUE_AT_COUNTER) dueAtCounter += c.amount;
    else prepaid += c.amount;
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
