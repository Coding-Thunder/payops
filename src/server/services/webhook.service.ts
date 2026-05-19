import "server-only";

import type Stripe from "stripe";
import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  OrderStatus,
} from "@/lib/constants/enums";
import {
  ProviderId,
  UNKNOWN_PROVIDER,
} from "@/lib/constants/providers";
import { DomainEventType } from "@/lib/constants/events";
import { logger } from "@/lib/logger";
import {
  Order,
  type OrderDoc,
  type OrderDocument,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { publishEvent } from "@/server/events/bus";

import { recordAudit } from "./audit.service";
import { sendPaymentConfirmationEmail } from "./email.service";

interface ProcessEventResult {
  handled: boolean;
  duplicate: boolean;
  orderId?: string;
  reason?: string;
}

/**
 * Idempotently process a Stripe event. Repeated calls with the same event id
 * are no-ops. Database mutations are atomic. Email sends are also gated by
 * the order's `confirmationEmailSentAt` so we never double-mail.
 */
export async function processStripeEvent(
  event: Stripe.Event,
): Promise<ProcessEventResult> {
  await connectMongo();
  logger.info("stripe.event", { id: event.id, type: event.type });

  await recordAudit({
    action: AuditAction.WEBHOOK_RECEIVED,
    entityType: AuditEntity.WEBHOOK,
    entityId: event.id,
    metadata: { type: event.type },
  });

  switch (event.type) {
    case "checkout.session.completed":
      return handleCheckoutCompleted(event);
    case "checkout.session.expired":
      return handleCheckoutExpired(event);
    case "checkout.session.async_payment_succeeded":
      return handleCheckoutCompleted(event);
    case "checkout.session.async_payment_failed":
      return handleCheckoutFailed(event);
    case "payment_intent.payment_failed":
      return handlePaymentIntentFailed(event);
    default:
      return { handled: false, duplicate: false, reason: "unhandled_event" };
  }
}

async function findOrderForSession(
  session: Stripe.Checkout.Session,
): Promise<OrderDocument | null> {
  const orderId = session.client_reference_id || session.metadata?.orderId;
  if (orderId && Types.ObjectId.isValid(orderId)) {
    const direct = await Order.findById(orderId);
    if (direct) return direct;
  }
  if (session.id) {
    return Order.findOne({ "payment.stripeSessionId": session.id });
  }
  return null;
}

async function handleCheckoutCompleted(
  event: Stripe.Event,
): Promise<ProcessEventResult> {
  const session = event.data.object as Stripe.Checkout.Session;
  const order = await findOrderForSession(session);
  if (!order) {
    logger.warn("stripe.order_not_found_for_session", {
      sessionId: session.id,
    });
    return { handled: false, duplicate: false, reason: "order_not_found" };
  }

  if (order.payment.processedWebhookEventIds.includes(event.id)) {
    await recordAudit({
      action: AuditAction.WEBHOOK_DUPLICATE,
      entityType: AuditEntity.WEBHOOK,
      entityId: event.id,
      metadata: { orderId: String(order._id) },
    });
    // Re-attempt the confirmation email if the payment was recorded but
    // a previous delivery's email send failed. `sendConfirmationOnce`
    // re-throws so Stripe will retry this delivery again — without this
    // branch the order would stay PAID-without-email forever once Stripe
    // saw our initial 2xx.
    if (
      order.status === OrderStatus.PAID &&
      !order.payment.confirmationEmailSentAt
    ) {
      await sendConfirmationOnce(String(order._id));
    }
    return { handled: true, duplicate: true, orderId: String(order._id) };
  }

  const isAlreadyPaid = order.status === OrderStatus.PAID;

  const amountReceived =
    typeof session.amount_total === "number"
      ? session.amount_total / 100
      : order.pricing.amount;

  // Atomic conditional update: only flip to PAID if not paid yet, and only
  // append the event id if not present. Multiple concurrent webhooks for the
  // same order collapse to a single state transition.
  const updated = await Order.findOneAndUpdate(
    {
      _id: order._id,
      "payment.processedWebhookEventIds": { $ne: event.id },
    },
    {
      $set: {
        status: OrderStatus.PAID,
        "payment.status": OrderStatus.PAID,
        "payment.paidAt": new Date(
          (event.created ?? Math.floor(Date.now() / 1000)) * 1000,
        ),
        "payment.amountReceived": amountReceived,
        "payment.paymentIntentId":
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : (order.payment.paymentIntentId ?? null),
        "payment.failureReason": null,
      },
      $push: { "payment.processedWebhookEventIds": event.id },
    },
    { returnDocument: "after" },
  ).lean<OrderDoc & { _id: Types.ObjectId }>();

  if (!updated) {
    // Conflict: another concurrent webhook already processed this event id.
    await recordAudit({
      action: AuditAction.WEBHOOK_DUPLICATE,
      entityType: AuditEntity.WEBHOOK,
      entityId: event.id,
      metadata: { orderId: String(order._id) },
    });
    return { handled: true, duplicate: true, orderId: String(order._id) };
  }

  await recordAudit({
    action: AuditAction.PAYMENT_SUCCEEDED,
    entityType: AuditEntity.PAYMENT,
    entityId: String(updated._id),
    metadata: {
      orderNumber: updated.orderNumber,
      sessionId: session.id,
      amountReceived,
      currency: updated.pricing.currency,
      eventId: event.id,
    },
  });

  if (!isAlreadyPaid) {
    publishEvent({
      type: DomainEventType.ORDER_PAID,
      audience: { kind: "creator", userId: String(updated.createdBy.userId) },
      payload: {
        orderId: String(updated._id),
        orderNumber: updated.orderNumber,
        amountReceived,
        currency: updated.pricing.currency,
        customerName: updated.customer.name,
      },
    });
    await sendConfirmationOnce(String(updated._id));
  }

  return {
    handled: true,
    duplicate: false,
    orderId: String(updated._id),
  };
}

/**
 * Sends the confirmation email iff it hasn't already been sent. The Mongo
 * claim is conditional, so even if two concurrent handlers race only one
 * wins.
 *
 * On send failure the claim is rolled back and the error is re-thrown so
 * the caller (the webhook route) can respond with 5xx and let Stripe
 * retry. Without the re-throw, a transient SMTP outage would leave the
 * order PAID-without-email permanently, since Stripe stops retrying once
 * it sees a 2xx.
 */
async function sendConfirmationOnce(orderId: string): Promise<void> {
  const claimed = await Order.findOneAndUpdate(
    { _id: orderId, "payment.confirmationEmailSentAt": null },
    { $set: { "payment.confirmationEmailSentAt": new Date() } },
    { returnDocument: "after" },
  ).lean<OrderDoc & { _id: Types.ObjectId }>();

  if (!claimed) return; // Already sent by another worker.

  try {
    const dto = orderDocToDTO(claimed);
    await sendPaymentConfirmationEmail(dto);
  } catch (err) {
    // Roll the claim back so the next webhook delivery (or the duplicate
    // re-attempt branch) can try again.
    await Order.updateOne(
      { _id: claimed._id },
      { $set: { "payment.confirmationEmailSentAt": null } },
    );
    logger.error("webhook.email_send_failed", {
      orderId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function orderDocToDTO(
  doc: OrderDoc & { _id: Types.ObjectId },
): import("@/types").OrderDTO {
  return {
    id: String(doc._id),
    orderNumber: doc.orderNumber,
    bookingType: doc.bookingType,
    status: doc.status,
    state: doc.state,
    customer: { ...doc.customer },
    provider: doc.provider
      ? {
          id: doc.provider.id,
          name: doc.provider.name,
          logo: doc.provider.logo,
          primaryColor: doc.provider.primaryColor ?? undefined,
          onPrimaryColor: doc.provider.onPrimaryColor ?? undefined,
        }
      : {
          id: ProviderId.BUDGET,
          name: UNKNOWN_PROVIDER.name,
          logo: UNKNOWN_PROVIDER.logo,
          primaryColor: UNKNOWN_PROVIDER.primaryColor,
          onPrimaryColor: UNKNOWN_PROVIDER.onPrimaryColor,
        },
    vehicle: { ...doc.vehicle },
    trip: {
      pickupDate: doc.trip.pickupDate.toISOString(),
      dropoffDate: doc.trip.dropoffDate.toISOString(),
    },
    pricing: { amount: doc.pricing.amount, currency: doc.pricing.currency },
    payment: {
      stripeSessionId: doc.payment.stripeSessionId ?? null,
      paymentIntentId: doc.payment.paymentIntentId ?? null,
      checkoutUrl: doc.payment.checkoutUrl ?? null,
      status: doc.payment.status,
      paidAt: doc.payment.paidAt ? doc.payment.paidAt.toISOString() : null,
      expiresAt: doc.payment.expiresAt
        ? doc.payment.expiresAt.toISOString()
        : null,
      amountReceived: doc.payment.amountReceived ?? null,
      receiptUrl: doc.payment.receiptUrl ?? null,
      failureReason: doc.payment.failureReason ?? null,
    },
    createdBy: {
      userId: String(doc.createdBy.userId),
      name: doc.createdBy.name,
      email: doc.createdBy.email,
    },
    policy: {
      acceptedAt:
        doc.policy?.acceptedAt?.toISOString() ?? doc.createdAt.toISOString(),
      version: doc.policy?.version ?? "v1",
      text: doc.policy?.text ?? "",
    },
    risk: {
      flagged: doc.risk?.flagged ?? false,
      flaggedNote: doc.risk?.flaggedNote ?? null,
      flaggedAt: doc.risk?.flaggedAt
        ? doc.risk.flaggedAt.toISOString()
        : null,
      flaggedBy: doc.risk?.flaggedBy
        ? {
            userId: doc.risk.flaggedBy.userId
              ? String(doc.risk.flaggedBy.userId)
              : null,
            name: doc.risk.flaggedBy.name ?? null,
          }
        : null,
    },
    notes: doc.notes ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

async function handleCheckoutExpired(
  event: Stripe.Event,
): Promise<ProcessEventResult> {
  const session = event.data.object as Stripe.Checkout.Session;
  const order = await findOrderForSession(session);
  if (!order) {
    return { handled: false, duplicate: false, reason: "order_not_found" };
  }
  if (order.status === OrderStatus.PAID) {
    return { handled: true, duplicate: true, orderId: String(order._id) };
  }
  if (order.payment.processedWebhookEventIds.includes(event.id)) {
    return { handled: true, duplicate: true, orderId: String(order._id) };
  }

  const updated = await Order.findOneAndUpdate(
    {
      _id: order._id,
      status: { $ne: OrderStatus.PAID },
      "payment.processedWebhookEventIds": { $ne: event.id },
    },
    {
      $set: {
        status: OrderStatus.EXPIRED,
        "payment.status": OrderStatus.EXPIRED,
      },
      $push: { "payment.processedWebhookEventIds": event.id },
    },
    { returnDocument: "after" },
  ).lean<OrderDoc & { _id: Types.ObjectId }>();

  if (!updated) {
    return { handled: true, duplicate: true, orderId: String(order._id) };
  }

  await recordAudit({
    action: AuditAction.PAYMENT_EXPIRED,
    entityType: AuditEntity.PAYMENT,
    entityId: String(updated._id),
    metadata: { sessionId: session.id, eventId: event.id },
  });

  publishEvent({
    type: DomainEventType.ORDER_EXPIRED,
    audience: { kind: "creator", userId: String(updated.createdBy.userId) },
    payload: {
      orderId: String(updated._id),
      orderNumber: updated.orderNumber,
      customerName: updated.customer.name,
    },
  });

  return { handled: true, duplicate: false, orderId: String(updated._id) };
}

async function handleCheckoutFailed(
  event: Stripe.Event,
): Promise<ProcessEventResult> {
  const session = event.data.object as Stripe.Checkout.Session;
  const order = await findOrderForSession(session);
  if (!order) {
    return { handled: false, duplicate: false, reason: "order_not_found" };
  }
  return failOrder(
    order,
    event,
    `Async payment failed for session ${session.id}`,
  );
}

async function handlePaymentIntentFailed(
  event: Stripe.Event,
): Promise<ProcessEventResult> {
  const pi = event.data.object as Stripe.PaymentIntent;
  const order = await Order.findOne({
    "payment.paymentIntentId": pi.id,
  });
  if (!order) {
    return { handled: false, duplicate: false, reason: "order_not_found" };
  }
  const reason =
    pi.last_payment_error?.message ?? `Payment intent ${pi.id} failed`;
  return failOrder(order, event, reason);
}

async function failOrder(
  order: OrderDocument,
  event: Stripe.Event,
  reason: string,
): Promise<ProcessEventResult> {
  if (order.payment.processedWebhookEventIds.includes(event.id)) {
    return { handled: true, duplicate: true, orderId: String(order._id) };
  }
  if (order.status === OrderStatus.PAID) {
    return { handled: true, duplicate: true, orderId: String(order._id) };
  }
  const updated = await Order.findOneAndUpdate(
    {
      _id: order._id,
      status: { $ne: OrderStatus.PAID },
      "payment.processedWebhookEventIds": { $ne: event.id },
    },
    {
      $set: {
        status: OrderStatus.FAILED,
        "payment.status": OrderStatus.FAILED,
        "payment.failureReason": reason,
      },
      $push: { "payment.processedWebhookEventIds": event.id },
    },
    { returnDocument: "after" },
  ).lean<OrderDoc & { _id: Types.ObjectId }>();

  if (!updated) {
    return { handled: true, duplicate: true, orderId: String(order._id) };
  }

  await recordAudit({
    action: AuditAction.PAYMENT_FAILED,
    entityType: AuditEntity.PAYMENT,
    entityId: String(updated._id),
    metadata: { reason, eventId: event.id },
  });

  publishEvent({
    type: DomainEventType.ORDER_FAILED,
    audience: { kind: "creator", userId: String(updated.createdBy.userId) },
    payload: {
      orderId: String(updated._id),
      orderNumber: updated.orderNumber,
      customerName: updated.customer.name,
      reason,
    },
  });

  return { handled: true, duplicate: false, orderId: String(updated._id) };
}
