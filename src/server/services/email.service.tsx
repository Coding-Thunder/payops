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
import {
  UniversalOrderEmail,
  type UniversalOrderEmailProps,
} from "@/server/email/templates/universal-order-email";
import type { EmailBlockContext } from "@/server/email/blocks";
import { formatEmailDate, formatMoney } from "@/server/email/format";
import { buildConsentMailto } from "@/server/email/consent-mailto";
import { resolveEmailBlocksForOrder } from "./email-blocks.service";

import { recordAudit } from "./audit.service";
import { captureEvidenceSafe } from "./evidence.service";
import { getBranding } from "./branding.service";
import { getActiveTemplateContent } from "./email-template.service";
import { requestConsent } from "./consent.service";
import {
  buildConsentUrl,
  generateConsentToken,
} from "./consent-token";
import { getSettings } from "./settings.service";

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text?: string;
  kind: EmailKind;
  orderId?: string | null;
  /** Tenant brand name used as the friendly-name portion of the From
   *  header. Mailbox stays platform-controlled (SPF/DKIM aligned with
   *  the relay), but the part the recipient SEES — "TenantBrand
   *  <noreply@platform.com>" — comes from the tenant's Branding doc.
   *  When omitted, falls back to whatever's in EMAIL_FROM (which is
   *  only correct for the legacy single-tenant deployment). */
  fromName?: string | null;
  /** Tenant support email used as the Reply-To header so customer
   *  replies route to that tenant's inbox, not the platform's. */
  replyTo?: string | null;
  /** Tenant-chosen From mailbox. When empty/null, falls back to
   *  EMAIL_FROM (platform default). When set, the tenant takes
   *  responsibility for SPF/DKIM alignment on the relay. */
  senderEmail?: string | null;
}

/** Extract the mailbox portion of an RFC-5322 address header so we can
 *  rebuild it with a per-tenant friendly name. Handles both
 *  `"Name" <addr@x>` and bare `addr@x` forms. Returns the input
 *  unchanged when no mailbox is parseable — safer than throwing on a
 *  send path. */
function extractMailbox(headerValue: string): string {
  const angle = headerValue.match(/<([^>]+)>/);
  if (angle?.[1]) return angle[1].trim();
  return headerValue.trim();
}

