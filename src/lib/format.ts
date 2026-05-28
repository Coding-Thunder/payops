/** Locale-aware client/server formatters for currency and dates. */

export function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount);
  } catch {
    return `${currency.toUpperCase()} ${amount.toFixed(2)}`;
  }
}

export function formatDate(
  value: string | Date | null | undefined,
  opts: Intl.DateTimeFormatOptions = {},
): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    ...opts,
  }).format(d);
}

export function formatDateTime(
  value: string | Date | null | undefined,
): string {
  return formatDate(value, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * ISO-style UTC timestamp for evidence + ledger surfaces.
 * Format: `2026-05-26 08:14:35 UTC`. Tabular, locale-free, document-grade.
 */
export function formatUtcTimestamp(
  value: string | Date | null | undefined,
): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} UTC`;
}

/**
 * Time-only variant for high-density ledger rows where the date is
 * implicit from context. Format: `08:14:35`.
 */
export function formatUtcTime(
  value: string | Date | null | undefined,
): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mi}:${ss}`;
}

/**
 * Truncate a long hex hash to the leading characters with an ellipsis.
 * Used in operational surfaces where the full hash adds noise.
 */
export function formatHashShort(
  value: string | null | undefined,
  leading = 12,
): string {
  if (!value) return "—";
  if (value.length <= leading) return value;
  return `${value.slice(0, leading)}…`;
}

export function formatRelative(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "—";
  const diff = (Date.now() - d.getTime()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
  if (abs < 60) return rtf.format(Math.round(-diff), "second");
  if (abs < 3600) return rtf.format(Math.round(-diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(-diff / 3600), "hour");
  return rtf.format(Math.round(-diff / 86400), "day");
}

/**
 * Renders an IP for an operator scanning evidence:
 *   - "::1" / "127.0.0.1" → "localhost (…)" so loopback hits in dev /
 *     staging don't look like missing data
 *   - "::ffff:1.2.3.4" → "1.2.3.4" — strips the IPv4-mapped-IPv6 prefix
 *     Node sometimes hands us behind dual-stack listeners
 *   - otherwise passes through verbatim
 */
export function formatIp(value: string | null | undefined): string {
  if (!value) return "—";
  const trimmed = value.trim();
  if (
    trimmed === "::1" ||
    trimmed === "127.0.0.1" ||
    trimmed === "0:0:0:0:0:0:0:1"
  ) {
    return `localhost (${trimmed})`;
  }
  if (trimmed.toLowerCase().startsWith("::ffff:")) {
    return trimmed.slice(7);
  }
  return trimmed;
}

export function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
