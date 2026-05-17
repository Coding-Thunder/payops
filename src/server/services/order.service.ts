import "server-only";

import { Types } from "mongoose";
import type Stripe from "stripe";

import {
  AuditAction,
  AuditEntity,
  BookingType,
  OrderStatus,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PaymentError,
  ValidationError,
} from "@/lib/errors";
import { roleHasPermission, Permission } from "@/lib/constants/permissions";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { Order, type OrderDoc } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import type {
  ArchiveOrderInput,
  CreateOrderInput,
  ListOrdersQuery,
} from "@/lib/validation";
import type { OrderDTO, PaginatedResult } from "@/types";

import type { RequestContext } from "@/server/api/request-context";
import { getStripe } from "@/server/payments/stripe";
import { recordAudit } from "./audit.service";
import { getSettings } from "./settings.service";
import { generateOrderNumber } from "./order-number";

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

interface OrderActor {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

interface OrderContext {
  actor: OrderActor;
  request?: RequestContext | null;
}

export function toMinorUnits(amount: number, currency: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase())) {
    return Math.round(amount);
  }
  return Math.round(amount * 100);
}

function orderToDTO(doc: OrderDoc & { _id: Types.ObjectId | string }): OrderDTO {
  return {
    id: String(doc._id),
    orderNumber: doc.orderNumber,
    bookingType: doc.bookingType as BookingType,
    status: doc.status as OrderStatus,
    state: doc.state as RecordState,
    customer: { ...doc.customer },
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
      status: doc.payment.status as OrderStatus,
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
    notes: doc.notes ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

interface CreateOrderResult {
  order: OrderDTO;
  checkoutUrl: string;
}

export async function createOrder(
  input: CreateOrderInput,
  ctx: OrderContext,
): Promise<CreateOrderResult> {
  await connectMongo();
  const settings = await getSettings();

  if (!settings.allowedBookingTypes.includes(input.bookingType)) {
    throw new ValidationError(
      "This booking type is currently disabled. Update operational settings to enable it.",
    );
  }

  const currency = input.pricing.currency ?? settings.defaultCurrency;
  const expiresAt = new Date(
    Date.now() + settings.paymentExpiryHours * 60 * 60 * 1000,
  );

  const orderId = new Types.ObjectId();
  const orderNumber = generateOrderNumber(settings.orderPrefix);

  const created = await Order.create({
    _id: orderId,
    orderNumber,
    bookingType: input.bookingType,
    status: OrderStatus.PAYMENT_PENDING,
    state: RecordState.ACTIVE,
    customer: input.customer,
    vehicle: input.vehicle,
    trip: {
      pickupDate: new Date(input.trip.pickupDate),
      dropoffDate: new Date(input.trip.dropoffDate),
    },
    pricing: { amount: input.pricing.amount, currency },
    payment: {
      status: OrderStatus.PAYMENT_PENDING,
      expiresAt,
      processedWebhookEventIds: [],
    },
    createdBy: {
      userId: new Types.ObjectId(ctx.actor.id),
      name: ctx.actor.name,
      email: ctx.actor.email,
    },
    notes: input.notes ?? null,
  });

  let session: Stripe.Checkout.Session;
  try {
    session = await buildCheckoutSession({
      orderId: String(created._id),
      orderNumber,
      input,
      currency,
      successUrl: settings.successRedirectUrl,
      cancelUrl: settings.cancelRedirectUrl,
      expiresAt,
      actor: ctx.actor,
    });
  } catch (err) {
    await Order.updateOne(
      { _id: created._id },
      {
        $set: {
          status: OrderStatus.FAILED,
          "payment.status": OrderStatus.FAILED,
          "payment.failureReason":
            err instanceof Error ? err.message : "Stripe error",
        },
      },
    );
    logger.error("orders.stripe_session_failed", {
      orderId: String(created._id),
      err: err instanceof Error ? err.message : String(err),
    });
    throw new PaymentError(
      "Could not create the Stripe checkout session for this order",
      err,
    );
  }

  if (!session.url) {
    await Order.updateOne(
      { _id: created._id },
      {
        $set: {
          status: OrderStatus.FAILED,
          "payment.status": OrderStatus.FAILED,
          "payment.failureReason": "Stripe did not return a checkout URL",
        },
      },
    );
    throw new PaymentError("Stripe did not return a checkout URL");
  }

  const updated = await Order.findOneAndUpdate(
    { _id: created._id },
    {
      $set: {
        "payment.stripeSessionId": session.id,
        "payment.checkoutUrl": session.url,
        "payment.expiresAt": new Date(
          (session.expires_at ?? Math.floor(expiresAt.getTime() / 1000)) * 1000,
        ),
        "payment.paymentIntentId":
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : null,
      },
    },
    { new: true },
  ).lean<OrderDoc & { _id: Types.ObjectId }>();

  if (!updated) throw new NotFoundError("Order vanished during creation");

  await recordAudit({
    action: AuditAction.ORDER_CREATED,
    entityType: AuditEntity.ORDER,
    entityId: String(updated._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: {
      orderNumber: updated.orderNumber,
      amount: updated.pricing.amount,
      currency: updated.pricing.currency,
      bookingType: updated.bookingType,
      stripeSessionId: session.id,
    },
  });

  return {
    order: orderToDTO(updated),
    checkoutUrl: session.url,
  };
}

interface BuildSessionInput {
  orderId: string;
  orderNumber: string;
  input: CreateOrderInput;
  currency: string;
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
  actor: OrderActor;
}

async function buildCheckoutSession(args: BuildSessionInput) {
  const stripe = getStripe();
  const amountMinor = toMinorUnits(args.input.pricing.amount, args.currency);
  if (amountMinor < 50) {
    throw new ValidationError("Amount is below Stripe's minimum charge");
  }

  const productName = describeProductName(args.input);
  const description = describeProductDescription(args.input);

  return stripe.checkout.sessions.create(
    {
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: args.input.customer.email,
      client_reference_id: args.orderId,
      success_url: `${args.successUrl}?order=${encodeURIComponent(args.orderNumber)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${args.cancelUrl}?order=${encodeURIComponent(args.orderNumber)}`,
      expires_at: clampStripeExpiry(args.expiresAt),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: args.currency.toLowerCase(),
            unit_amount: amountMinor,
            product_data: {
              name: productName,
              description,
            },
          },
        },
      ],
      metadata: {
        orderId: args.orderId,
        orderNumber: args.orderNumber,
        bookingType: args.input.bookingType,
        actorId: args.actor.id,
        actorEmail: args.actor.email,
        appName: env.server.APP_NAME,
      },
      payment_intent_data: {
        description: `${env.server.APP_NAME} • ${args.orderNumber}`,
        metadata: {
          orderId: args.orderId,
          orderNumber: args.orderNumber,
        },
      },
    },
    {
      idempotencyKey: `order:${args.orderId}:checkout`,
    },
  );
}

