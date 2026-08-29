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

/**
 * The operator to credit for an order — the "Agent" column on both the
 * dashboard's recent-orders list and /app/orders.
 *
 * Reads the creator SNAPSHOT that `order.createdBy` already carries. That
 * snapshot is written once, at order creation, from the acting user inside
 * that order's organization, so resolving an agent needs no user lookup and
 * offers nowhere for another tenant's user to be reached: there is no
 * lookup to mis-scope.
 *
 * Falls back name → email → "System". "System" covers three real cases that
 * are indistinguishable to a reader and should be: an order created before
 * the creator snapshot existed, one written by a background path with no
 * human actor, and one whose creator was recorded with neither a name nor
 * an email.
 */
export function resolveOrderAgent(
  creator: { name?: string | null; email?: string | null } | null | undefined,
): string {
  const name = creator?.name?.trim();
  if (name) return name;
  const email = creator?.email?.trim();
  if (email) return email;
  return "System";
}

/**
 * How to label the figure on the customer's payment return page.
 *
 * "Amount paid" is a claim that money moved, and it must only be made once
 * the gateway has actually confirmed the charge. PayPal in particular sends
 * the customer back the moment they APPROVE — before any capture exists —
 * and the page showed "AMOUNT PAID $0.50" for a payment that had never been
 * taken. Until confirmation the figure is the order total, so it is labelled
 * as one.
 */
export function paymentAmountLabel(confirmed: boolean): string {
  return confirmed ? "Amount paid" : "Amount";
}
