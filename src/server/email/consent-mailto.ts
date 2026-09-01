import "server-only";

import { ServiceType } from "@/lib/constants/enums";
import { serviceDetailRows, serviceTypeOf } from "@/lib/service-summary";
import type { OrderDTO } from "@/types";

import { formatEmailDay } from "./format";

/**
 * The order-facts block: what was booked, in the booking's own vocabulary.
 *
 * CAR_RENTAL reproduces the three lines this function emitted inline before
 * service types existed — "Vehicle: Company • Type" then the bare pick-up
 * and drop-off days, no locations. `serviceDetailRows()` renders the rental
 * case slightly differently (a space instead of "•"), so the rental branch
 * deliberately keeps its own literals rather than routing through it; a
 * flight or a cruise has no vehicle and no pick-up at all and takes the
 * shared helper, which is the whole point of that module.
 */
function serviceLines(order: OrderDTO): string[] {
  if (serviceTypeOf(order) === ServiceType.CAR_RENTAL) {
    const lines: string[] = [];
    if (order.vehicle) {
      lines.push(`Vehicle: ${order.vehicle.company} • ${order.vehicle.type}`);
    }
    if (order.trip) {
      lines.push(`Pick-up: ${formatEmailDay(order.trip.pickupDate)}`);
      lines.push(`Drop-off: ${formatEmailDay(order.trip.dropoffDate)}`);
    }
    return lines;
  }
  return serviceDetailRows(order, formatEmailDay).map(
    (row) => `${row.label}: ${row.value}`,
  );
}

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
    ...serviceLines(order),
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