function buildFromHeader(
  defaultHeader: string,
  fromName: string | null | undefined,
): string {
  const name = fromName?.trim();
  if (!name) return defaultHeader;
  const mailbox = extractMailbox(defaultHeader);
  // Quote the friendly name so commas / unicode / quotes can't break
  // header parsing on the recipient side.
  const escapedName = name.replace(/"/g, '\\"');
  return `"${escapedName}" <${mailbox}>`;
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
  // Per-tenant overrides (when supplied) take precedence over the
  // platform defaults. Mailbox-level overrides require the tenant to
  // have aligned SPF/DKIM for the relay; we let the operator make
  // that call rather than gating on a verification flow today.
  const defaultFrom = env.server.EMAIL_FROM;
  const tenantSender = args.senderEmail?.trim();
  const fromAddress = buildFromHeader(
    tenantSender ? tenantSender : defaultFrom,
    args.fromName ?? null,
  );
  const replyTo = args.replyTo?.trim() || env.server.EMAIL_REPLY_TO;

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
  // Pass 5f: composable block renderer. The template now works for ANY
  // order shape — rental, milk shop, pharmacy, subscription. The legacy
  // rental "vehicle + trip" UI is just one block layout among many,
  // contributed by the auto-seeded rental_booking ItemType.
  //
  // Branding lookup is scoped to the ORDER's organization — so Tenant
  // #2's customer sees Tenant #2's brand on their receipt, not the
  // legacy singleton's.
  const [branding, tpl] = await Promise.all([
    getBranding(order.orgId),
    getActiveTemplateContent("payment-confirmation", order.orgId),
  ]);
  const brandName = branding.brandName;
  const amountFormatted = formatMoney(
    order.payment.amountReceived ?? order.pricing.amount,
    order.pricing.currency,
  );
  const paidOn = order.payment.paidAt
    ? formatEmailDate(order.payment.paidAt)
    : formatEmailDate(new Date());
  // Pre-inline the rental hero image if present so the receipt renders
  // without an external network round-trip. Other verticals can supply
  // an `image_url` attribute on their line items for the same effect —
  // the resolver below picks whichever one is set.
  await inlineFirstHeroImage(order);

  const ctx: EmailBlockContext = {
    order,
    branding: {
      brandName,
      supportEmail: branding.supportEmail,
      supportPhone: branding.supportPhone,
    },
    payment: {
      amount: amountFormatted,
      paidOn,
      receiptUrl: order.payment.receiptUrl ?? null,
    },
  };
  const blocks = await resolveEmailBlocksForOrder(order);
  const props: UniversalOrderEmailProps = {
    variant: "confirmation",
    blocks,
    ctx,
  };
  const html = await render(<UniversalOrderEmail {...props} />);
  const text = await render(<UniversalOrderEmail {...props} />, {
    plainText: true,
  });
  const finalSubject =
    tpl?.subject?.trim() || defaultConfirmationSubject(order, brandName);
  const recipient = order.customer.email;
  const sent = await sendEmail({
    to: recipient,
    subject: finalSubject,
    html,
    text,
    kind: EmailKind.PAYMENT_CONFIRMATION,
    orderId: order.id,
    fromName: brandName,
    replyTo: branding.supportEmail || null,
    senderEmail: branding.senderEmail || null,
  });
  // Resolve the final From / Reply-To headers the same way sendEmail
  // did so the evidence chain records what the customer actually
  // received, not a stale env-default snapshot.
  const fromAddress = buildFromHeader(
    (branding.senderEmail?.trim() || env.server.EMAIL_FROM),
    brandName,
  );
  const replyTo = branding.supportEmail || env.server.EMAIL_REPLY_TO || null;
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
      amount: amountFormatted,
      paidOn,
      receiptUrl: order.payment.receiptUrl ?? null,
      blocks,
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

/** Pass 5f: pre-inline the first hero image into a data URI so Gmail /
 *  Outlook don't proxy the asset back to our server. Mutates the line
 *  item's `vehicle_image_url` / `image_url` attribute in place. */
async function inlineFirstHeroImage(order: OrderDTO): Promise<void> {
  const line = order.lineItems[0];
  if (!line) return;
  const attrs = line.attributes ?? {};
  const url =
    (attrs.vehicle_image_url as string | null | undefined) ??
    (attrs.image_url as string | null | undefined) ??
    null;
  if (!url) return;
  const inlined = await inlinePublicImage(url);
  if (inlined) {
    // Mutate in place — the block renderer reads the same field.
    if (attrs.vehicle_image_url) {
      (line.attributes as Record<string, unknown>).vehicle_image_url = inlined;
    } else {
      (line.attributes as Record<string, unknown>).image_url = inlined;
    }
  }
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
export interface ComposedPaymentRequest {
  template: UniversalOrderEmailProps;
  consentMailto: string;
  consentRequired: boolean;
  /** Surfaced into the audit / evidence payload so the chain captures
   *  what was wired into the email when sent. */
  primaryCta: NonNullable<UniversalOrderEmailProps["cta"]> | null;
  gatewayLabel: string | null;
}

export async function composePaymentRequestProps(
  order: OrderDTO,
  overrides: PaymentRequestOverrides = {},
  consent?: {
    consentUrl: string | null;
    consentMessage: string;
    consentRequired: boolean;
  } | null,
): Promise<ComposedPaymentRequest> {
  // Pass 5f: composable block renderer. Works for any ItemType — the
  // block list is resolved from the order's lineItems' ItemTypes plus
  // platform defaults. The legacy "vehicle + trip" UI is just one set
  // of contributed blocks (SCHEDULING_WINDOW + ITEM_HERO) on the
  // rental_booking ItemType.
  const [branding, tpl, settings] = await Promise.all([
    getBranding(order.orgId),
    getActiveTemplateContent("payment-request", order.orgId),
    getSettings(order.orgId),
  ]);

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
  const checkoutUrl = order.payment.paymentUrl ?? "";
  const consentRequired =
    consent?.consentRequired ?? settings.consentMode === ConsentMode.REQUIRED;

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

  const formattedAmount = formatMoney(
    order.pricing.amount,
    order.pricing.currency,
  );
  const primaryCta = alreadyConsented && checkoutUrl
    ? {
        url: checkoutUrl,
        label: `Pay ${formattedAmount} securely →`,
        helperText:
          "You already confirmed this order — this opens secure checkout.",
      }
    : consentUrl
      ? {
          url: consentUrl,
          label: consentRequired
            ? "Agree & Continue to Payment"
            : "Review & Confirm Order",
          helperText: effectiveConsentMessage,
        }
      : checkoutUrl
        ? {
            url: checkoutUrl,
            label: `Pay ${formattedAmount} securely →`,
            helperText: null,
          }
        : null;

  // Pre-inline hero image (same logic as the confirmation flow).
  await inlineFirstHeroImage(order);

  const blocks = await resolveEmailBlocksForOrder(order);
  const ctx: EmailBlockContext = {
    order,
    branding: {
      brandName: branding.brandName,
      supportEmail: branding.supportEmail,
      supportPhone: branding.supportPhone,
    },
    // Request emails have no paid amount yet; payment_summary block
    // renders nothing in this variant (its conditional self-suppresses).
    payment: null,
  };
  const template: UniversalOrderEmailProps = {
    variant: "request",
    blocks,
    ctx,
    cta: primaryCta,
    greeting: overrides.greeting ?? tpl?.greeting ?? null,
    intro: overrides.intro ?? tpl?.intro ?? null,
    note: overrides.note ?? tpl?.note ?? null,
  };
  const gatewayLabel = order.payment.gateway
    ? PAYMENT_GATEWAY_LABELS[order.payment.gateway as PaymentGatewayKey]
    : null;
  return {
    template,
    consentMailto,
    consentRequired,
    primaryCta: primaryCta ?? null,
    gatewayLabel,
  };
}

export function defaultPaymentRequestSubject(
  order: OrderDTO,
  brandName: string,
): string {
  return `Complete your ${brandName} payment • ${order.orderNumber}`;
}

function defaultConfirmationSubject(order: OrderDTO, brand: string): string {
  return `${brand} payment confirmed • ${order.orderNumber}`;
}

/** Build the universal consent snapshot from the order's line items +
 *  scheduling window. */
function buildConsentSnapshot(
  order: OrderDTO,
  paymentLinkRef: string | null,
): import("@/types").PaymentConsentSnapshot {
  const lineNames = order.lineItems
    .map((l) => (l.quantity > 1 ? `${l.quantity}× ${l.name}` : l.name))
    .join(", ");
  return {
    summary: lineNames || order.orderNumber,
    startsAt: order.scheduling?.startsAt ?? null,
    endsAt: order.scheduling?.endsAt ?? null,
    amount: order.pricing.amount,
    currency: order.pricing.currency,
    paymentLinkRef,
  };
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
    getBranding(order.orgId),
    getActiveTemplateContent("payment-request", order.orgId),
    getSettings(order.orgId),
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
          // Pass 5f: universal snapshot — rental fields populate when
          // the order carries them, otherwise the `summary` +
          // `startsAt/endsAt` describe the line items + scheduling.
          snapshot: buildConsentSnapshot(order, order.payment.paymentUrl),
        },
        {
          actor: context.actor,
          // Pass 5a: pin to the order's tenant so consent records
          // can't be created against a cross-tenant order id.
          orgId: order.orgId,
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

  const composed = await composePaymentRequestProps(order, overrides, {
    consentUrl,
    consentMessage: settings.consentMessage,
    consentRequired: settings.consentMode === ConsentMode.REQUIRED,
  });
  const toAddress = overrides.toOverride?.trim() || order.customer.email;
  const html = await render(<UniversalOrderEmail {...composed.template} />);
  const text = await render(<UniversalOrderEmail {...composed.template} />, {
    plainText: true,
  });
  const sent = await sendEmail({
    to: toAddress,
    subject,
    html,
    text,
    kind: EmailKind.PAYMENT_LINK,
    orderId: order.id,
    fromName: branding.brandName,
    replyTo: branding.supportEmail || null,
    senderEmail: branding.senderEmail || null,
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
      from: buildFromHeader(
        branding.senderEmail?.trim() || env.server.EMAIL_FROM,
        branding.brandName,
      ),
      replyTo: branding.supportEmail || env.server.EMAIL_REPLY_TO || null,
      to: toAddress,
      messageId: sent.id,
      brand: {
        name: branding.brandName,
        supportEmail: branding.supportEmail,
        supportPhone: branding.supportPhone,
      },
      amount: formatMoney(order.pricing.amount, order.pricing.currency),
      gateway: order.payment.gateway ?? null,
      gatewayLabel: composed.gatewayLabel,
      cta: composed.primaryCta
        ? {
            url: composed.primaryCta.url,
            label: composed.primaryCta.label,
            helperText: composed.primaryCta.helperText ?? null,
          }
        : null,
      consentRequired: composed.consentRequired,
      cancellationPolicy: order.policy?.text ?? "",
      cancellationPolicyVersion: order.policy?.version ?? null,
      blocks: composed.template.blocks,
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
    // DTO carries the order's tenant — same value the order was
    // stamped with at creation, can't drift.
    orgId: order.orgId,
    payload: {
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerName: order.customer.name,
      messageId: sent.id,
    },
  });
  return { id: sent.id, consentToken };
}

