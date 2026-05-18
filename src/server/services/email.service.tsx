import "server-only";

import { render } from "@react-email/render";

import { AuditAction, AuditEntity, EmailKind } from "@/lib/constants/enums";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { OrderDTO } from "@/types";

import { getMailer } from "@/server/email/smtp";
import { inlinePublicImage } from "@/server/email/inline-image";
import {
  PaymentRequestEmail,
  type PaymentRequestEmailProps,
} from "@/server/email/templates/payment-request";
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
  // Inline the provider logo as a data URI so Gmail / Outlook render it
  // without proxying back to our server. Falls back to the original
  // (absolute) URL if the file is missing or remote — same visual result
  // wherever APP_URL is publicly reachable, no regression there.
  const providerLogoInline = order.provider
    ? await inlinePublicImage(order.provider.logo)
    : null;
  const providerForEmail = order.provider
    ? { ...order.provider, logo: providerLogoInline ?? order.provider.logo }
    : order.provider;
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
    provider: providerForEmail,
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

/* ───────────────────────── Payment request ─────────────────────────── */

export interface PaymentRequestOverrides {
  /** Custom subject; falls back to a generated default. */
  subject?: string | null;
  /** Custom greeting line; falls back to "Hi {customerName},". */
  greeting?: string | null;
  /** Custom intro paragraph; falls back to a generated default. */
  intro?: string | null;
  /** Optional note rendered in a callout block. Empty = no callout. */
  note?: string | null;
  /** Optional override for the recipient address. Empty = use order's
   *  customer email. */
  toOverride?: string | null;
}

/**
 * Build a payment-request email's render-ready props from an order +
 * the agent's editable overrides. Exported separately from the send
 * path so the composer's live preview API can call it cheaply without
 * going through SMTP.
 */
export async function composePaymentRequestProps(
  order: OrderDTO,
  overrides: PaymentRequestOverrides = {},
): Promise<PaymentRequestEmailProps> {
  const branding = await getBranding();
  const providerLogoInline = order.provider
    ? await inlinePublicImage(order.provider.logo)
    : null;
  const providerForEmail = order.provider
    ? { ...order.provider, logo: providerLogoInline ?? order.provider.logo }
    : order.provider;
  return {
    brandName: branding.brandName,
    appUrl: env.server.APP_URL,
    supportEmail: branding.supportEmail,
    supportPhone: branding.supportPhone,
    customerName: order.customer.name,
    orderNumber: order.orderNumber,
    bookingType: order.bookingType,
    amount: formatMoney(order.pricing.amount, order.pricing.currency),
    dueBy: order.payment.expiresAt
      ? formatEmailDate(order.payment.expiresAt)
      : null,
    provider: providerForEmail,
    vehicle: order.vehicle,
    trip: {
      pickupDate: formatEmailDay(order.trip.pickupDate),
      dropoffDate: formatEmailDay(order.trip.dropoffDate),
    },
    paymentUrl: order.payment.checkoutUrl ?? "",
    greeting: overrides.greeting ?? null,
    intro: overrides.intro ?? null,
    note: overrides.note ?? null,
    cancellationPolicy: order.policy?.text ?? "",
    cancellationPolicyVersion: order.policy?.version ?? undefined,
  };
}

export function defaultPaymentRequestSubject(
  order: OrderDTO,
  brandName: string,
): string {
  const providerName = order.provider?.name ?? brandName;
  return `Complete your ${providerName} payment • ${order.orderNumber}`;
}

/**
 * Render and send a payment-request email. The agent composes this in
 * the workspace after creating an order; calling this twice on the same
 * order is allowed (re-send), and each send produces an audit row so
 * the order's history makes it clear how many times the customer was
 * nudged.
 */
export async function sendPaymentRequestEmail(
  order: OrderDTO,
  overrides: PaymentRequestOverrides = {},
): Promise<{ id: string | null }> {
  if (!order.payment.checkoutUrl) {
    throw new Error(
      "Order has no Stripe checkout URL — cannot send a payment request without a link to point the customer at.",
    );
  }
  const branding = await getBranding();
  const props = await composePaymentRequestProps(order, overrides);
  const subject =
    overrides.subject?.trim() ||
    defaultPaymentRequestSubject(order, branding.brandName);
  const toAddress = overrides.toOverride?.trim() || order.customer.email;
  const html = await render(<PaymentRequestEmail {...props} />);
  const text = await render(<PaymentRequestEmail {...props} />, {
    plainText: true,
  });
  return sendEmail({
    to: toAddress,
    subject,
    html,
    text,
    kind: EmailKind.PAYMENT_LINK,
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
