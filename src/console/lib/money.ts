/**
 * Currency-aware money formatting. Amounts across the product are stored
 * in MAJOR units (e.g. dollars) on `order.pricing.amount`. This is the
 * local home of the shared money-math until the `@tracetxn/core` package
 * is extracted — it deliberately does NOT hardcode `/100` (which is wrong
 * for zero-decimal currencies like JPY/KRW, a bug the audit flagged).
 */

const ZERO_DECIMAL = new Set([
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

export function currencyDecimals(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

export function formatMoney(
  amount: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (amount == null || !currency) return "—";
  const cur = currency.toUpperCase();
  const dp = currencyDecimals(cur);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: cur,
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    }).format(amount);
  } catch {
    return `${cur} ${amount.toFixed(dp)}`;
  }
}
