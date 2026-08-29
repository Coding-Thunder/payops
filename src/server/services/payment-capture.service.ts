import "server-only";

import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  BookingStatus,
  CaptureMode,
  OrderEvidenceActorType,
  OrderEvidenceEventType,
  OrderStatus,
  PaymentCaptureStatus,
  RecordState,
} from "@/lib/constants/enums";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PaymentError,
} from "@/lib/errors";
import { logger } from "@/lib/logger";
import { Order, type OrderDoc } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { supportsManualCapture } from "@/server/payments/gateway";
import { toMinorUnits } from "@/server/payments/currency";
import type { OrderDTO } from "@/types";

import { recordAudit } from "./audit.service";
import { captureEvidenceSafe } from "./evidence.service";
import {
  assertOrderInScope,
  getOrderById,
  resolveGatewayForOrder,
  type OrderContext,
} from "./order.service";
import { applyCheckoutPaid } from "./webhook.service";

/**
 * OPERATOR-DRIVEN half of the manual-capture flow.
 *
 * The webhook handlers in webhook.service.ts observe what the gateway did.
 * This module is what an operator DOES: convert an authorized hold into a
 * charge once the booking is confirmed with the supplier, or release the
 * hold when it cannot be fulfilled.
 *
 * Two properties matter more than anything else here, because this is the
 * only place in the application where a human action moves real money:
 *
 *  1. IT IS UNREACHABLE FOR AN AUTOMATIC-CAPTURE ORDER. Every entry point
 *     checks `payment.capture.method === MANUAL` before doing anything, and
 *     `payment.capture` is null on every order RentalConfirmation and
 *     TripReservations have ever created. There is no code path by which
 *     either incumbent brand's order can be captured or voided here.
 *
 *  2. IT CANNOT DOUBLE-CHARGE. The AUTHORIZED → CAPTURE_PENDING transition
 *     is a conditional update that exactly one caller can win, and the
 *     Stripe call carries a per-order idempotency key on top. An operator
 *     double-clicking "Capture payment" charges the customer once.
 *
 * Booking status and payment status are kept strictly separate, as the
 * business workflow requires: capture confirms the BOOKING
 * (`bookingStatus: CONFIRMED`) and separately settles the PAYMENT
 * (`status: PAID`, via the shared `applyCheckoutPaid`).
 */

interface CaptureOptions {
  /** Major units. Omitted = capture the full authorized amount. */
  amount?: number | null;
}

interface CancelOptions {
  reason?: string | null;
}

/** Load an order and prove the caller may act on it. */
async function loadCapturableOrder(
  id: string,
  ctx: OrderContext,
  permission: Permission,
) {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Order not found");
  const doc = await Order.findById(id);
  if (!doc) throw new NotFoundError("Order not found");

  // Tenancy first: an order belonging to another organization is a 404,
  // identical to one that does not exist, so this is not a probe oracle.
  await assertOrderInScope(doc);

  if (!roleHasPermission(ctx.actor.role, permission)) {
    throw new ForbiddenError(
      "You do not have permission to perform this payment operation",
    );
  }

  if (doc.state === RecordState.ARCHIVED) {
    throw new ConflictError("Cannot act on an archived order");
  }

  // THE GATE. An automatic-capture order has no `payment.capture` at all,
  // so it can never reach the gateway calls below.
  if (doc.payment?.capture?.method !== CaptureMode.MANUAL) {
    throw new ConflictError(
      "This order was charged at checkout. Capture and release apply only to authorized payments.",
    );
  }

  const paymentIntentId = doc.payment.paymentIntentId;
  if (!paymentIntentId) {
    throw new ConflictError(
      "This order has no payment intent to act on yet.",
    );
  }

  return { doc, paymentIntentId };
}

/**
 * Resolve the gateway for this order and prove it can capture.
 *
 * Resolution is by the ORDER's organization, never the request's — the same
 * rule `initiatePayment` follows — so a capture always lands on the merchant
 * account that holds the authorization, even if the operator has switched
 * tenants in another tab.
 */
