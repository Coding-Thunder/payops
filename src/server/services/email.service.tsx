import "server-only";

import { render } from "@react-email/render";

import { AuditAction, AuditEntity, EmailKind } from "@/lib/constants/enums";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { OrderDTO } from "@/types";

import { getResend } from "@/server/email/resend";
import {
  PaymentConfirmationEmail,
  type PaymentConfirmationEmailProps,
} from "@/server/email/templates/payment-confirmation";
import { formatEmailDate, formatEmailDay, formatMoney } from "@/server/email/format";

import { recordAudit } from "./audit.service";

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text?: string;
  kind: EmailKind;
  orderId?: string | null;
}

async function sendEmail(args: SendArgs): Promise<{ id: string | null }> {
  const client = getResend();
  const fromAddress = env.server.EMAIL_FROM;
  const replyTo = env.server.EMAIL_REPLY_TO;

  if (!client) {
    logger.warn("email.skipped_no_resend_key", {
      kind: args.kind,
      to: args.to,
      orderId: args.orderId ?? undefined,
    });
    await recordAudit({
      action: AuditAction.EMAIL_FAILED,
      entityType: AuditEntity.ORDER,
      entityId: args.orderId ?? null,
      metadata: { reason: "RESEND_API_KEY missing", kind: args.kind },
    });
    return { id: null };
  }

  try {
    const result = await client.emails.send({
      from: fromAddress,
      to: args.to,
      replyTo: replyTo || undefined,
      subject: args.subject,
      html: args.html,
      text: args.text,
      headers: { "X-Entity-Kind": args.kind },
    });
    if (result.error) {
      throw new Error(result.error.message);
    }
    await recordAudit({
      action: AuditAction.EMAIL_SENT,
      entityType: AuditEntity.ORDER,
      entityId: args.orderId ?? null,
      metadata: {
        kind: args.kind,
        to: args.to,
        providerId: result.data?.id ?? null,
      },
    });
    return { id: result.data?.id ?? null };
  } catch (err) {
    logger.error("email.send_failed", {
      kind: args.kind,
      to: args.to,
      err: err instanceof Error ? err.message : String(err),
    });
    await recordAudit({
      action: AuditAction.EMAIL_FAILED,
      entityType: AuditEntity.ORDER,
      entityId: args.orderId ?? null,
      metadata: {
        kind: args.kind,
        to: args.to,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

/**
 * The ONLY transactional email this system sends to customers:
 * a confirmation after Stripe reports a successful payment. The same
 * template adapts its language for new bookings, modifications, and
 * cancellation charges via the `bookingType` field.
 */
export async function sendPaymentConfirmationEmail(
  order: OrderDTO,
): Promise<{ id: string | null }> {
  const brandName = env.server.APP_NAME;
  const props: PaymentConfirmationEmailProps = {
    brandName,
    appUrl: env.server.APP_URL,
    supportEmail: env.server.SUPPORT_EMAIL,
    supportPhone: env.server.SUPPORT_PHONE,
    customerName: order.customer.name,
    orderNumber: order.orderNumber,
    bookingType: order.bookingType,
    amount: formatMoney(
      order.payment.amountReceived ?? order.pricing.amount,
      order.pricing.currency,
    ),
    paidOn: order.payment.paidAt
      ? formatEmailDate(order.payment.paidAt)
      : formatEmailDate(new Date()),
    vehicle: order.vehicle,
    trip: {
      pickupDate: formatEmailDay(order.trip.pickupDate),
      dropoffDate: formatEmailDay(order.trip.dropoffDate),
    },
    receiptUrl: order.payment.receiptUrl ?? null,
  };
  const html = await render(<PaymentConfirmationEmail {...props} />);
  const text = await render(<PaymentConfirmationEmail {...props} />, {
    plainText: true,
  });
  return sendEmail({
    to: order.customer.email,
    subject: subjectForBookingType(order, brandName),
    html,
    text,
    kind: EmailKind.PAYMENT_CONFIRMATION,
    orderId: order.id,
  });
}

function subjectForBookingType(order: OrderDTO, brand: string): string {
  switch (order.bookingType) {
    case "NEW_BOOKING":
      return `Booking confirmed • ${order.orderNumber} • ${brand}`;
    case "MODIFICATION":
      return `Modification payment confirmed • ${order.orderNumber} • ${brand}`;
    case "CANCELLATION_CHARGE":
      return `Cancellation payment confirmed • ${order.orderNumber} • ${brand}`;
    default:
      return `Payment confirmed • ${order.orderNumber} • ${brand}`;
  }
}
