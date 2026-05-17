import "server-only";

import { render } from "@react-email/render";

import { AuditAction, AuditEntity, EmailKind } from "@/lib/constants/enums";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { OrderDTO } from "@/types";

import { getMailer } from "@/server/email/smtp";
import {
  PaymentConfirmationEmail,
  type PaymentConfirmationEmailProps,
} from "@/server/email/templates/payment-confirmation";
import { formatEmailDate, formatEmailDay, formatMoney } from "@/server/email/format";

import { recordAudit } from "./audit.service";
import { getBranding } from "./branding.service";

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text?: string;
  kind: EmailKind;
  orderId?: string | null;
}

async function sendEmail(args: SendArgs): Promise<{ id: string | null }> {
  const mailer = getMailer();
  const fromAddress = env.server.EMAIL_FROM;
  const replyTo = env.server.EMAIL_REPLY_TO;

  if (!mailer) {
    logger.warn("email.skipped_no_smtp_config", {
      kind: args.kind,
      to: args.to,
      orderId: args.orderId ?? undefined,
    });
    await recordAudit({
      action: AuditAction.EMAIL_FAILED,
      entityType: AuditEntity.ORDER,
      entityId: args.orderId ?? null,
      metadata: {
        reason: "SMTP not configured (SMTP_HOST / SMTP_USER / SMTP_PASS)",
        kind: args.kind,
      },
    });
    return { id: null };
  }

  try {
    const info = await mailer.sendMail({
      from: fromAddress,
      to: args.to,
      replyTo: replyTo || undefined,
      subject: args.subject,
      html: args.html,
      text: args.text,
      headers: { "X-Entity-Kind": args.kind },
    });
    await recordAudit({
      action: AuditAction.EMAIL_SENT,
      entityType: AuditEntity.ORDER,
      entityId: args.orderId ?? null,
      metadata: {
        kind: args.kind,
        to: args.to,
        messageId: info.messageId ?? null,
        response: info.response ?? null,
      },
    });
    return { id: info.messageId ?? null };
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
  // Branding is a single Mongo read per send. We deliberately don't cache
  // it across sends so a brand-name / support-contact change propagates to
  // the very next confirmation, no process restart required.
  const branding = await getBranding();
  const brandName = branding.brandName;
  const props: PaymentConfirmationEmailProps = {
    brandName,
    appUrl: env.server.APP_URL,
    supportEmail: branding.supportEmail,
    supportPhone: branding.supportPhone,
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
    provider: order.provider,
    vehicle: order.vehicle,
    trip: {
      pickupDate: formatEmailDay(order.trip.pickupDate),
      dropoffDate: formatEmailDay(order.trip.dropoffDate),
    },
    receiptUrl: order.payment.receiptUrl ?? null,
    cancellationPolicy: order.policy?.text ?? "",
    cancellationPolicyVersion: order.policy?.version ?? undefined,
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
  // Provider name leads the subject so the customer can tell at a glance
  // which rental this email is about — most actionable identifier first.
  const providerName = order.provider?.name ?? brand;
  switch (order.bookingType) {
    case "NEW_BOOKING":
      return `${providerName} booking confirmed • ${order.orderNumber}`;
    case "MODIFICATION":
      return `${providerName} modification confirmed • ${order.orderNumber}`;
    case "CANCELLATION_CHARGE":
      return `${providerName} cancellation charge • ${order.orderNumber}`;
    default:
      return `${providerName} payment confirmed • ${order.orderNumber}`;
  }
}
