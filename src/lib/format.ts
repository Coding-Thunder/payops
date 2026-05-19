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
