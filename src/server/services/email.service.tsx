import "server-only";

import { render } from "@react-email/render";

import {
  AuditAction,
  AuditEntity,
  ConsentMode,
  ConsentStatus,
  EmailKind,
  OrderEvidenceActorType,
  OrderEvidenceEventType,
  type PaymentGatewayKey,
  type UserRole,
} from "@/lib/constants/enums";
import { PaymentGatewayLabel as PAYMENT_GATEWAY_LABELS } from "@/lib/constants/labels";
import { env } from "@/lib/env";
import { DomainEventType } from "@/lib/constants/events";
import { logger } from "@/lib/logger";
import { publishEvent } from "@/server/events/bus";
import type { OrderDTO } from "@/types";

import { getMailer } from "@/server/email/smtp";
import { inlinePublicImage } from "@/server/email/inline-image";
import type { EmailChargeBreakdown } from "@/server/email/components";
import {
  PaymentRequestEmail,
  type PaymentRequestEmailProps,
} from "@/server/email/templates/payment-request";
import {
  PaymentConfirmationEmail,
  type PaymentConfirmationEmailProps,
} from "@/server/email/templates/payment-confirmation";
import { formatEmailDate, formatEmailDay, formatMoney } from "@/server/email/format";
import { buildConsentMailto } from "@/server/email/consent-mailto";
import { summarizeCharges } from "@/lib/charges";

import { recordAudit } from "./audit.service";
import { captureEvidenceSafe } from "./evidence.service";
import { getBranding } from "./branding.service";
import { getActiveTemplateContent } from "./email-template.service";
import { requestConsent } from "./consent.service";
import {
  buildConsentUrl,
  generateConsentToken,
} from "./consent-token";
import { buildAckUrl, generateAckToken } from "./ack-token";
import { getSettings } from "./settings.service";

/** Build a presentation-ready (currency-formatted) charge breakdown for an
 *  order, used by both customer emails. Legacy orders (no `charges[]`) get a
 *  single synthesised prepaid line via `summarizeCharges`. */
function buildEmailChargeBreakdown(order: OrderDTO): EmailChargeBreakdown {
  const s = summarizeCharges(order.charges, order.pricing.amount);
  const currency = order.pricing.currency;
  return {
    lines: s.charges.map((c) => ({
      name: c.name,
      amount: formatMoney(c.amount, currency),
      timing: c.timing,
    })),
    prepaid: formatMoney(s.prepaid, currency),
    dueAtCounter: s.dueAtCounter > 0 ? formatMoney(s.dueAtCounter, currency) : null,
    total: formatMoney(s.total, currency),
  };
}

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text?: string;
  kind: EmailKind;
  orderId?: string | null;
}

/** Reduce a full email to `a***@example.com` for logger output — keeps
 *  ops-grade signal (domain, first char) while dropping the PII surface
 *  on log spills. */
function maskEmail(addr: string): string {
  if (!addr) return "(empty)";
  const at = addr.indexOf("@");
  if (at <= 0) return "(masked)";
  const local = addr.slice(0, at);
  const domain = addr.slice(at);
  const head = local.slice(0, 1);
  return `${head}***${domain}`;
}