async function manualCaptureGatewayFor(doc: OrderDoc) {
  const gateway = await resolveGatewayForOrder(doc, null);
  if (!supportsManualCapture(gateway)) {
    throw new ConflictError(
      `${gateway.label} does not support capturing an authorized payment.`,
    );
  }
  return gateway;
}

/**
 * Capture an authorized payment. The operator has confirmed the booking;
 * now take the money.
 */
export async function capturePayment(
  id: string,
  ctx: OrderContext,
  options: CaptureOptions = {},
): Promise<OrderDTO> {
  const { doc, paymentIntentId } = await loadCapturableOrder(
    id,
    ctx,
    Permission.ORDER_CAPTURE_PAYMENT,
  );

  const captureStatus = doc.payment.capture?.status;
  if (captureStatus === PaymentCaptureStatus.CAPTURED) {
    // Already done. Idempotent from the operator's point of view.
    return getOrderById(id, ctx);
  }
  if (
    captureStatus !== PaymentCaptureStatus.AUTHORIZED &&
    captureStatus !== PaymentCaptureStatus.CAPTURE_FAILED
  ) {
    throw new ConflictError(
      `Cannot capture — the payment is ${String(captureStatus ?? "not authorized").toLowerCase()}.`,
    );
  }

  const authorized =
    doc.payment.capture?.amountAuthorized ?? doc.pricing.amount;
  const requested = options.amount ?? null;
  if (requested !== null) {
    if (!Number.isFinite(requested) || requested <= 0) {
      throw new ConflictError("Capture amount must be a positive number");
    }
    if (requested > authorized) {
      // Stripe would reject this too, but failing here keeps the error
      // legible and avoids burning the idempotency key on a doomed call.
      throw new ConflictError(
        "Cannot capture more than the authorized amount",
      );
    }
  }

  const gateway = await manualCaptureGatewayFor(doc);

  // CLAIM the transition before calling Stripe. Exactly one concurrent
  // caller can move AUTHORIZED → CAPTURE_PENDING, so a double-click cannot
  // produce two capture calls. If Stripe then fails we roll the status
  // back to CAPTURE_FAILED, which is retryable.
  const claimed = await Order.findOneAndUpdate(
    {
      _id: doc._id,
      "payment.capture.status": {
        $in: [
          PaymentCaptureStatus.AUTHORIZED,
          PaymentCaptureStatus.CAPTURE_FAILED,
        ],
      },
    },
    { $set: { "payment.capture.status": PaymentCaptureStatus.CAPTURE_PENDING } },
    { returnDocument: "after" },
  ).lean<OrderDoc & { _id: Types.ObjectId }>();

  if (!claimed) {
    throw new ConflictError(
      "Another capture is already in progress for this order.",
    );
  }

  let result;
  try {
    result = await gateway.capturePayment(paymentIntentId, {
      amountMinor:
        requested !== null
          ? toMinorUnits(requested, doc.pricing.currency)
          : null,
      // Per-order key: a retry after a network timeout replays Stripe's
      // original capture rather than issuing a second one.
      idempotencyKey: `order:${String(doc._id)}:capture`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await Order.updateOne(
      { _id: doc._id, "payment.capture.status": PaymentCaptureStatus.CAPTURE_PENDING },
      {
        $set: {
          "payment.capture.status": PaymentCaptureStatus.CAPTURE_FAILED,
          "payment.capture.lastError": message.slice(0, 512),
        },
      },
    );
    await recordAudit({
      action: AuditAction.PAYMENT_CAPTURE_FAILED,
      entityType: AuditEntity.PAYMENT,
      entityId: String(doc._id),
      organizationId: doc.organizationId ?? null,
      actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
      request: ctx.request ?? null,
      metadata: { orderNumber: doc.orderNumber, reason: message },
    });
    logger.error("payments.capture_failed", {
      orderId: String(doc._id),
      err: message,
    });
    throw new PaymentError("Could not capture this payment", err);
  }

  const capturedMajor =
    typeof result.amountReceivedMinor === "number"
      ? result.amountReceivedMinor / 100
      : (requested ?? authorized);
  const capturedAt = new Date();

  // Settle the PAYMENT through the SHARED transition, so the audit row, the
  // evidence entry, the ORDER_PAID domain event and the exactly-once
  // confirmation email behave identically to an automatic-capture order.
  // The synthetic event id is namespaced away from real Stripe ids
  // (`evt_…`) and from reconcile's (`reconcile:…`), so the webhook that
  // follows collapses to a duplicate rather than paying twice.
  await applyCheckoutPaid(doc, {
    eventId: `capture:${paymentIntentId}`,
    sessionId: doc.payment.stripeSessionId ?? "",
    paymentIntentId,
    amountTotal:
      result.amountReceivedMinor ??
      toMinorUnits(capturedMajor, doc.pricing.currency),
    paidAtMs: capturedAt.getTime(),
    source: "webhook",
  });

  // Then the BOOKING and the capture bookkeeping. Separate write because
  // these are separate concepts: the money settled, AND the booking is
  // confirmed.
  await Order.updateOne(
    { _id: doc._id },
    {
      $set: {
        "payment.capture.status": PaymentCaptureStatus.CAPTURED,
        "payment.capture.capturedAt": capturedAt,
        "payment.capture.amountCaptured": capturedMajor,
        "payment.capture.lastError": null,
        bookingStatus: BookingStatus.CONFIRMED,
      },
    },
  );

  await recordAudit({
    action: AuditAction.PAYMENT_CAPTURED,
    entityType: AuditEntity.PAYMENT,
    entityId: String(doc._id),
    organizationId: doc.organizationId ?? null,
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: {
      orderNumber: doc.orderNumber,
      paymentIntentId,
      amountCaptured: capturedMajor,
      amountAuthorized: authorized,
      partial: capturedMajor < authorized,
      currency: doc.pricing.currency,
      gatewayStatus: result.status,
    },
  });

  await captureEvidenceSafe({
    orderId: String(doc._id),
    orderNumber: doc.orderNumber,
    eventType: OrderEvidenceEventType.PAYMENT_CAPTURED,
    occurredAt: capturedAt,
    actor: {
      type: OrderEvidenceActorType.AGENT,
      userId: ctx.actor.id,
      name: ctx.actor.name,
      email: ctx.actor.email,
      role: ctx.actor.role,
    },
    request: ctx.request ?? null,
    payload: {
      paymentIntentId,
      amountAuthorized: authorized,
      amountCaptured: capturedMajor,
      partial: capturedMajor < authorized,
      currency: doc.pricing.currency,
      capturedAt: capturedAt.toISOString(),
      bookingStatus: BookingStatus.CONFIRMED,
      gatewayStatus: result.status,
    },
    refs: {
      paymentIntentId,
      transactionId: paymentIntentId,
      customerEmail: doc.customer.email,
    },
  });

  logger.info("order.lifecycle.transition", {
    orderId: String(doc._id),
    orderNumber: doc.orderNumber,
    previousState: PaymentCaptureStatus.AUTHORIZED,
    nextState: PaymentCaptureStatus.CAPTURED,
    transition: "captured",
    source: "service.payment_capture.capture",
    actor: ctx.actor.id,
  });

  return getOrderById(id, ctx);
}

/**
 * Release an authorized hold without charging.
 *
 * Used when the booking cannot be fulfilled. The customer's held funds are
 * freed rather than charged-then-refunded, which is both faster for them
 * and avoids the merchant paying processing fees on money it never keeps.
 */
export async function cancelAuthorization(
  id: string,
  ctx: OrderContext,
  options: CancelOptions = {},
): Promise<OrderDTO> {
  const { doc, paymentIntentId } = await loadCapturableOrder(
    id,
    ctx,
    Permission.ORDER_VOID_AUTHORIZATION,
  );

  const captureStatus = doc.payment.capture?.status;
  if (
    captureStatus === PaymentCaptureStatus.CANCELLED ||
    captureStatus === PaymentCaptureStatus.AUTHORIZATION_EXPIRED
  ) {
    return getOrderById(id, ctx);
  }
  if (captureStatus === PaymentCaptureStatus.CAPTURED) {
    throw new ConflictError(
      "This payment has already been captured. Issue a refund instead of releasing the authorization.",
    );
  }
  if (
    captureStatus !== PaymentCaptureStatus.AUTHORIZED &&
    captureStatus !== PaymentCaptureStatus.CAPTURE_FAILED &&
    captureStatus !== PaymentCaptureStatus.PENDING_AUTHORIZATION
  ) {
    throw new ConflictError(
      `Cannot release — the payment is ${String(captureStatus ?? "not authorized").toLowerCase()}.`,
    );
  }
  if (doc.status === OrderStatus.PAID) {
    throw new ConflictError(
      "This order is already paid. Issue a refund instead of releasing the authorization.",
    );
  }

  const gateway = await manualCaptureGatewayFor(doc);

  let result;
  try {
    result = await gateway.cancelPayment(paymentIntentId, {
      reason: "abandoned",
      idempotencyKey: `order:${String(doc._id)}:cancel`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("payments.cancel_authorization_failed", {
      orderId: String(doc._id),
      err: message,
    });
    throw new PaymentError("Could not release this authorization", err);
  }

  const cancelledAt = new Date();
  const reason = options.reason?.trim() || null;

  const updated = await Order.findOneAndUpdate(
    {
      _id: doc._id,
      "payment.capture.status": {
        $in: [
          PaymentCaptureStatus.PENDING_AUTHORIZATION,
          PaymentCaptureStatus.AUTHORIZED,
          PaymentCaptureStatus.CAPTURE_PENDING,
          PaymentCaptureStatus.CAPTURE_FAILED,
        ],
      },
    },
    {
      $set: {
        "payment.capture.status": PaymentCaptureStatus.CANCELLED,
        "payment.capture.cancelledAt": cancelledAt,
        "payment.capture.cancelReason": reason,
        // Booking is cancelled. `status` / `payment.status` are left
        // alone — a released hold is not a FAILED payment, and marking it
        // so would put the order into a terminal state that blocks the
        // operator from ever re-issuing a link.
        bookingStatus: BookingStatus.CANCELLED,
      },
    },
    { returnDocument: "after" },
  ).lean<OrderDoc & { _id: Types.ObjectId }>();

  if (updated) {
    await recordAudit({
      action: AuditAction.AUTHORIZATION_RELEASED,
      entityType: AuditEntity.PAYMENT,
      entityId: String(doc._id),
      organizationId: doc.organizationId ?? null,
      actor: {
        userId: ctx.actor.id,
        name: ctx.actor.name,
        role: ctx.actor.role,
      },
      request: ctx.request ?? null,
      metadata: {
        orderNumber: doc.orderNumber,
        paymentIntentId,
        amountReleased: doc.payment.capture?.amountAuthorized ?? null,
        currency: doc.pricing.currency,
        reason,
        gatewayStatus: result.status,
        releasedBy: "operator",
      },
    });

    await captureEvidenceSafe({
      orderId: String(doc._id),
      orderNumber: doc.orderNumber,
      eventType: OrderEvidenceEventType.AUTHORIZATION_RELEASED,
      occurredAt: cancelledAt,
      actor: {
        type: OrderEvidenceActorType.AGENT,
        userId: ctx.actor.id,
        name: ctx.actor.name,
        email: ctx.actor.email,
        role: ctx.actor.role,
      },
      request: ctx.request ?? null,
      payload: {
        paymentIntentId,
        amountReleased: doc.payment.capture?.amountAuthorized ?? null,
        currency: doc.pricing.currency,
        reason,
        bookingStatus: BookingStatus.CANCELLED,
        gatewayStatus: result.status,
        note: "The hold was released. The customer was never charged.",
      },
      refs: {
        paymentIntentId,
        transactionId: paymentIntentId,
        customerEmail: doc.customer.email,
      },
    });

    logger.info("order.lifecycle.transition", {
      orderId: String(doc._id),
      orderNumber: doc.orderNumber,
      previousState: captureStatus,
      nextState: PaymentCaptureStatus.CANCELLED,
      transition: "authorization_released",
      source: "service.payment_capture.cancel",
      actor: ctx.actor.id,
    });
  }

  return getOrderById(id, ctx);
}
