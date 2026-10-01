import "server-only";

import type { OrderDTO } from "@/types";

import { serviceDetailRows } from "@/lib/service-summary";
import { formatEmailDay } from "./format";

/**
 * Build the mailto: URL used by the "Email us instead" fallback link in
 * the payment-request email. Prefills:
 *   - recipient (support@brand)
 *   - subject line tied to the order number
 *   - body: order facts + acknowledgement statement
 *
 * The customer's mail client opens with a draft ready to send — they
 * just hit "Send" to give us a paper trail.
 *
 * Why we keep it short: some clients (especially iOS Mail) truncate
 * mailto: bodies past ~1500 chars. Keep this under 600 chars.
 */
export function buildConsentMailto(args: {
  toEmail: string;
  brandName: string;
  order: OrderDTO;
  consentMessage: string;
}): string {
  const { order } = args;
  const subject = `Acknowledgement • Order ${order.orderNumber}`;
  const lines = [
    `Hi ${args.brandName} team,`,
    "",
    args.consentMessage,
    "",
    `Customer: ${order.customer.name}`,
    `Order: ${order.orderNumber}`,
    `Provider: ${order.provider?.name ?? "—"}`,
    // Service-aware: a car order still emits the Vehicle / Pick-up /
    // Drop-off triple in that order, byte-identical to before; a flight
    // emits Route / Airline / Departure / … instead.
    ...serviceDetailRows(order, formatEmailDay).map(
      (row) => `${row.label}: ${row.value}`,
    ),
    `Amount: ${order.pricing.amount.toFixed(2)} ${order.pricing.currency}`,
    order.payment.paymentUrl
      ? `Payment link: ${order.payment.paymentUrl}`
      : "",
    "",
    "Thank you,",
    order.customer.name,
  ].filter(Boolean);
  const body = lines.join("\n");
  return `mailto:${encodeURIComponent(args.toEmail)}?subject=${encodeURIComponent(
    subject,
  )}&body=${encodeURIComponent(body)}`;
}