async function sendEmail(args: SendArgs): Promise<{ id: string | null }> {
  const mailer = getMailer();
  const fromAddress = env.server.EMAIL_FROM;
  const replyTo = env.server.EMAIL_REPLY_TO;

  if (!mailer) {
    logger.warn("email.skipped_no_smtp_config", {
      kind: args.kind,
      toMasked: maskEmail(args.to),
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
    // Deliverability headers. A List-Unsubscribe header (mailto form) is a
    // strong signal for strict receivers (notably Yahoo / AOL, which apply
    // bulk-sender rules aggressively). We point it at the reply-to / support
    // mailbox since there is no one-click unsubscribe endpoint for these
    // transactional sends. `Auto-Submitted` marks them as system-generated.
    const unsubAddr = replyTo || null;
    const headers: Record<string, string> = {
      "X-Entity-Kind": args.kind,
      "Auto-Submitted": "auto-generated",
    };
    if (unsubAddr) {
      headers["List-Unsubscribe"] =
        `<mailto:${unsubAddr}?subject=unsubscribe>`;
    }
    const info = await mailer.sendMail({
      from: fromAddress,
      to: args.to,
      replyTo: replyTo || undefined,
      subject: args.subject,
      html: args.html,
      text: args.text,
      headers,
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
      toMasked: maskEmail(args.to),
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
  const [branding, tpl] = await Promise.all([
    getBranding(),
    getActiveTemplateContent("payment-confirmation"),
  ]);
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
      pickupLocation: order.trip.pickupLocation ?? null,
      dropoffLocation: order.trip.dropoffLocation ?? null,
    },
    confirmationNumber: order.confirmationNumber ?? null,
    chargeBreakdown: buildEmailChargeBreakdown(order),
    termsText: order.terms?.text || null,
    termsVersion: order.terms?.version ?? null,
    // Signed "I Agree" link — only when there are terms to acknowledge.
    acknowledgeUrl: order.terms?.text
      ? buildAckUrl(env.server.APP_URL, generateAckToken(order.id))
      : null,
    receiptUrl: order.payment.receiptUrl ?? null,
    cancellationPolicy: order.policy?.text ?? "",
    cancellationPolicyVersion: order.policy?.version ?? undefined,
  };
  const html = await render(<PaymentConfirmationEmail {...props} />);
  const text = await render(<PaymentConfirmationEmail {...props} />, {
    plainText: true,
  });
  const finalSubject =
    tpl?.subject?.trim() || subjectForBookingType(order, brandName);
  const fromAddress = env.server.EMAIL_FROM;
  const replyTo = env.server.EMAIL_REPLY_TO || null;
  const recipient = order.customer.email;
  const sent = await sendEmail({
    to: recipient,
    subject: finalSubject,
    html,
    text,
    kind: EmailKind.PAYMENT_CONFIRMATION,
    orderId: order.id,
  });
  // Evidence chain: capture the rendered confirmation HTML BEFORE the
  // template can drift. Even if the send went out without an SMTP
  // configured, we still want the exact bytes the customer would have
  // seen so a future dispute can show what we promised.
  await captureEvidenceSafe({
    orderId: order.id,
    orderNumber: order.orderNumber,
    eventType: OrderEvidenceEventType.CONFIRMATION_EMAIL_SENT,
    actor: { type: OrderEvidenceActorType.SYSTEM, name: "Payment webhook" },
    payload: {
      kind: EmailKind.PAYMENT_CONFIRMATION,
      subject: finalSubject,
      from: fromAddress,
      replyTo,
      to: recipient,
      messageId: sent.id,
      brand: {
        name: brandName,
        supportEmail: branding.supportEmail,
        supportPhone: branding.supportPhone,
      },
      amount: props.amount,
      paidOn: props.paidOn,
      receiptUrl: props.receiptUrl ?? null,
      html,
      text,
    },
    refs: {
      messageId: sent.id ?? null,
      customerEmail: recipient,
    },
  });
  return sent;
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
 *
 * Consent-first single-CTA flow:
 *   - if the order's consent has NOT been received yet → primary CTA
 *     lands on the hosted consent page (and the page redirects to
 *     Stripe after the customer confirms)
 *   - if consent has already been received (re-send case) → primary
 *     CTA goes straight to Stripe, no detour
 *
 * `consent` is OPTIONAL because the preview path needs to render
 * without persisting a record. The send path always passes one (see
 * `sendPaymentRequestEmail`).
 */
export async function composePaymentRequestProps(
  order: OrderDTO,
  overrides: PaymentRequestOverrides = {},
  consent?: {
    consentUrl: string | null;
    consentMessage: string;
    consentRequired: boolean;
  } | null,
): Promise<PaymentRequestEmailProps> {
  const [branding, tpl, settings] = await Promise.all([
    getBranding(),
    getActiveTemplateContent("payment-request"),
    getSettings(),
  ]);
  const providerLogoInline = order.provider
    ? await inlinePublicImage(order.provider.logo)
    : null;
  const providerForEmail = order.provider
    ? { ...order.provider, logo: providerLogoInline ?? order.provider.logo }
    : order.provider;
  const effectiveConsentMessage =
    consent?.consentMessage ?? settings.consentMessage;
  const consentMailto = buildConsentMailto({
    toEmail: branding.supportEmail,
    brandName: branding.brandName,
    order,
    consentMessage: effectiveConsentMessage,
  });

  // Pick the single primary CTA. Consent-first by default; jump straight
  // to Stripe only when the customer has already acknowledged a previous
  // send (RECEIVED / VERIFIED).
  const alreadyConsented =
    order.consent?.status === ConsentStatus.RECEIVED ||
    order.consent?.status === ConsentStatus.VERIFIED;
  // Gateway-agnostic at the call site — `order.payment.paymentUrl` is
  // whatever the chosen gateway returned. Variable kept generic.
  const checkoutUrl = order.payment.paymentUrl ?? "";
  const consentRequired =
    consent?.consentRequired ?? settings.consentMode === ConsentMode.REQUIRED;

  // Resolve the consent URL.
  //   - Send path: caller passes `consent.consentUrl` from requestConsent.
  //   - Preview path (no consent arg): if the order already has a consent
  //     record (re-send case), sign its id so the preview shows the
  //     real link the customer would receive. First-time preview falls
  //     back to a clearly-labelled placeholder so the agent still sees
  //     the correct CTA copy ("Review & Confirm Booking") — the actual
  //     link is signed when they click Send.
  let consentUrl: string | null = consent?.consentUrl ?? null;
  if (!consentUrl && !alreadyConsented) {
    const existingId = order.consent?.currentConsentId;
    if (existingId) {
      consentUrl = buildConsentUrl(
        env.server.APP_URL,
        generateConsentToken(existingId),
      );
    } else {
      consentUrl = `${env.server.APP_URL.replace(/\/$/, "")}/consent/preview`;
    }
  }

  const primaryCta = alreadyConsented && checkoutUrl
    ? {
        url: checkoutUrl,
        label: `Pay ${formatMoney(order.pricing.amount, order.pricing.currency)} securely with Stripe →`,
        helperText:
          "You already confirmed this booking — this opens Stripe Checkout.",
      }
    : consentUrl
      ? {
          url: consentUrl,
          label: consentRequired
            ? "Agree & Continue to Payment"
            : "Review & Confirm Booking",
          helperText: effectiveConsentMessage,
        }
      : checkoutUrl
        ? {
            url: checkoutUrl,
            label: `Pay ${formatMoney(order.pricing.amount, order.pricing.currency)} securely with Stripe →`,
            helperText: null,
          }
        : null;
  // Layering: agent override → admin's active template override → null
  // (template fallback to hardcoded copy). The composer's "leave blank
  // to use defaults" hint covers BOTH the agent-side and template-side
  // defaults without the agent having to know about templates.
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
      pickupLocation: order.trip.pickupLocation ?? null,
      dropoffLocation: order.trip.dropoffLocation ?? null,
    },
    chargeBreakdown: buildEmailChargeBreakdown(order),
    paymentUrl: checkoutUrl,
    gatewayLabel: order.payment.gateway
      ? PAYMENT_GATEWAY_LABELS[order.payment.gateway as PaymentGatewayKey]
      : null,
    greeting: overrides.greeting ?? tpl?.greeting ?? null,
    intro: overrides.intro ?? tpl?.intro ?? null,
    note: overrides.note ?? tpl?.note ?? null,
    cancellationPolicy: order.policy?.text ?? "",
    cancellationPolicyVersion: order.policy?.version ?? undefined,
    termsText: order.terms?.text || null,
    termsVersion: order.terms?.version ?? null,
    primaryCta: primaryCta ?? undefined,
    consentMailto,
    consentRequired,
  };
}

export function defaultPaymentRequestSubject(
  order: OrderDTO,
  brandName: string,
): string {
  const providerName = order.provider?.name ?? brandName;
  return `Complete your ${providerName} payment • ${order.orderNumber}`;
}

export interface SendPaymentRequestContext {
  /** Operator triggering the send. Recorded as the actor on the consent
   *  request audit row so we can trace who asked the customer to
   *  acknowledge. */
  actor: {
    id: string;
    name: string;
    email: string;
    role: UserRole;
  };
  request?: {
    ip: string | null;
    userAgent: string | null;
    requestId: string | null;
  } | null;
}

/**
 * Render and send a payment-request email. The agent composes this in
 * the workspace after creating an order; calling this twice on the same
 * order is allowed (re-send), and each send produces an audit row so
 * the order's history makes it clear how many times the customer was
 * nudged.
 *
 * As of the consent layer (May 2026), each send also creates (or
 * refreshes) a PaymentConsent record in REQUESTED state so the customer
 * can click "I Agree" before paying. The consent URL is signed with the
 * record's HMAC token; mailto fallback is generated locally and never
 * persisted.
 */
export async function sendPaymentRequestEmail(
  order: OrderDTO,
  overrides: PaymentRequestOverrides = {},
  context?: SendPaymentRequestContext,
): Promise<{ id: string | null; consentToken: string | null }> {
  if (!order.payment.paymentUrl) {
    throw new Error(
      "Order has no payment link yet — generate the link via the email composer before sending the request.",
    );
  }
  const [branding, tpl, settings] = await Promise.all([
    getBranding(),
    getActiveTemplateContent("payment-request"),
    getSettings(),
  ]);

  let consentUrl: string | null = null;
  let consentToken: string | null = null;
  const subject =
    overrides.subject?.trim() ||
    tpl?.subject?.trim() ||
    defaultPaymentRequestSubject(order, branding.brandName);

  if (context?.actor) {
    try {
      const result = await requestConsent(
        {
          orderId: order.id,
          customerEmail: overrides.toOverride?.trim() || order.customer.email,
          customerName: order.customer.name,
          consentMessage: settings.consentMessage,
          consentEmailSubject: subject,
          snapshot: (() => {
            const s = summarizeCharges(order.charges, order.pricing.amount);
            return {
              bookingType: order.bookingType,
              provider: order.provider?.name ?? "",
              vehicle: `${order.vehicle.company} • ${order.vehicle.type}`,
              pickupDate: order.trip.pickupDate,
              dropoffDate: order.trip.dropoffDate,
              pickupLocation: order.trip.pickupLocation ?? null,
              dropoffLocation: order.trip.dropoffLocation ?? null,
              amount: order.pricing.amount,
              currency: order.pricing.currency,
              charges: s.charges,
              dueAtCounter: s.dueAtCounter,
              total: s.total,
              paymentLinkRef: order.payment.paymentUrl,
            };
          })(),
        },
        {
          actor: context.actor,
          appUrl: env.server.APP_URL,
          request: context.request ?? null,
        },
      );
      consentUrl = result.consentUrl;
      consentToken = result.token;
    } catch (err) {
      // Consent persistence should never block the email send — log and
      // continue with no consentUrl (only the mailto fallback survives).
      logger.error("email.consent_request_failed", {
        orderId: order.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const props = await composePaymentRequestProps(order, overrides, {
    consentUrl,
    consentMessage: settings.consentMessage,
    consentRequired: settings.consentMode === ConsentMode.REQUIRED,
  });
  const toAddress = overrides.toOverride?.trim() || order.customer.email;
  const html = await render(<PaymentRequestEmail {...props} />);
  const text = await render(<PaymentRequestEmail {...props} />, {
    plainText: true,
  });
  const sent = await sendEmail({
    to: toAddress,
    subject,
    html,
    text,
    kind: EmailKind.PAYMENT_LINK,
    orderId: order.id,
  });

  // Evidence chain: capture the rendered payment-request HTML the customer
  // received, including the consent CTA copy and the gateway label
  // active at this send. Snapshots are append-only so re-sends each get
  // their own evidence event.
  await captureEvidenceSafe({
    orderId: order.id,
    orderNumber: order.orderNumber,
    eventType: OrderEvidenceEventType.PAYMENT_REQUEST_EMAIL_SENT,
    actor: context?.actor
      ? {
          type: OrderEvidenceActorType.AGENT,
          userId: context.actor.id,
          name: context.actor.name,
          email: context.actor.email,
          role: context.actor.role,
        }
      : { type: OrderEvidenceActorType.SYSTEM, name: "Email composer" },
    request: context?.request ?? null,
    payload: {
      kind: EmailKind.PAYMENT_LINK,
      subject,
      from: env.server.EMAIL_FROM,
      replyTo: env.server.EMAIL_REPLY_TO || null,
      to: toAddress,
      messageId: sent.id,
      brand: {
        name: props.brandName,
        supportEmail: props.supportEmail,
        supportPhone: props.supportPhone,
      },
      amount: props.amount,
      gateway: order.payment.gateway ?? null,
      gatewayLabel: props.gatewayLabel ?? null,
      cta: props.primaryCta
        ? {
            url: props.primaryCta.url,
            label: props.primaryCta.label,
            helperText: props.primaryCta.helperText ?? null,
          }
        : null,
      consentRequired: props.consentRequired ?? false,
      cancellationPolicy: props.cancellationPolicy,
      cancellationPolicyVersion: props.cancellationPolicyVersion ?? null,
      html,
      text,
    },
    refs: {
      messageId: sent.id ?? null,
      customerEmail: toAddress,
      paymentSessionId: order.payment.paymentSessionId ?? null,
      paymentIntentId: order.payment.paymentIntentId ?? null,
    },
  });

  // Push the lifecycle-transition event so the timeline's "Email sent"
  // node lights up the moment the send completes, instead of waiting for
  // the next 5s poll or a manual refresh. The audit row was already
  // written by `sendEmail`; this is purely the realtime push.
  logger.info("order.lifecycle.transition", {
    orderId: order.id,
    orderNumber: order.orderNumber,
    previousState: order.status,
    nextState: order.status,
    transition: "email_sent",
    source: "service.email.payment_request",
    actor: context?.actor?.id ?? null,
  });
  publishEvent({
    type: DomainEventType.ORDER_EMAIL_SENT,
    audience: { kind: "creator", userId: order.createdBy.userId },
    actor: context?.actor
      ? {
          id: context.actor.id,
          name: context.actor.name,
          role: context.actor.role,
        }
      : undefined,
    payload: {
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerName: order.customer.name,
      messageId: sent.id,
    },
  });
  return { id: sent.id, consentToken };
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
