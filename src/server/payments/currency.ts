import "server-only";

/**
 * Currency helpers shared by every payment gateway implementation.
 *
 * Zero-decimal currencies (JPY, KRW, etc.) don't have minor units — 100¥
 * is 100, not 10000. Both Stripe and most other gateways expect amounts
 * in the gateway's smallest currency unit ("amount in fils for AED",
 * "amount in cents for USD") so we centralise the conversion here.
 */

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

export function toMinorUnits(amount: number, currency: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase())) {
    return Math.round(amount);
  }
  return Math.round(amount * 100);
}

export function isZeroDecimal(currency: string): boolean {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase());
}