/**
 * Stripe's checkout session expiry must be between 30 minutes and 24 hours
 * from now. Clamp accordingly.
 */
function clampStripeExpiry(date: Date): number {
  const now = Date.now();
  const min = now + 31 * 60 * 1000;
  const max = now + 23 * 60 * 60 * 1000 + 30 * 60 * 1000;
  const target = date.getTime();
  const clamped = Math.min(Math.max(target, min), max);
  return Math.floor(clamped / 1000);
}

function describeProductName(input: CreateOrderInput): string {
  switch (input.bookingType) {
    case BookingType.NEW_BOOKING:
      return `${input.vehicle.company} ${input.vehicle.type} rental`;
    case BookingType.MODIFICATION:
      return `Booking modification • ${input.vehicle.company} ${input.vehicle.type}`;
    case BookingType.CANCELLATION_CHARGE:
      return `Cancellation charge • ${input.vehicle.company} ${input.vehicle.type}`;
    default:
      return `${input.vehicle.company} ${input.vehicle.type}`;
  }
}

function describeProductDescription(input: CreateOrderInput): string {
  const pickup = new Date(input.trip.pickupDate).toISOString().slice(0, 10);
  const drop = new Date(input.trip.dropoffDate).toISOString().slice(0, 10);
  return `Pick-up: ${pickup} • Drop-off: ${drop}`;
}

// ---------- Listing / fetching ----------

export async function listOrders(
  query: ListOrdersQuery,
  ctx: OrderContext,
): Promise<PaginatedResult<OrderDTO>> {
  await connectMongo();
  const filter: Record<string, unknown> = {};
  filter.state = query.state ?? RecordState.ACTIVE;
  if (query.status) filter.status = query.status;
  if (query.bookingType) filter.bookingType = query.bookingType;

  // STAFF can only see their own orders unless explicitly granted ORDER_VIEW_ALL.
  const canSeeAll = roleHasPermission(ctx.actor.role, Permission.ORDER_VIEW_ALL);
  if (query.mine || !canSeeAll) {
    filter["createdBy.userId"] = new Types.ObjectId(ctx.actor.id);
  }
  if (query.q) {
    const q = query.q.trim();
    filter.$or = [
      { orderNumber: { $regex: q, $options: "i" } },
      { "customer.name": { $regex: q, $options: "i" } },
      { "customer.email": { $regex: q, $options: "i" } },
      { "customer.phone": { $regex: q, $options: "i" } },
      { "vehicle.company": { $regex: q, $options: "i" } },
      { "vehicle.type": { $regex: q, $options: "i" } },
    ];
  }
  if (query.from || query.to) {
    const range: Record<string, Date> = {};
    if (query.from) range.$gte = new Date(query.from);
    if (query.to) range.$lte = new Date(query.to);
    filter.createdAt = range;
  }

  const { page, pageSize } = query;
  const [items, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean<(OrderDoc & { _id: Types.ObjectId })[]>(),
    Order.countDocuments(filter),
  ]);
  return {
    items: items.map(orderToDTO),
    total,
    page,
    pageSize,
  };
}

