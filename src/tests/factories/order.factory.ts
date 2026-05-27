import { Types } from "mongoose";

import {
  ConsentStatus,
  Currency,
  OrderStatus,
  RecordState,
} from "@/lib/constants/enums";
import { SchedulingType } from "@/lib/constants/items";
import { Order, type OrderDoc, type OrderDocument } from "@/server/db/models";

/**
 * Order factory. `buildOrder()` returns a pure object suitable for unit
 * tests; `createOrder()` persists it. The shape mirrors `OrderDoc` so
 * callers can override any nested field with a partial.
 *
 * Pass 5h: rental-specific fields (bookingType, provider, vehicle, trip)
 * are gone. Every fixture now produces a universal-shape order with one
 * `service_visit` line item + a fixed scheduling window. Tests for
 * other verticals override `lineItems` / `scheduling` as needed.
 */

interface CreatorSeed {
  userId?: Types.ObjectId | string;
  name?: string;
  email?: string;
}

export interface OrderSeed extends Partial<Omit<OrderDoc, "createdBy">> {
  createdBy?: CreatorSeed;
}

let counter = 0;
function nextSuffix(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

export function buildOrder(seed: OrderSeed = {}): OrderDoc & { _id: Types.ObjectId } {
  const suffix = nextSuffix();
  const now = new Date();
  const startsAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const endsAt = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  return {
    _id: new Types.ObjectId(),
    orderNumber: seed.orderNumber ?? `TST-${suffix.toUpperCase()}`.slice(0, 32),
    status: seed.status ?? OrderStatus.PAYMENT_PENDING,
    state: seed.state ?? RecordState.ACTIVE,
    customer: {
      name: seed.customer?.name ?? "Test Customer",
      email: (seed.customer?.email ?? "customer@payops.test").toLowerCase(),
      phone: seed.customer?.phone ?? "+15555550100",
    },
    lineItems: seed.lineItems ?? [
      {
        itemId: null,
        itemTypeKey: "service_visit",
        name: "Test service visit",
        description: null,
        quantity: 1,
        unitPrice: 199.5,
        total: 199.5,
        attributes: {},
        scheduling: null,
      },
    ],
    scheduling: seed.scheduling ?? {
      type: SchedulingType.FIXED_WINDOW,
      startsAt,
      endsAt,
    },
    pricing: {
      amount: seed.pricing?.amount ?? 199.5,
      currency: (seed.pricing?.currency ?? Currency.USD) as Currency,
    },
    payment: {
      stripeSessionId: seed.payment?.stripeSessionId ?? null,
      paymentIntentId: seed.payment?.paymentIntentId ?? null,
      checkoutUrl: seed.payment?.checkoutUrl ?? null,
      status: seed.payment?.status ?? (seed.status ?? OrderStatus.PAYMENT_PENDING),
      paidAt: seed.payment?.paidAt ?? null,
      expiresAt:
        seed.payment?.expiresAt ?? new Date(now.getTime() + 24 * 60 * 60 * 1000),
      amountReceived: seed.payment?.amountReceived ?? null,
      receiptUrl: seed.payment?.receiptUrl ?? null,
      failureReason: seed.payment?.failureReason ?? null,
      confirmationEmailSentAt: seed.payment?.confirmationEmailSentAt ?? null,
      processedWebhookEventIds: seed.payment?.processedWebhookEventIds ?? [],
    },
    createdBy: {
      userId:
        toObjectId(seed.createdBy?.userId) ?? new Types.ObjectId(),
      name: seed.createdBy?.name ?? "Test Creator",
      email: (seed.createdBy?.email ?? "creator@payops.test").toLowerCase(),
    },
    policy: {
      acceptedAt: seed.policy?.acceptedAt ?? now,
      version: seed.policy?.version ?? "v1",
      text: seed.policy?.text ?? "Standard test policy snapshot.",
    },
    risk: {
      flagged: seed.risk?.flagged ?? false,
      flaggedNote: seed.risk?.flaggedNote ?? null,
      flaggedAt: seed.risk?.flaggedAt ?? null,
      flaggedBy: seed.risk?.flaggedBy ?? null,
    },
    consent: {
      status: seed.consent?.status ?? ConsentStatus.NOT_REQUESTED,
      currentConsentId: seed.consent?.currentConsentId ?? null,
      requestedAt: seed.consent?.requestedAt ?? null,
      receivedAt: seed.consent?.receivedAt ?? null,
      verifiedAt: seed.consent?.verifiedAt ?? null,
      method: seed.consent?.method ?? null,
    },
    notes: seed.notes ?? null,
    createdAt: seed.createdAt ?? now,
    updatedAt: seed.updatedAt ?? now,
  };
}

function toObjectId(
  value: Types.ObjectId | string | undefined,
): Types.ObjectId | null {
  if (!value) return null;
  if (value instanceof Types.ObjectId) return value;
  if (typeof value === "string" && Types.ObjectId.isValid(value)) {
    return new Types.ObjectId(value);
  }
  return null;
}

export async function createOrder(seed: OrderSeed = {}): Promise<OrderDocument> {
  const data = buildOrder(seed);
  return (await Order.create({
    _id: data._id,
    orderNumber: data.orderNumber,
    status: data.status,
    state: data.state,
    customer: data.customer,
    lineItems: data.lineItems,
    scheduling: data.scheduling,
    pricing: data.pricing,
    payment: data.payment,
    createdBy: data.createdBy,
    policy: data.policy,
    risk: data.risk,
    consent: data.consent,
    notes: data.notes,
  })) as OrderDocument;
}

export async function createPaidOrder(seed: OrderSeed = {}): Promise<OrderDocument> {
  const now = new Date();
  return createOrder({
    status: OrderStatus.PAID,
    payment: {
      status: OrderStatus.PAID,
      paidAt: now,
      amountReceived: seed.pricing?.amount ?? 199.5,
      stripeSessionId: `cs_test_paid_${Date.now()}`,
      paymentIntentId: `pi_test_paid_${Date.now()}`,
      processedWebhookEventIds: [],
      ...(seed.payment ?? {}),
    },
    ...seed,
  });
}
