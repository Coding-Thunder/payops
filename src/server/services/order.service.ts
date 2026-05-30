import "server-only";

import { type ClientSession, Types } from "mongoose";

import { sessionOpt, withTx } from "@/server/db/transaction";

import {
  AuditAction,
  AuditEntity,
  ConsentMethod,
  ConsentStatus,
  OrderEvidenceActorType,
  OrderEvidenceEventType,
  OrderStatus,
  type PaymentGatewayKey,
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
import { DomainEventType } from "@/lib/constants/events";
import { logger } from "@/lib/logger";
import { publishEvent } from "@/server/events/bus";
import {
  Order,
  type OrderDoc,
  type OrderLineItem,
  type OrderScheduling,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import type {
  ArchiveOrderInput,
  CreateOrderUniversalInput,
  ListOrdersQuery,
} from "@/lib/validation";
import type { OrderDTO, PaginatedResult } from "@/types";

import type { RequestContext } from "@/server/api/request-context";
import type {
  CreatedPaymentSession,
  SessionStatus,
} from "@/server/payments/gateway";
import {
  getDefaultGateway,
  getGateway,
  getGatewayForOrg,
} from "@/server/payments/gateways";
import { recordAudit } from "./audit.service";
import { captureEvidenceSafe } from "./evidence.service";
import { getSettings } from "./settings.service";
import { generateOrderNumber } from "./order-number";
import { getBranding } from "./branding.service";
import { applyCheckoutPaid } from "./webhook.service";
import { validateLineAttributes } from "./attribute-validator.service";
import { upsertCustomerFromOrder } from "./customer.service";

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
  /** Active organization. Optional ONLY during the multi-tenant
   *  migration window — every route handler in Phase 3b passes it.
   *  When set, per-org settings/branding/gateway are resolved; when
   *  absent (legacy callers not yet migrated), the env-backed
   *  singletons are used. */
  orgId?: string | null;
  request?: RequestContext | null;
}

/**
 * Build a `findOne` filter that pins both `_id` AND `orgId` when
 * ctx.orgId is supplied. Pass 5a uses this on every lookup-by-id in
 * this service so an ADMIN of Tenant A can't read/edit/delete a
 * Tenant B order by guessing its id (the Phase-A audit risk #4.1).
 *
 * Legacy callers (no ctx.orgId) keep the unscoped `{_id}` filter so
 * pre-multi-tenant code paths stay back-compat.
 */
function scopedOrderFilter(
  id: string,
  orgId: string | null | undefined,
): Record<string, unknown> {
  if (orgId) {
    return { _id: id, orgId: new Types.ObjectId(orgId) };
  }
  return { _id: id };
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
    orgId: doc.orgId ? String(doc.orgId) : null,
    orderNumber: doc.orderNumber,
    status: doc.status as OrderStatus,
    state: doc.state as RecordState,
    customer: { ...doc.customer },
    pricing: { amount: doc.pricing.amount, currency: doc.pricing.currency },
    payment: {
      gateway: (doc.payment.gateway ?? null) as PaymentGatewayKey | null,
      // Schema fields keep their legacy names (Stripe-era); the DTO
      // re-exposes them under generic names so UI / email / external
      // callers never spell "Stripe" outside the gateway adapter.
      paymentSessionId: doc.payment.stripeSessionId ?? null,
      paymentIntentId: doc.payment.paymentIntentId ?? null,
      paymentUrl: doc.payment.checkoutUrl ?? null,
      status: doc.payment.status as OrderStatus,
      paidAt: doc.payment.paidAt ? doc.payment.paidAt.toISOString() : null,
      expiresAt: doc.payment.expiresAt
        ? doc.payment.expiresAt.toISOString()
        : null,
      amountReceived: doc.payment.amountReceived ?? null,
      receiptUrl: doc.payment.receiptUrl ?? null,
      failureReason: doc.payment.failureReason ?? null,
      confirmationEmailSentAt: doc.payment.confirmationEmailSentAt
        ? doc.payment.confirmationEmailSentAt.toISOString()
        : null,
      initiatedAt: doc.payment.initiatedAt
        ? doc.payment.initiatedAt.toISOString()
        : null,
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
    consent: {
      status: (doc.consent?.status ?? ConsentStatus.NOT_REQUESTED) as ConsentStatus,
      currentConsentId: doc.consent?.currentConsentId
        ? String(doc.consent.currentConsentId)
        : null,
      requestedAt: doc.consent?.requestedAt
        ? doc.consent.requestedAt.toISOString()
        : null,
      receivedAt: doc.consent?.receivedAt
        ? doc.consent.receivedAt.toISOString()
        : null,
      verifiedAt: doc.consent?.verifiedAt
        ? doc.consent.verifiedAt.toISOString()
        : null,
      method: (doc.consent?.method as ConsentMethod | null | undefined) ?? null,
    },
    dispute: doc.dispute
      ? {
          status: (doc.dispute.status ?? null) as
            | import("@/lib/constants/enums").DisputeStatus
            | null,
          currentDisputeId: doc.dispute.currentDisputeId
            ? String(doc.dispute.currentDisputeId)
            : null,
          openedAt: doc.dispute.openedAt
            ? doc.dispute.openedAt.toISOString()
            : null,
          closedAt: doc.dispute.closedAt
            ? doc.dispute.closedAt.toISOString()
            : null,
          outcome: (doc.dispute.outcome ?? null) as
            | import("@/lib/constants/enums").DisputeOutcome
            | null,
          reason: doc.dispute.reason ?? null,
          amount:
            typeof doc.dispute.amount === "number"
              ? doc.dispute.amount
              : null,
          currency: (doc.dispute.currency ?? null) as
            | import("@/lib/constants/enums").Currency
            | null,
        }
      : null,
    refundedAmount: doc.refundedAmount ?? 0,
    notes: doc.notes ?? null,
    // Pass 5d: universal commerce — line items snapshot. Empty array
    // on pre-Pass-5c legacy orders that haven't been backfilled yet.
    lineItems: (doc.lineItems ?? []).map((li) => ({
      itemId: li.itemId ? String(li.itemId) : null,
      itemTypeKey: li.itemTypeKey,
      name: li.name,
      description: li.description ?? null,
      quantity: li.quantity,
      unitPrice: li.unitPrice,
      total: li.total,
      attributes: li.attributes ?? {},
      scheduling: li.scheduling
        ? {
            type: li.scheduling.type,
            startsAt: li.scheduling.startsAt.toISOString(),
            endsAt: li.scheduling.endsAt
              ? li.scheduling.endsAt.toISOString()
              : null,
          }
        : null,
    })),
    scheduling: doc.scheduling
      ? {
          type: doc.scheduling.type,
          startsAt: doc.scheduling.startsAt.toISOString(),
          endsAt: doc.scheduling.endsAt
            ? doc.scheduling.endsAt.toISOString()
            : null,
        }
      : null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

interface CreateOrderResult {
  order: OrderDTO;
  /** Always null on creation now — Stripe is no longer contacted until
   *  the agent explicitly triggers payment initiation via the email
   *  composer. Kept on the result for caller compat. */
  checkoutUrl: string | null;
}

/**
 * Persist a business order. NO Stripe side-effects.
 *
 * Universal commerce shape: `lineItems[]` + optional `scheduling`. Every
 * line's `itemTypeKey` resolves against THIS org's ItemType catalog and
 * its `attributes` are validated against `attributeSchema`. Cross-tenant
 * ItemType reuse is REFUSED at the validator layer.
 *
 * The order starts in NOT_INITIATED state — checkoutUrl, sessionId,
 * paymentIntentId, expiresAt all remain null. The agent transitions
 * the order to PAYMENT_PENDING by calling `initiatePayment` from the
 * email composer (which also dispatches the request email and creates
 * the consent record in one atomic call).
 *
 * Separating creation from payment lets the agent:
 *   - draft / preview an order without burning a Stripe session
 *   - edit booking details before payment kicks off
 *   - keep Stripe rate-limit + idempotency surface tight
 */
export async function createOrder(
  input: CreateOrderUniversalInput,
  ctx: OrderContext,
): Promise<CreateOrderResult> {
  await connectMongo();
  // Read settings + policy snapshot from the caller's org so Tenant #2
  // doesn't inherit Tenant #1's cancellation policy text.
  const settings = await getSettings(ctx.orgId);

  const currency = input.pricing.currency ?? settings.defaultCurrency;
  const orderId = new Types.ObjectId();
  const orderNumber = generateOrderNumber(settings.orderPrefix);

  // Stamp the tenant boundary onto the order. This is the field every
  // downstream service (webhook lookup, evidence chain, gateway
  // routing) keys off, so we set it at creation and never mutate it.
  const orderOrgId = ctx.orgId ? new Types.ObjectId(ctx.orgId) : null;

  // Per-line attribute validation (resolves ItemType + scrubs unknown
  // keys + coerces types). Throws ValidationError on any mismatch.
  const validatedLines: OrderLineItem[] = [];
  let computedTotal = 0;
  for (let i = 0; i < input.lineItems.length; i += 1) {
    const line = input.lineItems[i];
    const { attributes } = await validateLineAttributes({
      orgId: ctx.orgId ?? null,
      itemTypeKey: line.itemTypeKey,
      attributes: line.attributes ?? {},
      context: `lineItems[${i}]`,
    });
    const lineTotal = line.total ?? line.quantity * line.unitPrice;
    computedTotal += lineTotal;
    validatedLines.push({
      itemId: line.itemId ? new Types.ObjectId(line.itemId) : null,
      itemTypeKey: line.itemTypeKey,
      name: line.name,
      description: line.description ?? null,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      total: lineTotal,
      attributes,
      scheduling: line.scheduling
        ? {
            type: line.scheduling.type,
            startsAt: new Date(line.scheduling.startsAt),
            endsAt: line.scheduling.endsAt
              ? new Date(line.scheduling.endsAt)
              : null,
          }
        : null,
    });
  }
  // Defend against client tampering: declared grand total must match
  // the sum of validated line totals within rounding tolerance.
  if (Math.abs(computedTotal - input.pricing.amount) > 0.01) {
    throw new ValidationError(
      `Order grand total ${input.pricing.amount} does not match the sum of line items (${computedTotal.toFixed(2)}).`,
    );
  }
  const schedulingToPersist: OrderScheduling | null = input.scheduling
    ? {
        type: input.scheduling.type,
        startsAt: new Date(input.scheduling.startsAt),
        endsAt: input.scheduling.endsAt
          ? new Date(input.scheduling.endsAt)
          : null,
      }
    : null;

  // Transactional: Order doc + audit row + genesis evidence row are
  // written together. A failure on evidence aborts the order create —
  // disputes never face a chain with a missing sequence 1.
  const created = await withTx(async (session) => {
    const inserted = await Order.create(
      [
        {
          _id: orderId,
          orgId: orderOrgId,
          orderNumber,
          status: OrderStatus.NOT_INITIATED,
          state: RecordState.ACTIVE,
          customer: input.customer,
          lineItems: validatedLines,
          scheduling: schedulingToPersist,
          pricing: { amount: input.pricing.amount, currency },
          payment: {
            status: OrderStatus.NOT_INITIATED,
            processedWebhookEventIds: [],
          },
          createdBy: {
            userId: new Types.ObjectId(ctx.actor.id),
            name: ctx.actor.name,
            email: ctx.actor.email,
          },
          policy: {
            acceptedAt: new Date(),
            version: settings.cancellationPolicyVersion,
            text: settings.cancellationPolicy,
          },
          risk: { flagged: false },
          consent: { status: ConsentStatus.NOT_REQUESTED },
          notes: input.notes ?? null,
        },
      ],
      sessionOpt(session),
    );
    const orderDoc = inserted[0];

    await recordAudit(
      {
        action: AuditAction.ORDER_CREATED,
        entityType: AuditEntity.ORDER,
        entityId: String(orderDoc._id),
        orgId: ctx.orgId ?? null,
        actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
        request: ctx.request ?? null,
        metadata: {
          orderNumber: orderDoc.orderNumber,
          amount: orderDoc.pricing.amount,
          currency: orderDoc.pricing.currency,
          itemTypeKeys: orderDoc.lineItems?.map((l) => l.itemTypeKey) ?? [],
        },
      },
      session,
    );

    await captureEvidenceSafe(
      {
        orderId: String(orderDoc._id),
        orderNumber: orderDoc.orderNumber,
        eventType: OrderEvidenceEventType.ORDER_CREATED,
        occurredAt: orderDoc.createdAt,
        actor: {
          type: OrderEvidenceActorType.AGENT,
          userId: ctx.actor.id,
          name: ctx.actor.name,
          email: ctx.actor.email,
          role: ctx.actor.role,
        },
        request: ctx.request ?? null,
        payload: {
          orderNumber: orderDoc.orderNumber,
          customer: {
            name: orderDoc.customer.name,
            email: orderDoc.customer.email,
            phone: orderDoc.customer.phone,
          },
          lineItems: (orderDoc.lineItems ?? []).map((li) => ({
            itemTypeKey: li.itemTypeKey,
            name: li.name,
            description: li.description ?? null,
            quantity: li.quantity,
            unitPrice: li.unitPrice,
            total: li.total,
            attributes: li.attributes ?? {},
          })),
          scheduling: orderDoc.scheduling
            ? {
                type: orderDoc.scheduling.type,
                startsAt: orderDoc.scheduling.startsAt.toISOString(),
                endsAt: orderDoc.scheduling.endsAt
                  ? orderDoc.scheduling.endsAt.toISOString()
                  : null,
              }
            : null,
          pricing: {
            amount: orderDoc.pricing.amount,
            currency: orderDoc.pricing.currency,
          },
          policy: {
            acceptedAt: orderDoc.policy.acceptedAt.toISOString(),
            version: orderDoc.policy.version,
            text: orderDoc.policy.text,
          },
          createdBy: {
            userId: String(orderDoc.createdBy.userId),
            name: orderDoc.createdBy.name,
            email: orderDoc.createdBy.email,
          },
          notes: orderDoc.notes ?? null,
        },
        refs: {
          customerEmail: orderDoc.customer.email,
        },
      },
      session,
    );

    return orderDoc;
  });

  // After commit: in-memory event bus. Lives outside the tx because
  // event delivery is best-effort and a tx abort shouldn't have to roll
  // back an in-memory queue entry.
  publishEvent({
    type: DomainEventType.ORDER_CREATED,
    audience: { kind: "creator", userId: ctx.actor.id },
    actor: { id: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    orgId: ctx.orgId ?? null,
    payload: {
      orderId: String(created._id),
      orderNumber: created.orderNumber,
      amount: created.pricing.amount,
      currency: created.pricing.currency,
      customerName: created.customer.name,
    },
  });

  // Saved customer record (Pass 6d). Best-effort — never blocks the
  // order. A failed upsert just means the operator re-types next time.
  if (ctx.orgId) {
    try {
      await upsertCustomerFromOrder(
        ctx.orgId,
        {
          name: created.customer.name,
          email: created.customer.email,
          phone: created.customer.phone,
        },
        { countAsOrder: true },
      );
    } catch (err) {
      logger.warn("customer.upsert_failed", {
        orderId: String(created._id),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    order: orderToDTO(
      created.toObject({ getters: false }) as OrderDoc & { _id: Types.ObjectId },
    ),
    checkoutUrl: null,
  };
}

interface InitiatePaymentResult {
  order: OrderDTO;
  checkoutUrl: string;
  alreadyInitiated: boolean;
}

/**
 * Transition an order from NOT_INITIATED → LINK_GENERATED by creating
 * a gateway-hosted payment session.
 *
 * Gateway-agnostic: routes through the `PaymentGateway` interface so the
 * call site doesn't know Stripe from Razorpay from PayPal. The
 * implementation is chosen at runtime from the order's `payment.gateway`
 * (or `getDefaultGateway()` on the first call).
 *
 * Idempotent on the gateway side (the session id is recorded; a second
 * call returns the existing one). Refuses to initiate when:
 *   - order is already PAID / FAILED / EXPIRED (terminal)
 *   - order is ARCHIVED (lifecycle violation)
 *   - selected gateway is not enabled (no creds configured)
 *
 * Side-effects:
 *   - gateway session created
 *   - payment.{gateway, stripeSessionId, checkoutUrl, expiresAt,
 *     paymentIntentId, initiatedAt} persisted atomically
 *   - status flipped to LINK_GENERATED
 *   - audit row written
 */
export interface InitiatePaymentOptions {
  /** Which gateway to route this payment through. Defaults to the
   *  registry's default (Stripe today). The agent picks this from the
   *  composer's gateway dropdown; once set on the order it sticks. */
  gateway?: PaymentGatewayKey;
}

export async function initiatePayment(
  id: string,
  ctx: OrderContext,
  options: InitiatePaymentOptions = {},
): Promise<InitiatePaymentResult> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Order not found");
  const doc = await Order.findOne(scopedOrderFilter(id, ctx.orgId));
  if (!doc) throw new NotFoundError("Order not found");

  const canSeeAll = roleHasPermission(ctx.actor.role, Permission.ORDER_VIEW_ALL);
  if (!canSeeAll && String(doc.createdBy.userId) !== ctx.actor.id) {
    throw new ForbiddenError(
      "You can only initiate payment on orders you created",
    );
  }
  if (doc.state === RecordState.ARCHIVED) {
    throw new ConflictError("Cannot initiate payment on an archived order");
  }
  if (
    doc.status === OrderStatus.PAID ||
    doc.status === OrderStatus.FAILED ||
    doc.status === OrderStatus.EXPIRED
  ) {
    throw new ConflictError(
      `Cannot initiate payment — order is ${doc.status.toLowerCase()}`,
    );
  }

  // Idempotent: if a session is already created, return what we have.
  // Re-clicks from the composer hit this path; they should NOT create a
  // second gateway session — that would orphan the first one.
  if (
    (doc.status === OrderStatus.LINK_GENERATED ||
      doc.status === OrderStatus.PAYMENT_PENDING) &&
    doc.payment.stripeSessionId &&
    doc.payment.checkoutUrl
  ) {
    return {
      order: orderToDTO(
        doc.toObject({ getters: false }) as OrderDoc & { _id: Types.ObjectId },
      ),
      checkoutUrl: doc.payment.checkoutUrl,
      alreadyInitiated: true,
    };
  }

  // Resolve gateway: explicit option > existing pinned > registry default.
  const gatewayKey: PaymentGatewayKey =
    options.gateway ??
    (doc.payment.gateway as PaymentGatewayKey | null) ??
    getDefaultGateway().key;
  // Prefer the order's own orgId over ctx.orgId — they should match for
  // any new order, but using the persisted value defends against a
  // stale ctx caused by an org-switcher race. Falls back to ctx.orgId
  // for legacy orders persisted before Phase 0+1 backfill ran.
  const orderOrgId = doc.orgId ? String(doc.orgId) : (ctx.orgId ?? null);
  // Per-org gateway: reads credentials from `gateway_credentials` (per
  // tenant) OR falls back to env (Tenant #1 path). The legacy registry
  // `getGateway(key)` is no longer used here so Tenant #2's session
  // never resolves to Tenant #1's Stripe account.
  const gateway = await getGatewayForOrg(orderOrgId, gatewayKey);
  if (!gateway) {
    throw new ConflictError(
      `${gatewayKey} is not configured for this organization. Configure credentials in admin settings or pick another gateway.`,
    );
  }
  if (!gateway.enabled) {
    throw new ConflictError(
      `${gateway.label} is not available. Configure credentials in admin settings or pick another gateway.`,
    );
  }

  const settings = await getSettings(orderOrgId);
  const expiresAt = new Date(
    Date.now() + settings.paymentExpiryHours * 60 * 60 * 1000,
  );
  const branding = await getBranding(orderOrgId);
  const gatewayProduct = describeProductForGateway(doc);

  let session: CreatedPaymentSession;
  try {
    session = await gateway.createSession({
      orderId: String(doc._id),
      orderNumber: doc.orderNumber,
      amount: doc.pricing.amount,
      currency: doc.pricing.currency,
      customer: doc.customer,
      productName: gatewayProduct.name,
      description: gatewayProduct.description ?? "",
      imageUrls: gatewayProduct.imageUrls,
      successUrl: settings.successRedirectUrl,
      cancelUrl: settings.cancelRedirectUrl,
      expiresAt,
      metadata: {
        orderId: String(doc._id),
        orderNumber: doc.orderNumber,
        actorId: ctx.actor.id,
        actorEmail: ctx.actor.email,
        appName: branding.brandName,
      },
    });
  } catch (err) {
    logger.error("orders.initiate_payment_failed", {
      orderId: String(doc._id),
      gateway: gatewayKey,
      err: err instanceof Error ? err.message : String(err),
    });
    throw new PaymentError(
      `Could not create the ${gateway.label} payment session for this order`,
      err,
    );
  }

  const initiatedAt = new Date();

  // Transactional DB writes: Order flip + audit + 2× evidence (gateway
  // selected + link generated). Stripe API call already happened above
  // — its session id is the source of truth even if the tx aborts; the
  // orphan-expire compensation lives in the !updated branch below.
  type TxOut =
    | { kind: "applied"; updated: OrderDoc & { _id: Types.ObjectId } }
    | { kind: "raced" };

  const result: TxOut = await withTx(async (txSession) => {
    const updated = await Order.findOneAndUpdate(
      { _id: doc._id, status: OrderStatus.NOT_INITIATED },
      {
        $set: {
          status: OrderStatus.LINK_GENERATED,
          "payment.status": OrderStatus.LINK_GENERATED,
          "payment.gateway": gatewayKey,
          "payment.stripeSessionId": session.sessionId,
          "payment.checkoutUrl": session.url,
          "payment.expiresAt": session.expiresAt,
          "payment.paymentIntentId": session.paymentIntentId,
          "payment.initiatedAt": initiatedAt,
        },
      },
      { ...sessionOpt(txSession), returnDocument: "after" },
    ).lean<OrderDoc & { _id: Types.ObjectId }>();

    if (!updated) {
      return { kind: "raced" } as TxOut;
    }

    await recordAudit(
      {
        action: AuditAction.ORDER_PAYMENT_LINK_REGENERATED,
        entityType: AuditEntity.ORDER,
        entityId: String(updated._id),
        orgId: orderOrgId,
        actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
        request: ctx.request ?? null,
        metadata: {
          orderNumber: updated.orderNumber,
          gateway: gatewayKey,
          paymentSessionId: session.sessionId,
          note: "initial_payment_initiation",
        },
      },
      txSession,
    );

    const evidenceActor = {
      type: OrderEvidenceActorType.AGENT,
      userId: ctx.actor.id,
      name: ctx.actor.name,
      email: ctx.actor.email,
      role: ctx.actor.role,
    };
    await captureEvidenceSafe(
      {
        orderId: String(updated._id),
        orderNumber: updated.orderNumber,
        eventType: OrderEvidenceEventType.GATEWAY_SELECTED,
        actor: evidenceActor,
        request: ctx.request ?? null,
        payload: {
          gateway: gatewayKey,
          gatewayLabel: gateway.label,
          orderNumber: updated.orderNumber,
        },
      },
      txSession,
    );
    await captureEvidenceSafe(
      {
        orderId: String(updated._id),
        orderNumber: updated.orderNumber,
        eventType: OrderEvidenceEventType.PAYMENT_LINK_GENERATED,
        occurredAt: initiatedAt,
        actor: evidenceActor,
        request: ctx.request ?? null,
        payload: {
          gateway: gatewayKey,
          paymentSessionId: session.sessionId,
          paymentIntentId: session.paymentIntentId,
          checkoutUrl: session.url,
          amount: updated.pricing.amount,
          currency: updated.pricing.currency,
          expiresAt: session.expiresAt.toISOString(),
          productName: gatewayProduct.name,
          description: gatewayProduct.description,
        },
        refs: {
          paymentSessionId: session.sessionId,
          paymentIntentId: session.paymentIntentId,
          customerEmail: updated.customer.email,
        },
      },
      txSession,
    );

    return { kind: "applied", updated } as TxOut;
  });

  if (result.kind === "raced") {
    // Another concurrent call flipped us out of NOT_INITIATED. Bin the
    // brand-new orphan gateway session and return the existing state.
    void gateway.expireSession(session.sessionId);
    const racedDoc = await Order.findOne(
      scopedOrderFilter(id, ctx.orgId),
    ).lean<OrderDoc & { _id: Types.ObjectId }>();
    if (!racedDoc?.payment.checkoutUrl) {
      throw new ConflictError("Payment initiation collided — try again");
    }
    return {
      order: orderToDTO(racedDoc),
      checkoutUrl: racedDoc.payment.checkoutUrl,
      alreadyInitiated: true,
    };
  }
  const updated = result.updated;

  logger.info("order.lifecycle.transition", {
    orderId: String(updated._id),
    orderNumber: updated.orderNumber,
    previousState: OrderStatus.NOT_INITIATED,
    nextState: OrderStatus.LINK_GENERATED,
    transition: "link_generated",
    source: "service.order.initiate_payment",
    actor: ctx.actor.id,
  });
  publishEvent({
    type: DomainEventType.ORDER_LINK_REGENERATED,
    audience: { kind: "creator", userId: String(updated.createdBy.userId) },
    actor: { id: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    // Prefer the persisted order.orgId — it's the authoritative
    // tenant key (set at creation, never mutated). Falls back to
    // ctx.orgId for orders pre-dating the Phase 0+1 backfill.
    orgId: updated.orgId ? String(updated.orgId) : (ctx.orgId ?? null),
    payload: {
      orderId: String(updated._id),
      orderNumber: updated.orderNumber,
      customerName: updated.customer.name,
      gateway: gatewayKey,
    },
  });

  return {
    order: orderToDTO(updated),
    checkoutUrl: session.url,
    alreadyInitiated: false,
  };
}

// `buildCheckoutSession` + `clampStripeExpiry` removed in Phase 3b:
// `regeneratePaymentLink` now goes through the gateway interface, which
// owns the Stripe-specific session-build + expiry clamping in
// `gateways/stripe.ts`. Keeping a parallel helper here would be a
// permanent Stripe back door for per-org routing to leak through.

/**
 * Derive gateway-facing product copy from the order's line items +
 * optional scheduling window. Single-line orders use the line name;
 * multi-line orders synthesize a "+ N more" summary. An attribute named
 * `image_url` on the first line (if present) is forwarded to the
 * gateway's product image slot.
 */
function describeProductForGateway(doc: OrderDoc): {
  name: string;
  description: string | null;
  imageUrls: string[] | undefined;
} {
  const line = doc.lineItems?.[0];
  if (!line) {
    throw new Error(
      `Order ${doc.orderNumber} has no lineItems; cannot describe for gateway`,
    );
  }
  const total = doc.lineItems?.length ?? 0;
  const name = total > 1 ? `${line.name} + ${total - 1} more` : line.name;
  let description: string | null = null;
  if (doc.scheduling) {
    const start = doc.scheduling.startsAt.toISOString().slice(0, 10);
    const end = doc.scheduling.endsAt
      ? doc.scheduling.endsAt.toISOString().slice(0, 10)
      : null;
    description = end ? `${start} → ${end}` : `Starts ${start}`;
  } else if (line.description) {
    description = line.description;
  }
  // Universal orders may carry an image_url in line attributes — surface
  // it if so.
  const imgAttr =
    (line.attributes?.image_url as string | null | undefined) ??
    (line.attributes?.vehicle_image_url as string | null | undefined) ??
    null;
  return {
    name,
    description,
    imageUrls: imgAttr ? [imgAttr] : undefined,
  };
}

// ---------- Listing / fetching ----------

export async function listOrders(
  query: ListOrdersQuery,
  ctx: OrderContext,
): Promise<PaginatedResult<OrderDTO>> {
  await connectMongo();
  const filter: Record<string, unknown> = {};
  // Tenant gate — pinned BEFORE every other clause so query
  // permutations can't strip it. The PRIMARY cross-tenant isolation
  // for the list view; the createdBy.userId check below was the
  // pre-Phase-5a guard but only fired for STAFF.
  if (ctx.orgId) {
    filter.orgId = new Types.ObjectId(ctx.orgId);
  }
  filter.state = query.state ?? RecordState.ACTIVE;
  if (query.status) filter.status = query.status;

  // STAFF can only see their own orders unless explicitly granted ORDER_VIEW_ALL.
  const canSeeAll = roleHasPermission(ctx.actor.role, Permission.ORDER_VIEW_ALL);
  if (query.mine || !canSeeAll) {
    filter["createdBy.userId"] = new Types.ObjectId(ctx.actor.id);
  }
  if (query.q) {
    // Cap input length and escape regex metacharacters so a STAFF user
    // can't trigger catastrophic backtracking on Mongo's regex engine
    // by submitting `(a+)+$` style payloads through the search box.
    const raw = query.q.trim().slice(0, 60);
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { orderNumber: { $regex: escaped, $options: "i" } },
      { "customer.name": { $regex: escaped, $options: "i" } },
      { "customer.email": { $regex: escaped, $options: "i" } },
      { "customer.phone": { $regex: escaped, $options: "i" } },
      { "vehicle.company": { $regex: escaped, $options: "i" } },
      { "vehicle.type": { $regex: escaped, $options: "i" } },
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
  const doc = await Order.findOne(
    scopedOrderFilter(id, ctx.orgId),
  ).lean<OrderDoc & { _id: Types.ObjectId }>();
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
  // Public lookup — no ctx.orgId because the caller is the
  // unauthenticated /pay/success render. Relies on the LEGACY global
  // unique on `orderNumber` (kept during the Phase 0+1 migration) so
  // orderNumber is still globally unique. Caller MUST verify the
  // session id matches the order before doing anything sensitive
  // (see `reconcileOrderPayment` for the pattern).
  //
  // TODO Pass 5b+: drop the global unique once every Order row has
  // orgId; this function must then accept orgId or be replaced with
  // a (orderNumber, sessionId) verification helper.
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
  const doc = await Order.findOne(scopedOrderFilter(id, ctx.orgId));
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

  publishEvent({
    type: DomainEventType.ORDER_ARCHIVED,
    audience: { kind: "creator", userId: String(doc.createdBy.userId) },
    actor: { id: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    orgId: doc.orgId ? String(doc.orgId) : (ctx.orgId ?? null),
    payload: {
      orderId: String(doc._id),
      orderNumber: doc.orderNumber,
      customerName: doc.customer.name,
    },
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
  const doc = await Order.findOne(scopedOrderFilter(id, ctx.orgId));
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

  // Per-order tenant scope — same precedence as initiatePayment.
  const orderOrgId = doc.orgId ? String(doc.orgId) : (ctx.orgId ?? null);
  // Route the regenerate through the gateway interface (Phase 3b closes
  // the back door — pre-Phase-3 this called Stripe directly via
  // `getStripe()`/`buildCheckoutSession`, which made the per-org
  // Stripe-account routing impossible).
  const gatewayKey =
    (doc.payment.gateway as PaymentGatewayKey | null) ??
    getDefaultGateway().key;
  const gateway = await getGatewayForOrg(orderOrgId, gatewayKey);
  if (!gateway) {
    throw new ConflictError(
      `${gatewayKey} is not configured for this organization. Reconfigure credentials before regenerating.`,
    );
  }
  if (!gateway.enabled) {
    throw new ConflictError(
      `${gateway.label} is not available. Configure credentials in admin settings.`,
    );
  }

  const settings = await getSettings(orderOrgId);
  const branding = await getBranding(orderOrgId);
  const expiresAt = new Date(
    Date.now() + settings.paymentExpiryHours * 60 * 60 * 1000,
  );

  // Expire previous session via the gateway adapter — works for any
  // gateway (best-effort; gateway impls log + swallow on
  // already-expired).
  if (doc.payment.stripeSessionId) {
    void gateway.expireSession(doc.payment.stripeSessionId);
  }

  const gatewayProduct = describeProductForGateway(doc);

  let session: CreatedPaymentSession;
  try {
    session = await gateway.createSession({
      orderId: String(doc._id),
      orderNumber: doc.orderNumber,
      amount: doc.pricing.amount,
      currency: doc.pricing.currency,
      customer: doc.customer,
      productName: gatewayProduct.name,
      description: gatewayProduct.description ?? "",
      imageUrls: gatewayProduct.imageUrls,
      successUrl: settings.successRedirectUrl,
      cancelUrl: settings.cancelRedirectUrl,
      expiresAt,
      metadata: {
        orderId: String(doc._id),
        orderNumber: doc.orderNumber,
        actorId: ctx.actor.id,
        actorEmail: ctx.actor.email,
        appName: branding.brandName,
      },
    });
  } catch (err) {
    logger.error("orders.regenerate_failed", {
      orderId: String(doc._id),
      gateway: gatewayKey,
      err: err instanceof Error ? err.message : String(err),
    });
    throw new PaymentError("Could not regenerate the payment link", err);
  }

  if (!session.url) {
    throw new PaymentError("Gateway did not return a checkout URL");
  }

  doc.payment.stripeSessionId = session.sessionId;
  doc.payment.checkoutUrl = session.url;
  doc.payment.expiresAt = session.expiresAt;
  doc.payment.failureReason = null;
  doc.payment.paymentIntentId = session.paymentIntentId;
  doc.status = OrderStatus.PAYMENT_PENDING;
  doc.payment.status = OrderStatus.PAYMENT_PENDING;

  // Transactional: order save + audit + evidence. The Stripe session
  // is already created above — if the tx aborts we don't roll it back
  // but the next regenerate call will expire-and-replace it.
  await withTx(async (txSession) => {
    await doc.save(sessionOpt(txSession));

    await recordAudit(
      {
        action: AuditAction.ORDER_PAYMENT_LINK_REGENERATED,
        entityType: AuditEntity.ORDER,
        entityId: String(doc._id),
        orgId: orderOrgId,
        actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
        request: ctx.request ?? null,
        metadata: {
          paymentSessionId: session.sessionId,
          gateway: gatewayKey,
        },
      },
      txSession,
    );

    await captureEvidenceSafe(
      {
        orderId: String(doc._id),
        orderNumber: doc.orderNumber,
        eventType: OrderEvidenceEventType.PAYMENT_LINK_REGENERATED,
        actor: {
          type: OrderEvidenceActorType.AGENT,
          userId: ctx.actor.id,
          name: ctx.actor.name,
          email: ctx.actor.email,
          role: ctx.actor.role,
        },
        request: ctx.request ?? null,
        payload: {
          paymentSessionId: session.sessionId,
          paymentIntentId: session.paymentIntentId,
          checkoutUrl: session.url,
          amount: doc.pricing.amount,
          currency: doc.pricing.currency,
          expiresAt: doc.payment.expiresAt
            ? doc.payment.expiresAt.toISOString()
            : null,
        },
        refs: {
          paymentSessionId: session.sessionId,
          paymentIntentId: session.paymentIntentId,
          customerEmail: doc.customer.email,
        },
      },
      txSession,
    );
  });

  logger.info("order.lifecycle.transition", {
    orderId: String(doc._id),
    orderNumber: doc.orderNumber,
    previousState: doc.status,
    nextState: OrderStatus.PAYMENT_PENDING,
    transition: "link_regenerated",
    source: "service.order.regenerate_link",
    actor: ctx.actor.id,
  });
  publishEvent({
    type: DomainEventType.ORDER_LINK_REGENERATED,
    audience: { kind: "creator", userId: String(doc.createdBy.userId) },
    actor: { id: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    orgId: doc.orgId ? String(doc.orgId) : (ctx.orgId ?? null),
    payload: {
      orderId: String(doc._id),
      orderNumber: doc.orderNumber,
      customerName: doc.customer.name,
    },
  });

  return {
    order: orderToDTO(doc.toObject() as OrderDoc & { _id: Types.ObjectId }),
    checkoutUrl: session.url,
  };
}

/**
 * Hard-deletes one or more orders. Paid orders are skipped — financial
 * records must remain in the database for audit/refund purposes. Returns
 * the count actually deleted plus the ids that were blocked.
 */
export async function deleteOrders(
  ids: string[],
  ctx: OrderContext,
): Promise<{ deleted: number; blockedPaidIds: string[] }> {
  await connectMongo();
  const valid = ids.filter((id) => Types.ObjectId.isValid(id));
  if (valid.length === 0) return { deleted: 0, blockedPaidIds: [] };

  const objectIds = valid.map((id) => new Types.ObjectId(id));
  // Pin orgId on the load AND on the delete so a Tenant A admin
  // can't pass Tenant B order ids through this endpoint.
  const docFilter: Record<string, unknown> = { _id: { $in: objectIds } };
  if (ctx.orgId) docFilter.orgId = new Types.ObjectId(ctx.orgId);
  const docs = await Order.find(docFilter)
    .select({ _id: 1, orderNumber: 1, status: 1 })
    .lean<{ _id: Types.ObjectId; orderNumber: string; status: OrderStatus }[]>();

  const paid = docs.filter((d) => d.status === OrderStatus.PAID);
  const deletable = docs.filter((d) => d.status !== OrderStatus.PAID);

  if (deletable.length === 0) {
    throw new ConflictError(
      "Paid orders cannot be deleted. Archive them instead to retain financial history.",
    );
  }

  const deletableIds = deletable.map((d) => d._id);
  // Defense-in-depth: pin orgId on the delete too. `deletable` was
  // already filtered by orgId on the find above, so the ids can only
  // belong to the actor's tenant — but a future code path that
  // rebuilds the id list shouldn't be able to bypass the tenant
  // boundary by accident.
  const deleteFilter: Record<string, unknown> = { _id: { $in: deletableIds } };
  if (ctx.orgId) deleteFilter.orgId = new Types.ObjectId(ctx.orgId);
  const res = await Order.deleteMany(deleteFilter);

  await recordAudit({
    action: AuditAction.ORDER_DELETED,
    entityType: AuditEntity.ORDER,
    entityId: null,
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: {
      deletedCount: res.deletedCount ?? 0,
      ids: deletable.map((d) => String(d._id)),
      orderNumbers: deletable.map((d) => d.orderNumber),
      blockedPaidIds: paid.map((d) => String(d._id)),
    },
  });

  return {
    deleted: res.deletedCount ?? 0,
    blockedPaidIds: paid.map((d) => String(d._id)),
  };
}

/* ────────────────────── Risk-flag + dispute helpers ───────────────────── */

interface FlagOrderInput {
  flagged: boolean;
  note?: string | null;
}

/**
 * Toggle the at-risk flag on an order. The `flaggedBy` snapshot lets the
 * disputes view show who first flagged the order without an extra join.
 */
export async function setOrderRiskFlag(
  id: string,
  input: FlagOrderInput,
  ctx: OrderContext,
): Promise<OrderDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Order not found");
  const doc = await Order.findOne(scopedOrderFilter(id, ctx.orgId));
  if (!doc) throw new NotFoundError("Order not found");

  if (input.flagged) {
    doc.risk = {
      flagged: true,
      flaggedNote: input.note?.trim() || null,
      flaggedAt: new Date(),
      flaggedBy: {
        userId: new Types.ObjectId(ctx.actor.id),
        name: ctx.actor.name,
      },
    };
  } else {
    doc.risk = {
      flagged: false,
      flaggedNote: null,
      flaggedAt: null,
      flaggedBy: null,
    };
  }
  await doc.save();

  await recordAudit({
    action: AuditAction.ORDER_UPDATED,
    entityType: AuditEntity.ORDER,
    entityId: String(doc._id),
    actor: {
      userId: ctx.actor.id,
      name: ctx.actor.name,
      role: ctx.actor.role,
    },
    request: ctx.request ?? null,
    metadata: {
      action: input.flagged ? "risk_flagged" : "risk_unflagged",
      note: input.note ?? null,
    },
  });

  return orderToDTO(doc.toObject() as OrderDoc & { _id: Types.ObjectId });
}

/**
 * Patch the customer details on an order. Used by the payment-request
 * composer right before sending so an agent can fix a typo in the
 * email / name / phone without leaving the workflow. Returns the
 * updated order, and ALSO an `applied` map so the caller can decide
 * what (if anything) to mention in the audit metadata.
 */
export async function updateOrderCustomer(
  id: string,
  patch: { name?: string; email?: string; phone?: string },
  ctx: OrderContext,
): Promise<{
  order: OrderDTO;
  applied: Partial<{ name: string; email: string; phone: string }>;
}> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Order not found");
  const doc = await Order.findOne(scopedOrderFilter(id, ctx.orgId));
  if (!doc) throw new NotFoundError("Order not found");

  const canSeeAll = roleHasPermission(ctx.actor.role, Permission.ORDER_VIEW_ALL);
  if (!canSeeAll && String(doc.createdBy.userId) !== ctx.actor.id) {
    throw new ForbiddenError("You can only edit orders you created");
  }

  const applied: Partial<{ name: string; email: string; phone: string }> = {};
  if (patch.name && patch.name !== doc.customer.name) {
    applied.name = patch.name;
    doc.customer.name = patch.name;
  }
  if (patch.email && patch.email !== doc.customer.email) {
    applied.email = patch.email;
    doc.customer.email = patch.email;
  }
  if (patch.phone && patch.phone !== doc.customer.phone) {
    applied.phone = patch.phone;
    doc.customer.phone = patch.phone;
  }
  if (Object.keys(applied).length === 0) {
    return {
      order: orderToDTO(doc.toObject() as OrderDoc & { _id: Types.ObjectId }),
      applied,
    };
  }
  await doc.save();
  await recordAudit({
    action: AuditAction.ORDER_UPDATED,
    entityType: AuditEntity.ORDER,
    entityId: String(doc._id),
    actor: {
      userId: ctx.actor.id,
      name: ctx.actor.name,
      role: ctx.actor.role,
    },
    request: ctx.request ?? null,
    metadata: { action: "customer_patch", changed: applied },
  });

  // Refresh the saved customer record so next time the operator types
  // this email, the corrected name/phone show up. Best-effort.
  if (ctx.orgId) {
    try {
      await upsertCustomerFromOrder(ctx.orgId, {
        name: doc.customer.name,
        email: doc.customer.email,
        phone: doc.customer.phone,
      });
    } catch (err) {
      logger.warn("customer.upsert_failed", {
        orderId: String(doc._id),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    order: orderToDTO(doc.toObject() as OrderDoc & { _id: Types.ObjectId }),
    applied,
  };
}

/**
 * Lists orders that operators should review. "At risk" is anything that
 * matches at least one of:
 *   - manually flagged (`risk.flagged === true`)
 *   - status FAILED (Stripe rejected the payment) in the active state
 *   - status EXPIRED in the active state (link never paid)
 *
 * Results are sorted with flagged orders first, then most-recent.
 */
export interface ReconcileResult {
  /** Final order DTO after any state change. */
  order: OrderDTO;
  /** Did the order's status actually move during this reconcile call?
   *  Tells the UI whether to show a "now paid" toast or stay quiet. */
  changed: boolean;
  /** Whether Stripe reports this session as paid. Used by the UI to
   *  decide whether to keep polling or stop. */
  stripeStatus:
    | "paid"
    | "unpaid"
    | "no_payment_required"
    | "expired"
    | "open"
    | "unknown";
}

/**
 * Reconcile an order's payment state against Stripe.
 *
 * Why this exists: the webhook is best-effort. In local dev it doesn't
 * reach `localhost` without `stripe listen` forwarding; in prod it can
 * be delayed or dropped. Without a fallback the order stays
 * PAYMENT_PENDING even though the customer paid.
 *
 * The reconcile call asks Stripe directly. If the session shows
 * complete + paid it drives the SAME atomic transition the webhook
 * uses (`applyCheckoutPaid`), so the audit row, domain event, and
 * confirmation email all fire exactly like the live path. If the
 * session is open / unpaid / expired we surface that state so the
 * caller can either keep waiting or show "expired".
 *
 * Two call sites:
 *   - the authed agent endpoint (`/api/orders/[id]/reconcile`)
 *   - the customer-facing `/pay/success` server render — there is no
 *     session there; ctx is omitted. RBAC is skipped because the
 *     customer is already showing up with the orderNumber they got
 *     via email, exactly like `getOrderByNumber` on the same page.
 *
 * Idempotent: the synthesized event id is unique per call but the
 * shared helper's `processedWebhookEventIds` and `isAlreadyPaid` gates
 * stop us from double-emailing on repeat reconciles.
 */
interface ReconcileCustomerProof {
  /** Gateway session id the unauth caller showed up with (came from
   *  Stripe via the success-URL substitution). MUST equal the order's
   *  stored session id or we refuse — otherwise this endpoint becomes
   *  a no-auth way to trigger Stripe API calls for arbitrary orders. */
  sessionId: string;
}

export async function reconcileOrderPayment(
  id: string,
  ctx?: OrderContext,
  customer?: ReconcileCustomerProof,
): Promise<ReconcileResult> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Order not found");
  // Authed path: pin orgId. Public path (no ctx — /pay/success
  // render): no orgId available; the sessionId match below is the
  // tenant boundary surrogate.
  const doc = await Order.findOne(scopedOrderFilter(id, ctx?.orgId));
  if (!doc) throw new NotFoundError("Order not found");

  if (ctx?.actor) {
    const canSeeAll = roleHasPermission(
      ctx.actor.role,
      Permission.ORDER_VIEW_ALL,
    );
    if (!canSeeAll && String(doc.createdBy.userId) !== ctx.actor.id) {
      throw new ForbiddenError(
        "You can only reconcile payment for orders you created",
      );
    }
  } else {
    // Unauthenticated caller (customer on /pay/success). Require the
    // gateway session id from the URL and match it against the stored
    // one — without this anyone with a guessed orderId could DOS Stripe.
    if (
      !customer?.sessionId ||
      !doc.payment.stripeSessionId ||
      customer.sessionId !== doc.payment.stripeSessionId
    ) {
      throw new ForbiddenError("Invalid session for this order");
    }
  }

  if (!doc.payment.stripeSessionId) {
    // No session to ask the gateway about — nothing to reconcile.
    return {
      order: orderToDTO(doc.toObject({ getters: false }) as OrderDoc & { _id: Types.ObjectId }),
      changed: false,
      stripeStatus: "unknown",
    };
  }

  // Already terminal — short-circuit so a reconcile spam-click after
  // PAID doesn't re-hit the gateway.
  if (doc.status === OrderStatus.PAID) {
    return {
      order: orderToDTO(doc.toObject({ getters: false }) as OrderDoc & { _id: Types.ObjectId }),
      changed: false,
      stripeStatus: "paid",
    };
  }

  const wasPending =
    doc.status === OrderStatus.PAYMENT_PENDING ||
    doc.status === OrderStatus.LINK_GENERATED;
  // Reconcile resolves the gateway from the ORDER's persisted orgId
  // — not ctx — because the public `/pay/success` render reconciles
  // without an actor present. The order itself is the tenant boundary.
  const orderOrgId = doc.orgId ? String(doc.orgId) : null;
  const gatewayKey: PaymentGatewayKey =
    (doc.payment.gateway as PaymentGatewayKey | null) ?? getDefaultGateway().key;
  const gateway = await getGatewayForOrg(orderOrgId, gatewayKey);
  if (!gateway || !gateway.enabled) {
    return {
      order: orderToDTO(doc.toObject({ getters: false }) as OrderDoc & { _id: Types.ObjectId }),
      changed: false,
      stripeStatus: "unknown",
    };
  }

  let status: SessionStatus;
  try {
    status = await gateway.getSessionStatus(doc.payment.stripeSessionId);
  } catch (err) {
    logger.error("orders.reconcile_gateway_lookup_failed", {
      orderId: id,
      gateway: gateway.key,
      sessionId: doc.payment.stripeSessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw new PaymentError(
      `Could not verify payment with ${gateway.label}`,
      err,
    );
  }

  // Happy path: gateway says paid. Drive the same atomic transition the
  // webhook handler uses, so audit + event + email all fire identically.
  //
  // Dedupe key is STABLE (`reconcile:<sessionId>`) — repeat reconcile
  // calls share the same key and collapse to a single applied transition
  // via the durable `ProcessedWebhookEvent` collection. The key namespace
  // is disjoint from gateway event ids (`evt_...`) so a real webhook
  // claim and a reconcile claim race independently; whichever wins flips
  // the order, the other lands as duplicate inside `applyCheckoutPaid`.
  if (status.paymentStatus === "paid" || status.status === "complete") {
    const eventId = `reconcile:${doc.payment.stripeSessionId}`;
    await applyCheckoutPaid(doc, {
      eventId,
      sessionId: doc.payment.stripeSessionId,
      paymentIntentId: status.paymentIntentId,
      amountTotal: status.amountTotalMinor,
      paidAtMs: Date.now(),
      source: "reconcile",
    });
    const refreshed = await Order.findOne(
      scopedOrderFilter(id, ctx?.orgId),
    ).lean<OrderDoc & { _id: Types.ObjectId }>();
    if (!refreshed) throw new NotFoundError("Order not found");
    return {
      order: orderToDTO(refreshed),
      changed: wasPending,
      stripeStatus: "paid",
    };
  }

  // Gateway says the session expired before the customer finished.
  if (status.status === "expired") {
    if (
      doc.status === OrderStatus.PAYMENT_PENDING ||
      doc.status === OrderStatus.LINK_GENERATED
    ) {
      doc.status = OrderStatus.EXPIRED;
      doc.payment.status = OrderStatus.EXPIRED;
      await doc.save();
    }
    const refreshed = await Order.findOne(
      scopedOrderFilter(id, ctx?.orgId),
    ).lean<OrderDoc & { _id: Types.ObjectId }>();
    return {
      order: orderToDTO(refreshed!),
      changed: wasPending,
      stripeStatus: "expired",
    };
  }

  // Still pending on the gateway's side — caller (UI poll) keeps waiting.
  const normalisedStatus: ReconcileResult["stripeStatus"] =
    status.paymentStatus === "unpaid" ||
    status.paymentStatus === "no_payment_required"
      ? (status.paymentStatus as ReconcileResult["stripeStatus"])
      : status.status === "open"
        ? "open"
        : "unknown";
  return {
    order: orderToDTO(doc.toObject({ getters: false }) as OrderDoc & { _id: Types.ObjectId }),
    changed: false,
    stripeStatus: normalisedStatus,
  };
}

export async function listAtRiskOrders(
  orgId: string | null,
): Promise<OrderDTO[]> {
  await connectMongo();
  // Pin orgId so the /admin/disputes board doesn't leak Tenant B's
  // at-risk orders to Tenant A's admin. Legacy callers (orgId null)
  // still get the global view — to be removed once the route is
  // updated to pass actor.orgId.
  const filter: Record<string, unknown> = {
    $or: [
      { "risk.flagged": true },
      {
        state: RecordState.ACTIVE,
        status: { $in: [OrderStatus.FAILED, OrderStatus.EXPIRED] },
      },
    ],
  };
  if (orgId) filter.orgId = new Types.ObjectId(orgId);
  const docs = await Order.find(filter)
    .sort({ "risk.flagged": -1, updatedAt: -1 })
    .limit(100)
    .lean<(OrderDoc & { _id: Types.ObjectId })[]>();
  return docs.map(orderToDTO);
}