export async function getOrderById(
  id: string,
  ctx: OrderContext,
): Promise<OrderDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Order not found");
  const doc = await Order.findById(id).lean<OrderDoc & { _id: Types.ObjectId }>();
  if (!doc) throw new NotFoundError("Order not found");

  const canSeeAll = roleHasPermission(ctx.actor.role, Permission.ORDER_VIEW_ALL);
  if (!canSeeAll && String(doc.createdBy.userId) !== ctx.actor.id) {
    throw new ForbiddenError("You can only view orders you created");
  }
  return orderToDTO(doc);
}

export async function getOrderByNumber(
  orderNumber: string,
): Promise<OrderDTO | null> {
  await connectMongo();
  const doc = await Order.findOne({ orderNumber }).lean<
    OrderDoc & { _id: Types.ObjectId }
  >();
  return doc ? orderToDTO(doc) : null;
}

export async function archiveOrder(
  id: string,
  input: ArchiveOrderInput,
  ctx: OrderContext,
): Promise<OrderDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Order not found");
  const doc = await Order.findById(id);
  if (!doc) throw new NotFoundError("Order not found");

  if (doc.state === RecordState.ARCHIVED) {
    throw new ConflictError("Order is already archived");
  }
  if (doc.status === OrderStatus.PAID) {
    throw new ConflictError("Paid orders cannot be archived");
  }

  doc.state = RecordState.ARCHIVED;
  if (doc.status === OrderStatus.PAYMENT_PENDING) {
    doc.status = OrderStatus.EXPIRED;
    doc.payment.status = OrderStatus.EXPIRED;
  }
  await doc.save();

  await recordAudit({
    action: AuditAction.ORDER_ARCHIVED,
    entityType: AuditEntity.ORDER,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { reason: input.reason ?? null },
  });

  return orderToDTO(doc.toObject() as OrderDoc & { _id: Types.ObjectId });
}

interface RegenerateLinkResult {
  order: OrderDTO;
  checkoutUrl: string;
}

export async function regeneratePaymentLink(
  id: string,
  ctx: OrderContext,
): Promise<RegenerateLinkResult> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Order not found");
  const doc = await Order.findById(id);
  if (!doc) throw new NotFoundError("Order not found");

  const canSeeAll = roleHasPermission(ctx.actor.role, Permission.ORDER_VIEW_ALL);
  if (!canSeeAll && String(doc.createdBy.userId) !== ctx.actor.id) {
    throw new ForbiddenError("You can only regenerate links for your own orders");
  }
  if (doc.status === OrderStatus.PAID) {
    throw new ConflictError("Order is already paid");
  }
  if (doc.state === RecordState.ARCHIVED) {
    throw new ConflictError("Cannot regenerate link on an archived order");
  }

  const settings = await getSettings();
  const stripe = getStripe();
  const expiresAt = new Date(
    Date.now() + settings.paymentExpiryHours * 60 * 60 * 1000,
  );

  // Expire previous session if still open
  if (doc.payment.stripeSessionId) {
    try {
      await stripe.checkout.sessions.expire(doc.payment.stripeSessionId);
    } catch (err) {
      logger.warn("orders.previous_session_expire_failed", {
        sessionId: doc.payment.stripeSessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let session: Stripe.Checkout.Session;
  try {
    session = await buildCheckoutSession({
      orderId: String(doc._id),
      orderNumber: doc.orderNumber,
      input: {
        bookingType: doc.bookingType,
        customer: doc.customer,
        vehicle: doc.vehicle,
        trip: {
          pickupDate: doc.trip.pickupDate.toISOString(),
          dropoffDate: doc.trip.dropoffDate.toISOString(),
        },
        pricing: {
          amount: doc.pricing.amount,
          currency: doc.pricing.currency,
        },
        notes: doc.notes ?? undefined,
      },
      currency: doc.pricing.currency,
      successUrl: settings.successRedirectUrl,
      cancelUrl: settings.cancelRedirectUrl,
      expiresAt,
      actor: ctx.actor,
    });
  } catch (err) {
    logger.error("orders.regenerate_failed", {
      orderId: String(doc._id),
      err: err instanceof Error ? err.message : String(err),
    });
    throw new PaymentError("Could not regenerate the payment link", err);
  }

  if (!session.url) {
    throw new PaymentError("Stripe did not return a checkout URL");
  }

  doc.payment.stripeSessionId = session.id;
  doc.payment.checkoutUrl = session.url;
  doc.payment.expiresAt = new Date(
    (session.expires_at ?? Math.floor(expiresAt.getTime() / 1000)) * 1000,
  );
  doc.payment.failureReason = null;
  doc.payment.paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : null;
  doc.status = OrderStatus.PAYMENT_PENDING;
  doc.payment.status = OrderStatus.PAYMENT_PENDING;
  await doc.save();

  await recordAudit({
    action: AuditAction.ORDER_PAYMENT_LINK_REGENERATED,
    entityType: AuditEntity.ORDER,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: { stripeSessionId: session.id },
  });

  return {
    order: orderToDTO(doc.toObject() as OrderDoc & { _id: Types.ObjectId }),
    checkoutUrl: session.url,
  };
}
