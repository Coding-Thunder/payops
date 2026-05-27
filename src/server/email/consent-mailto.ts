import "server-only";

import type { OrderDTO } from "@/types";

import { formatEmailDate } from "./format";

/**
 * Build the mailto: URL used by the "Email us instead" fallback link in
 * the payment-request email. Prefills:
 *   - recipient (support@brand)
 *   - subject line tied to the order number
 *   - body: order facts + acknowledgement statement
 *
 * Pass 5h: rental-specific (vehicle / trip / provider) lines removed.
 * The summary lists the order's line items + the scheduling window
 * (when present) so the customer's email-of-record matches whatever
 * universal-shape order they're acknowledging.
 *
 * Why short: some clients (especially iOS Mail) truncate mailto: bodies
 * past ~1500 chars. Keep this under 600 chars.
 */
export function buildConsentMailto(args: {
  toEmail: string;
  brandName: string;
  order: OrderDTO;
  consentMessage: string;
}): string {
  const { order } = args;
  const subject = `Acknowledgement • Order ${order.orderNumber}`;
  const itemsLine =
    order.lineItems.length > 0
      ? `Items: ${order.lineItems
          .map((l) => (l.quantity > 1 ? `${l.quantity}× ${l.name}` : l.name))
          .join(", ")}`
      : "";
  const lines = [
    `Hi ${args.brandName} team,`,
    "",
    args.consentMessage,
    "",
    `Customer: ${order.customer.name}`,
    `Order: ${order.orderNumber}`,
    itemsLine,
    order.scheduling
      ? `Starts: ${formatEmailDate(order.scheduling.startsAt)}`
      : "",
    order.scheduling?.endsAt
      ? `Ends: ${formatEmailDate(order.scheduling.endsAt)}`
      : "",
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
