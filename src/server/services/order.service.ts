import "server-only";

import { Types } from "mongoose";

import { sessionOpt, withTx } from "@/server/db/transaction";

import {
  AuditAction,
  AuditEntity,
  BookingType,
  ConsentMethod,
  ConsentStatus,
  OrderEvidenceActorType,
  OrderEvidenceEventType,
  OrderStatus,
  PaymentGatewayKey,
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
import { resolveProvider } from "@/lib/constants/providers";
import { summarizeCharges } from "@/lib/charges";
import { logger } from "@/lib/logger";
import { publishEvent } from "@/server/events/bus";
import { Order, type OrderDoc, type OrderDocument } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import {
  belongsToScope,
  organizationStamp,
  withOrganizationScope,
} from "@/server/db/organization-filter";
import { getRequestOrganizationScope,
  getOrganization,
} from "@/server/auth/organization";
import { resolvePublicBrand } from "@/server/email/identity";
import type {
  ArchiveOrderInput,
  CreateOrderInput,
  ListOrdersQuery,
  ChargeInput,
  ModifyOrderInput,
  RecordManualPaymentInput,
} from "@/lib/validation";
import type { OrderDTO, PaginatedResult } from "@/types";

import type { RequestContext } from "@/server/api/request-context";
import type {
  CreatedPaymentSession,
  SessionStatus,
} from "@/server/payments/gateway";
import { enabledProvidersOf, getGatewayForOrganization } from "@/server/payments/resolve-gateway";
import { recordAudit } from "./audit.service";
import { captureEvidenceSafe } from "./evidence.service";
import { getSettings } from "./settings.service";
import { generateOrderNumber } from "./order-number";
import {
  buildProviderSnapshotFromKey,
  currentProviderLogo,
  warmProviderLogoCache,
} from "./provider.service";
import { getBranding } from "./branding.service";
import { applyCheckoutPaid } from "./webhook.service";
import { sendPaymentConfirmationEmail } from "./email.service";

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
    provider: doc.provider
      ? {
          id: doc.provider.id,
          // NAME and COLOURS stay snapshotted — they are brand identity and
          // dispute evidence: a receipt must show what the customer saw.
          name: doc.provider.name,
          // The LOGO resolves LIVE, falling back to the snapshot.
          //
          // A logo is a pointer, not identity, and this order's pointer may
          // be dead: everything uploaded before the asset store lived at
          // `/providers/<key>-<hex>.<ext>` and was destroyed by a later
          // deploy, and each re-upload orphaned the previous path anyway.
          // Preferring the provider's current logo is also what already
          // happens for the six seeded brands, where `resolveProvider`
          // overrides the snapshot from PROVIDER_SEED — this makes the rule
          // uniform instead of depending on whether a brand is hardcoded.
          //
          // Falls back to the snapshot when the cache is cold or the
          // provider has since been deleted, so a removed brand still
          // renders what it always did.
          logo: currentProviderLogo(doc.provider.id) ?? doc.provider.logo,
          primaryColor: doc.provider.primaryColor ?? undefined,
          onPrimaryColor: doc.provider.onPrimaryColor ?? undefined,
        }
      : (() => {
          const fallback = resolveProvider(undefined);
          return {
            id: fallback.id,
            name: fallback.name,
            logo: fallback.logo,
            primaryColor: fallback.primaryColor,
            onPrimaryColor: fallback.onPrimaryColor,
          };
        })(),
    vehicle: { ...doc.vehicle },
    trip: {
      pickupDate: doc.trip.pickupDate.toISOString(),
      dropoffDate: doc.trip.dropoffDate.toISOString(),
      pickupLocation: doc.trip.pickupLocation ?? null,
      dropoffLocation: doc.trip.dropoffLocation ?? null,
    },
    pricing: { amount: doc.pricing.amount, currency: doc.pricing.currency },
    // Charges are the source of truth; legacy orders (no `charges[]`) get a
    // single synthesised prepaid line from `pricing.amount`.
    charges: summarizeCharges(doc.charges, doc.pricing.amount).charges,
    confirmationNumber: doc.confirmationNumber ?? null,
    terms: {
      text: doc.terms?.text ?? "",
      version: doc.terms?.version ?? "v1",
    },
    termsAcknowledgement: doc.termsAcknowledgement?.acknowledgedAt
      ? {
          acknowledgedAt: doc.termsAcknowledgement.acknowledgedAt.toISOString(),
          ip: doc.termsAcknowledgement.ip ?? null,
          userAgent: doc.termsAcknowledgement.userAgent ?? null,
        }
      : null,
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
      manualMethod: doc.payment.manualMethod ?? null,
      manualReference: doc.payment.manualReference ?? null,
      priceRevision: doc.payment.priceRevision ?? 0,
      // `.lean()` skips Mongoose defaults, so an order written before the
      // attempts array existed genuinely arrives without it.
      attempts: (doc.payment.attempts ?? []).map((a) => ({
        gateway: a.gateway,
        sessionId: a.sessionId ?? null,
        amount: a.amount,
        currency: a.currency,
        status: a.status,
        failureReason: a.failureReason ?? null,
        supersededReason: a.supersededReason ?? null,
        supersededAt: a.supersededAt ? a.supersededAt.toISOString() : null,
        createdAt: a.createdAt ? a.createdAt.toISOString() : new Date(0).toISOString(),
      })),
    },
    // Guarded the same way `policy` is a few lines below. The schema marks
    // `createdBy` required, but a row written before it existed — or by any
    // path that bypassed the model — would throw here on `.userId` and take
    // the whole page down rather than the single row. An order with no
    // creator is a legitimate thing to show; it reads as "System".
    createdBy: {
      userId: doc.createdBy?.userId ? String(doc.createdBy.userId) : "",
      name: doc.createdBy?.name ?? "",
      email: doc.createdBy?.email ?? "",
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

  const currency = input.currency ?? settings.defaultCurrency;
  const orderId = new Types.ObjectId();
  const orderNumber = generateOrderNumber(settings.orderPrefix);
  const providerSnapshot = await buildProviderSnapshotFromKey(input.provider);

  // Charges are the source of truth. `pricing.amount` is the PREPAID total —
  // the ONLY figure ever sent to the gateway. Due-at-counter never touches
  // Stripe. Validation already guarantees prepaid >= Stripe's minimum.
  const chargeSummary = summarizeCharges(input.charges);

  // Transactional: Order doc + audit row + genesis evidence row are
  // written together. A failure on evidence aborts the order create —
  // disputes never face a chain with a missing sequence 1.
  // Stamp the acting organization. Null on an unmigrated deployment, which
  // is exactly what pre-migration rows carry, so reads and writes stay
  // consistent in both worlds.
  const organizationId = organizationStamp(await getRequestOrganizationScope());

  const created = await withTx(async (session) => {
    const inserted = await Order.create(
      [
        {
          _id: orderId,
          organizationId,
          orderNumber,
          bookingType: input.bookingType,
          status: OrderStatus.NOT_INITIATED,
          state: RecordState.ACTIVE,
          customer: input.customer,
          provider: providerSnapshot,
          vehicle: input.vehicle,
          trip: {
            pickupDate: new Date(input.trip.pickupDate),
            dropoffDate: new Date(input.trip.dropoffDate),
            pickupLocation: input.trip.pickupLocation,
            dropoffLocation: input.trip.dropoffLocation,
          },
          pricing: { amount: chargeSummary.prepaid, currency },
          charges: chargeSummary.charges,
          terms: {
            text: settings.termsAndConditions,
            version: settings.termsVersion,
          },
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
        actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
        request: ctx.request ?? null,
        metadata: {
          orderNumber: orderDoc.orderNumber,
          amount: orderDoc.pricing.amount,
          prepaid: chargeSummary.prepaid,
          dueAtCounter: chargeSummary.dueAtCounter,
          total: chargeSummary.total,
          currency: orderDoc.pricing.currency,
          bookingType: orderDoc.bookingType,
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
          bookingType: orderDoc.bookingType,
          customer: {
            name: orderDoc.customer.name,
            email: orderDoc.customer.email,
            phone: orderDoc.customer.phone,
          },
          provider: orderDoc.provider
            ? {
                id: orderDoc.provider.id,
                name: orderDoc.provider.name,
                logo: orderDoc.provider.logo,
                primaryColor: orderDoc.provider.primaryColor ?? null,
                onPrimaryColor: orderDoc.provider.onPrimaryColor ?? null,
              }
            : null,
          vehicle: {
            company: orderDoc.vehicle.company,
            type: orderDoc.vehicle.type,
            imageUrl: orderDoc.vehicle.imageUrl ?? null,
          },
          trip: {
            pickupDate: orderDoc.trip.pickupDate.toISOString(),
            dropoffDate: orderDoc.trip.dropoffDate.toISOString(),
            pickupLocation: orderDoc.trip.pickupLocation ?? null,
            dropoffLocation: orderDoc.trip.dropoffLocation ?? null,
          },
          pricing: {
            amount: orderDoc.pricing.amount,
            currency: orderDoc.pricing.currency,
          },
          charges: chargeSummary.charges,
          chargeBreakdown: {
            prepaid: chargeSummary.prepaid,
            dueAtCounter: chargeSummary.dueAtCounter,
            total: chargeSummary.total,
            currency: orderDoc.pricing.currency,
          },
          terms: {
            text: orderDoc.terms?.text ?? "",
            version: orderDoc.terms?.version ?? "v1",
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
    payload: {
      orderId: String(created._id),
      orderNumber: created.orderNumber,
      amount: created.pricing.amount,
      currency: created.pricing.currency,
      customerName: created.customer.name,
      bookingType: created.bookingType,
    },
  });

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
  const doc = await Order.findById(id);
  if (!doc) throw new NotFoundError("Order not found");
  await assertOrderInScope(doc);

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

  // Resolve the gateway from the ORDER'S organization, not the request's.
  // They are normally the same, but pinning to the order means a link
  // regenerated later is created on the same merchant account that took
  // the original payment — even if the operator has since switched
  // organizations in another tab.
  //
  // An explicit `options.gateway` or a previously pinned key still wins, so
  // an order that already chose a gateway keeps it.
  const gateway = await resolveGatewayForOrder(doc, options.gateway ?? null);
  const gatewayKey = gateway.key;
  if (!gateway.enabled) {
    throw new ConflictError(
      `${gateway.label} is not available. Configure credentials in admin settings or pick another gateway.`,
    );
  }

  const settings = await getSettings();
  const expiresAt = new Date(
    Date.now() + settings.paymentExpiryHours * 60 * 60 * 1000,
  );
  const branding = await getBranding();
  // The gateway renders this as the MERCHANT on its own approval screen —
  // PayPal puts it in the header of the page where the customer authorises
  // the charge. Sourcing it from the deployment singleton showed every brand's
  // customer "Rental Confirmation" at the exact moment they part with money.
  const publicBrand = await resolvePublicBrand(
    doc.organizationId ? String(doc.organizationId) : null,
    branding,
  );
  const productName = describeProductName({
    bookingType: doc.bookingType,
    provider: doc.provider?.id ?? resolveProvider(undefined).id,
    vehicle: { company: doc.vehicle.company, type: doc.vehicle.type },
  });
  const description = describeProductDescription({
    trip: {
      pickupDate: doc.trip.pickupDate.toISOString(),
      dropoffDate: doc.trip.dropoffDate.toISOString(),
      pickupLocation: doc.trip.pickupLocation ?? null,
      dropoffLocation: doc.trip.dropoffLocation ?? null,
    },
  });

  let session: CreatedPaymentSession;
  try {
    session = await gateway.createSession({
      priceRevision: doc.payment.priceRevision ?? 0,
      orderId: String(doc._id),
      orderNumber: doc.orderNumber,
      amount: doc.pricing.amount,
      currency: doc.pricing.currency,
      customer: doc.customer,
      productName,
      description,
      imageUrls: doc.vehicle.imageUrl ? [doc.vehicle.imageUrl] : undefined,
      successUrl: settings.successRedirectUrl,
      cancelUrl: settings.cancelRedirectUrl,
      expiresAt,
      metadata: {
        orderId: String(doc._id),
        orderNumber: doc.orderNumber,
        bookingType: doc.bookingType,
        actorId: ctx.actor.id,
        actorEmail: ctx.actor.email,
        appName: publicBrand.brandName,
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
          productName,
          description,
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
    const racedDoc = await Order.findById(id).lean<
      OrderDoc & { _id: Types.ObjectId }
    >();
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

interface ProductNameInput {
  bookingType: BookingType;
  provider: string;
  vehicle: { company: string; type: string };
}

function describeProductName(input: ProductNameInput): string {
  const providerName = resolveProvider({ id: input.provider }).name;
  const vehicle = `${input.vehicle.company} ${input.vehicle.type}`;
  switch (input.bookingType) {
    case BookingType.NEW_BOOKING:
      return `${providerName} • ${vehicle} rental`;
    case BookingType.MODIFICATION:
      return `${providerName} booking modification • ${vehicle}`;
    case BookingType.CANCELLATION_CHARGE:
      return `${providerName} cancellation charge • ${vehicle}`;
    default:
      return `${providerName} • ${vehicle}`;
  }
}

interface ProductDescriptionInput {
  trip: {
    pickupDate: string;
    dropoffDate: string;
    pickupLocation?: string | null;
    dropoffLocation?: string | null;
  };
}

function describeProductDescription(input: ProductDescriptionInput): string {
  const pickup = new Date(input.trip.pickupDate).toISOString().slice(0, 10);
  const drop = new Date(input.trip.dropoffDate).toISOString().slice(0, 10);
  const pickupLoc = input.trip.pickupLocation?.trim();
  const dropLoc = input.trip.dropoffLocation?.trim();
  const pickupPart = pickupLoc ? `${pickup} (${pickupLoc})` : pickup;
  const dropPart = dropLoc ? `${drop} (${dropLoc})` : drop;
  return `Pick-up: ${pickupPart} • Drop-off: ${dropPart}`;
}

// ---------- Listing / fetching ----------

/**
 * The authoritative Mongo filter behind the order list: state, status,
 * booking type, the STAFF own-orders narrowing, the escaped-regex search and
 * the date range, with tenancy composed on last.
 *
 * Exported so the XLSX export runs the IDENTICAL query rather than a second
 * hand-written one. A duplicate filter is how an export quietly stops
 * honouring the STAFF narrowing or the organization scope and starts
 * emitting rows its caller may not see in the UI.
 */
export async function buildOrderListFilter(
  query: ListOrdersQuery,
  ctx: OrderContext,
): Promise<Record<string, unknown>> {
  const scope = await getRequestOrganizationScope();
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

  // Tenancy last, composed under `$and`. The search box above may already
  // own the top-level `$or`; assigning a second one would silently drop
  // whichever lost the key collision.
  return withOrganizationScope(filter, scope);
}

export async function listOrders(
  query: ListOrdersQuery,
  ctx: OrderContext,
): Promise<PaginatedResult<OrderDTO>> {
  await connectMongo();
  await warmProviderLogoCache();
  const scoped = await buildOrderListFilter(query, ctx);

  const { page, pageSize } = query;
  const [items, total] = await Promise.all([
    Order.find(scoped)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean<(OrderDoc & { _id: Types.ObjectId })[]>(),
    Order.countDocuments(scoped),
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
  await warmProviderLogoCache();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Order not found");
  const doc = await Order.findById(id).lean<OrderDoc & { _id: Types.ObjectId }>();
  if (!doc) throw new NotFoundError("Order not found");
  await assertOrderInScope(doc);

  const canSeeAll = roleHasPermission(ctx.actor.role, Permission.ORDER_VIEW_ALL);
  if (!canSeeAll && String(doc.createdBy.userId) !== ctx.actor.id) {
    throw new ForbiddenError("You can only view orders you created");
  }
  return orderToDTO(doc);
}

/**
 * The gateway an order's payment runs on.
 *
 * Resolution order:
 *   1. an explicit override from the caller (the email composer lets an
 *      operator pick),
 *   2. the key already pinned on the order — once a session exists, later
 *      operations must stay on the same merchant account,
 *   3. the order's ORGANIZATION configuration.
 *
 * Note (3) reads the order's organization rather than the request's. For an
 * order created before organizations existed this is null, which resolves
 * to the deployment default — i.e. exactly today's behaviour.
 */
async function resolveGatewayForOrder(
  doc: { organizationId?: Types.ObjectId | null; payment: { gateway?: string | null } },
  override: PaymentGatewayKey | null,
) {
  const orgId = doc.organizationId ? String(doc.organizationId) : null;
  const pinned = (doc.payment.gateway as PaymentGatewayKey | null) ?? null;

  // Already has a session: that provider is AUTHORITATIVE, not a preference.
  // The session, the webhook that will settle it and the money all live in
  // that provider's merchant account, so it is never traded for another one.
  // If it is no longer enabled the caller gets a clear refusal — previously
  // the pin was passed as an override and silently swapped for the
  // organization's configured provider, which on a two-gateway deployment
  // mints a Stripe session over a PayPal order and rewrites payment.gateway
  // underneath it.
  if (pinned) {
    return getGatewayForOrganization(orgId, { kind: "pinned", provider: pinned });
  }

  // New session: the requested provider is a request. It is honoured only if
  // this deployment has it enabled, and refused otherwise — the email
  // composer sends `gateway: "STRIPE"` on every click, and a request for a
  // provider that is switched off must fail loudly rather than quietly
  // becoming a different one.
  return getGatewayForOrganization(orgId, {
    kind: "requested",
    provider: override,
  });
}

/**
 * Refuse an order that belongs to another organization.
 *
 * Raises NotFound, deliberately, rather than Forbidden. A Forbidden here
 * would confirm that the id exists — letting a caller in one organization
 * enumerate the order ids of another just by watching the status code. A
 * cross-tenant read and a genuinely missing record must be indistinguishable.
 *
 * The check is applied after `findById` rather than folded into the query so
 * that "not found" and "not yours" flow through one place instead of being
 * re-derived at every fetch site.
 */
async function assertOrderInScope(doc: {
  organizationId?: Types.ObjectId | null;
}): Promise<void> {
  const scope = await getRequestOrganizationScope();
  if (!belongsToScope(doc.organizationId, scope)) {
    throw new NotFoundError("Order not found");
  }
}

export async function getOrderByNumber(
  orderNumber: string,
): Promise<OrderDTO | null> {
  await connectMongo();
  await warmProviderLogoCache();
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
  await assertOrderInScope(doc);

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
  const doc = await Order.findById(id);
  if (!doc) throw new NotFoundError("Order not found");
  await assertOrderInScope(doc);

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
  // The merchant account that HOLDS the original session — resolved through
  // the order's own organization and its pinned provider.
  //
  // This used to build a Stripe session directly, guarded by
  // `getStripeForOrder`. The guard did not hold: for a PayPal-only brand the
  // STRIPE override is correctly ignored, so `getGatewayForOrganization`
  // returned the PayPal gateway and nothing threw; the Stripe credential
  // lookup then found nothing for that brand and fell back to the
  // DEPLOYMENT's client. Regenerating a link on a Trip Reservations order
  // produced a checkout on Rental Confirmation's merchant account — the exact
  // cross-brand settlement the rest of this file exists to prevent.
  //
  // Going through the gateway abstraction removes the possibility instead of
  // patching the symptom: there is no longer a path here that can reach a
  // Stripe client the organization does not own.
  const gateway = await resolveGatewayForOrder(doc, null);
  const regenBrand = await resolvePublicBrand(
    doc.organizationId ? String(doc.organizationId) : null,
    await getBranding(),
  );
  const expiresAt = new Date(
    Date.now() + settings.paymentExpiryHours * 60 * 60 * 1000,
  );

  // Expire the previous session. Stripe cancels it; PayPal has no cancel for
  // an unapproved order and its adapter logs a deliberate no-op.
  if (doc.payment.stripeSessionId) {
    try {
      await gateway.expireSession(doc.payment.stripeSessionId);
    } catch (err) {
      logger.warn("orders.previous_session_expire_failed", {
        sessionId: doc.payment.stripeSessionId,
        gateway: gateway.key,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let session: CreatedPaymentSession;
  try {
    session = await gateway.createSession({
      priceRevision: doc.payment.priceRevision ?? 0,
      orderId: String(doc._id),
      orderNumber: doc.orderNumber,
      // Regeneration reuses the snapshot already attached to the order —
      // never re-validates against the live catalog so disabled providers
      // can still have outstanding payment links refreshed. `pricing.amount`
      // is already the PREPAID total, so the refreshed link charges only the
      // prepaid amount, identical to the initial link.
      amount: doc.pricing.amount,
      currency: doc.pricing.currency,
      customer: doc.customer,
      productName: describeProductName({
        bookingType: doc.bookingType,
        provider: doc.provider?.id ?? resolveProvider(undefined).id,
        vehicle: { company: doc.vehicle.company, type: doc.vehicle.type },
      }),
      description: describeProductDescription({
        trip: {
          pickupDate: doc.trip.pickupDate.toISOString(),
          dropoffDate: doc.trip.dropoffDate.toISOString(),
          pickupLocation: doc.trip.pickupLocation ?? null,
          dropoffLocation: doc.trip.dropoffLocation ?? null,
        },
      }),
      imageUrls: doc.vehicle.imageUrl ? [doc.vehicle.imageUrl] : undefined,
      successUrl: settings.successRedirectUrl,
      cancelUrl: settings.cancelRedirectUrl,
      expiresAt,
      metadata: {
        orderId: String(doc._id),
        orderNumber: doc.orderNumber,
        bookingType: doc.bookingType,
        actorId: ctx.actor.id,
        actorEmail: ctx.actor.email,
        appName: regenBrand.brandName,
      },
    });
  } catch (err) {
    logger.error("orders.regenerate_failed", {
      orderId: String(doc._id),
      gateway: gateway.key,
      err: err instanceof Error ? err.message : String(err),
    });
    throw new PaymentError("Could not regenerate the payment link", err);
  }

  if (!session.url) {
    throw new PaymentError(`${gateway.label} did not return a checkout URL`);
  }

  doc.payment.stripeSessionId = session.sessionId;
  doc.payment.checkoutUrl = session.url;
  doc.payment.expiresAt = session.expiresAt;
  doc.payment.failureReason = null;
  doc.payment.paymentIntentId = session.paymentIntentId;
  // Pin the provider that actually holds this session, so a later reconcile
  // or webhook looks it up on the right merchant account.
  doc.payment.gateway = gateway.key;
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
        actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
        request: ctx.request ?? null,
        metadata: { stripeSessionId: session.sessionId, gateway: gateway.key },
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
          gateway: gateway.key,
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
  const docs = await Order.find({ _id: { $in: objectIds } })
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
  const res = await Order.deleteMany({ _id: { $in: deletableIds } });

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
  const doc = await Order.findById(id);
  if (!doc) throw new NotFoundError("Order not found");
  await assertOrderInScope(doc);

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
  const doc = await Order.findById(id);
  if (!doc) throw new NotFoundError("Order not found");
  await assertOrderInScope(doc);

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
  return {
    order: orderToDTO(doc.toObject() as OrderDoc & { _id: Types.ObjectId }),
    applied,
  };
}

/**
 * Set / clear the supplier confirmation number on an order. Staff can edit
 * their own orders; admins can edit any (same ownership rule as the customer
 * patch). Pasting the supplier's confirmation number is the manual step
 * after the supplier confirms the booking — it surfaces at the top of the
 * confirmation email. Passing an empty string clears it.
 */
export async function setConfirmationNumber(
  id: string,
  confirmationNumber: string,
  ctx: OrderContext,
): Promise<OrderDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Order not found");
  const doc = await Order.findById(id);
  if (!doc) throw new NotFoundError("Order not found");
  await assertOrderInScope(doc);

  const canSeeAll = roleHasPermission(ctx.actor.role, Permission.ORDER_VIEW_ALL);
  if (!canSeeAll && String(doc.createdBy.userId) !== ctx.actor.id) {
    throw new ForbiddenError("You can only edit orders you created");
  }

  const next = confirmationNumber.trim() || null;
  const previous = doc.confirmationNumber ?? null;
  if (next === previous) {
    return orderToDTO(doc.toObject() as OrderDoc & { _id: Types.ObjectId });
  }
  doc.confirmationNumber = next;
  await doc.save();

  await recordAudit({
    action: AuditAction.ORDER_UPDATED,
    entityType: AuditEntity.ORDER,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: {
      action: "confirmation_number_set",
      from: previous,
      to: next,
    },
  });

  return orderToDTO(doc.toObject() as OrderDoc & { _id: Types.ObjectId });
}

/**
 * Re-send the post-payment confirmation email for a PAID order. The automatic
 * send fires the moment Stripe confirms payment — which is usually *before*
 * the agent has the supplier confirmation number. This lets the agent resend
 * the confirmation (re-rendered from current order state, so it now carries
 * the pasted confirmation number) so the customer receives the updated copy.
 *
 * Ownership-gated like the other staff actions; PAID-only.
 */
export async function resendConfirmationEmail(
  id: string,
  ctx: OrderContext,
): Promise<{ order: OrderDTO; emailId: string | null }> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Order not found");
  const doc = await Order.findById(id).lean<OrderDoc & { _id: Types.ObjectId }>();
  if (!doc) throw new NotFoundError("Order not found");
  await assertOrderInScope(doc);

  const canSeeAll = roleHasPermission(ctx.actor.role, Permission.ORDER_VIEW_ALL);
  if (!canSeeAll && String(doc.createdBy.userId) !== ctx.actor.id) {
    throw new ForbiddenError(
      "You can only resend confirmation emails for orders you created",
    );
  }
  if (doc.status !== OrderStatus.PAID) {
    throw new ConflictError(
      "Confirmation emails can only be resent for paid orders",
    );
  }

  // Re-render from the current DTO so the latest confirmation number /
  // branding / customer email is reflected. This also appends a fresh
  // CONFIRMATION_EMAIL_SENT evidence event for the audit trail.
  const dto = orderToDTO(doc);
  const sent = await sendPaymentConfirmationEmail(dto);

  await Order.updateOne(
    { _id: doc._id },
    { $set: { "payment.confirmationEmailSentAt": new Date() } },
  );

  await recordAudit({
    action: AuditAction.ORDER_UPDATED,
    entityType: AuditEntity.ORDER,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: {
      action: "confirmation_email_resent",
      orderNumber: doc.orderNumber,
      confirmationNumber: doc.confirmationNumber ?? null,
      messageId: sent.id,
    },
  });

  const refreshed = await Order.findById(id).lean<
    OrderDoc & { _id: Types.ObjectId }
  >();
  return { order: orderToDTO(refreshed ?? doc), emailId: sent.id };
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
  await warmProviderLogoCache();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Order not found");
  const doc = await Order.findById(id);
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
  // Resolve through the order's organization so a status lookup queries the
  // merchant account that actually holds the session. Looking it up on the
  // deployment account would simply never find another organization's
  // session and would silently report "unknown".
  const gateway = await resolveGatewayForOrder(doc, null);
  if (!gateway.enabled) {
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
    const refreshed = await Order.findById(id).lean<
      OrderDoc & { _id: Types.ObjectId }
    >();
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
    const refreshed = await Order.findById(id).lean<
      OrderDoc & { _id: Types.ObjectId }
    >();
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

export async function listAtRiskOrders(): Promise<OrderDTO[]> {
  await connectMongo();
  await warmProviderLogoCache();
  const docs = await Order.find({
    $or: [
      { "risk.flagged": true },
      {
        state: RecordState.ACTIVE,
        status: { $in: [OrderStatus.FAILED, OrderStatus.EXPIRED] },
      },
    ],
  })
    .sort({ "risk.flagged": -1, updatedAt: -1 })
    .limit(100)
    .lean<(OrderDoc & { _id: Types.ObjectId })[]>();
  return docs.map(orderToDTO);
}

/**
 * Re-price an existing order — the "MCO amount" edit.
 *
 * The collectable amount is `pricing.amount`, which is by definition the sum
 * of the PREPAID lines in `charges[]` (see `summarizeCharges`). So editing
 * the amount IS editing the charge breakdown; there is no second field and
 * no separate document, and writing one would put two numbers in the system
 * that can disagree.
 *
 * SAME ORDER, ALWAYS. Nothing here creates an order, and `_id` /
 * `orderNumber` are never touched.
 *
 * The hard part is not the arithmetic, it is the session that is already in
 * the customer's inbox. Three verified facts shape this:
 *
 *  1. `failOrder` never expires the gateway session, and a Stripe decline
 *     happens inside a checkout session that stays OPEN. A FAILED order
 *     therefore routinely still holds a payable link.
 *  2. `expireSession` cannot report success — Stripe's adapter swallows
 *     errors and returns void, and PayPal has no cancel for an unapproved
 *     order at all (its adapter is a deliberate logged no-op).
 *  3. `applyCheckoutPaid`'s serialization guard is `status: { $ne: PAID }`,
 *     which a payment on the OLD session passes cleanly.
 *
 * Together those mean the old link cannot be reliably killed, so this does
 * not pretend to kill it. It instead makes the old session *identifiable*:
 * the superseded attempt is recorded with the amount it was for, and
 * `classifyPaymentSession` lets the webhook recognise a payment arriving on
 * it. Best-effort expiry is still attempted, because when it does work it is
 * strictly better.
 *
 * `priceRevision` is bumped so the next session gets a genuinely new gateway
 * idempotency key. Without that, asking Stripe for a new session replays the
 * original at the ORIGINAL price.
 */
export async function repriceOrder(
  id: string,
  input: { charges: ChargeInput[]; reason?: string },
  ctx: OrderContext,
): Promise<OrderDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Order not found");
  const doc = await Order.findById(id);
  if (!doc) throw new NotFoundError("Order not found");
  await assertOrderInScope(doc);

  // Money mutation: admin-only, and not merely "can view all".
  if (!roleHasPermission(ctx.actor.role, Permission.ORDER_UPDATE)) {
    throw new ForbiddenError("You are not allowed to change an order's amount");
  }

  // A settled payment is historical fact. Re-pricing it would leave the
  // gateway's record and ours disagreeing about what was collected, and this
  // codebase has no refund or incremental-capture path to reconcile the
  // difference (the PaymentGateway interface exposes neither).
  if (doc.status === OrderStatus.PAID) {
    throw new ConflictError(
      "This order is already paid. Its amount can no longer be changed.",
    );
  }
  if (doc.state === RecordState.ARCHIVED) {
    throw new ConflictError("Cannot change the amount on an archived order");
  }

  const summary = summarizeCharges(input.charges);
  if (summary.prepaid <= 0) {
    throw new ValidationError(
      "At least one prepaid charge is required to collect payment",
    );
  }

  const previousAmount = doc.pricing.amount;
  const previousCharges = (doc.charges ?? []).map((c) => ({
    name: c.name,
    amount: c.amount,
    timing: c.timing,
  }));

  // A no-op edit must not burn a price revision or supersede a live session
  // the customer is mid-checkout on.
  const unchanged =
    summary.prepaid === previousAmount &&
    JSON.stringify(previousCharges) === JSON.stringify(summary.charges);
  if (unchanged) {
    return orderToDTO(doc.toObject() as OrderDoc & { _id: Types.ObjectId });
  }

  // Is there a session out there that could still take money at the OLD
  // amount? `checkoutUrl` is the honest test: it is what the customer was
  // actually sent, and it survives `failOrder`.
  const hadLiveSession = Boolean(
    doc.payment.checkoutUrl || doc.payment.stripeSessionId,
  );

  if (hadLiveSession) {
    // Record the outgoing attempt BEFORE mutating, with the amount it was
    // for. This is what makes a late webhook on it recognisable instead of
    // silently applying at the new price.
    doc.payment.attempts = [
      ...(doc.payment.attempts ?? []),
      {
        gateway: (doc.payment.gateway ?? PaymentGatewayKey.STRIPE) as PaymentGatewayKey,
        sessionId: doc.payment.stripeSessionId ?? null,
        paymentIntentId: doc.payment.paymentIntentId ?? null,
        checkoutUrl: doc.payment.checkoutUrl ?? null,
        amount: previousAmount,
        currency: doc.pricing.currency,
        status: doc.payment.status,
        failureReason: doc.payment.failureReason ?? null,
        supersededReason: "REPRICED",
        supersededAt: new Date(),
        createdAt: doc.payment.initiatedAt ?? doc.createdAt ?? new Date(),
      },
    ];

    // Best-effort only, and deliberately not trusted: Stripe's adapter
    // swallows errors and returns void, PayPal cannot cancel an unapproved
    // order at all. The recorded attempt above is the real protection.
    if (doc.payment.stripeSessionId) {
      try {
        const gateway = await resolveGatewayForOrder(doc, null);
        await gateway.expireSession(doc.payment.stripeSessionId);
      } catch (err) {
        logger.warn("orders.reprice_expire_failed", {
          orderId: String(doc._id),
          sessionId: doc.payment.stripeSessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Drop the customer-facing link so no surface keeps advertising a URL
    // that collects the wrong amount. The ids are KEPT: a dispute or a late
    // webhook still has to be routable to the attempt that created it.
    doc.payment.checkoutUrl = null;
    doc.payment.expiresAt = null;
    // Status deliberately NOT reset to NOT_INITIATED. That would re-open
    // `initiatePayment`'s `{status: NOT_INITIATED}` filter and make the
    // order look like one that had never been billed, while an old payable
    // link is still in the wild.
    doc.payment.status = OrderStatus.FAILED;
    doc.payment.failureReason = "Superseded by an amount change";
    doc.status = OrderStatus.FAILED;
  }

  doc.charges = summary.charges;
  doc.pricing.amount = summary.prepaid;
  doc.payment.priceRevision = (doc.payment.priceRevision ?? 0) + 1;
  await doc.save();

  await recordAudit({
    action: AuditAction.ORDER_UPDATED,
    entityType: AuditEntity.ORDER,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: {
      action: "amount_changed",
      fromAmount: previousAmount,
      toAmount: summary.prepaid,
      currency: doc.pricing.currency,
      fromCharges: previousCharges,
      toCharges: summary.charges,
      priceRevision: doc.payment.priceRevision,
      supersededLiveSession: hadLiveSession,
      reason: input.reason ?? null,
    },
  });

  return orderToDTO(doc.toObject() as OrderDoc & { _id: Types.ObjectId });
}

/**
 * Record the current checkout session as superseded and stand it down.
 *
 * Shared by the two things that can invalidate a live link: an amount change
 * and an MCO change that re-prices. Extracted so both behave identically —
 * a second copy of this is how one of them quietly stops recording the old
 * amount.
 *
 * Returns whether there was anything to supersede.
 */
async function supersedeCurrentAttempt(
  doc: OrderDocument,
  reason: "GATEWAY_SWITCHED" | "REPRICED",
  previousAmount: number,
): Promise<boolean> {
  const hadLiveSession = Boolean(
    doc.payment.checkoutUrl || doc.payment.stripeSessionId,
  );
  if (!hadLiveSession) return false;

  doc.payment.attempts = [
    ...(doc.payment.attempts ?? []),
    {
      gateway: (doc.payment.gateway ?? PaymentGatewayKey.STRIPE) as PaymentGatewayKey,
      sessionId: doc.payment.stripeSessionId ?? null,
      paymentIntentId: doc.payment.paymentIntentId ?? null,
      checkoutUrl: doc.payment.checkoutUrl ?? null,
      amount: previousAmount,
      currency: doc.pricing.currency,
      status: doc.payment.status,
      failureReason: doc.payment.failureReason ?? null,
      supersededReason: reason,
      supersededAt: new Date(),
      createdAt: doc.payment.initiatedAt ?? doc.createdAt ?? new Date(),
    },
  ];

  if (doc.payment.stripeSessionId) {
    try {
      const gateway = await resolveGatewayForOrder(doc, null);
      await gateway.expireSession(doc.payment.stripeSessionId);
    } catch (err) {
      logger.warn("orders.supersede_expire_failed", {
        orderId: String(doc._id),
        sessionId: doc.payment.stripeSessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  doc.payment.checkoutUrl = null;
  doc.payment.expiresAt = null;
  doc.payment.status = OrderStatus.FAILED;
  doc.payment.failureReason =
    reason === "REPRICED"
      ? "Superseded by an amount change"
      : "Superseded by a gateway change";
  doc.status = OrderStatus.FAILED;
  return true;
}

/** One field's before/after, for the audit trail. */
interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

/**
 * MCO — apply a customer-requested change to an EXISTING booking.
 *
 * "MCO" here is a business operation, not an entity: the customer rings up
 * and asks for a different car, a later return date, a corrected email. The
 * order is amended in place. Nothing in this function creates an order, and
 * `_id` / `orderNumber` are never assigned to.
 *
 * LIFECYCLE RULES ARE PER-FIELD, not a blanket status gate. A blanket
 * "NOT_INITIATED only" rule would defeat the requirement outright, since the
 * archetypal MCO — "extend my return date" — happens mid-rental, long after
 * the link was paid. So:
 *
 *   descriptive fields (customer, vehicle, trip)
 *       editable at ANY lifecycle point, including PAID. They describe the
 *       booking, and the booking genuinely changed. They feed FUTURE links,
 *       consent and evidence; they never rewrite an existing one.
 *
 *   money (charges / pricing.amount)
 *       refused once PAID. A settled transaction is historical fact, and
 *       this codebase has no refund or incremental-capture path to reconcile
 *       a difference — `PaymentGateway` exposes neither.
 *
 * Historical accuracy is preserved by construction: consent snapshots and
 * evidence rows are append-only and are not touched here, so a receipt keeps
 * showing what the customer actually agreed to at the time.
 */
export async function applyOrderModification(
  id: string,
  input: ModifyOrderInput,
  ctx: OrderContext,
): Promise<{ order: OrderDTO; changes: FieldChange[]; amountChanged: boolean }> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Order not found");
  const doc = await Order.findById(id);
  if (!doc) throw new NotFoundError("Order not found");
  await assertOrderInScope(doc);

  if (!roleHasPermission(ctx.actor.role, Permission.ORDER_UPDATE)) {
    throw new ForbiddenError("You are not allowed to modify this order");
  }
  if (doc.state === RecordState.ARCHIVED) {
    throw new ConflictError("Cannot modify an archived order");
  }

  const changes: FieldChange[] = [];
  const track = (field: string, from: unknown, to: unknown) => {
    if (from instanceof Date || to instanceof Date) {
      const f = from instanceof Date ? from.toISOString() : from;
      const t = to instanceof Date ? to.toISOString() : to;
      if (f !== t) changes.push({ field, from: f, to: t });
      return;
    }
    if (from !== to) changes.push({ field, from, to });
  };

  // ─── Customer ──────────────────────────────────────────────────────────
  if (input.customer) {
    for (const key of ["name", "email", "phone"] as const) {
      const next = input.customer[key];
      if (next === undefined) continue;
      track(`customer.${key}`, doc.customer[key], next);
      doc.customer[key] = next;
    }
  }

  // ─── Vehicle ───────────────────────────────────────────────────────────
  if (input.vehicle) {
    for (const key of ["company", "type"] as const) {
      const next = input.vehicle[key];
      if (next === undefined) continue;
      track(`vehicle.${key}`, doc.vehicle[key], next);
      doc.vehicle[key] = next;
    }
  }

  // ─── Trip (dates carry both day and time) ──────────────────────────────
  if (input.trip) {
    if (input.trip.pickupDate !== undefined) {
      track("trip.pickupDate", doc.trip.pickupDate, new Date(input.trip.pickupDate));
      doc.trip.pickupDate = new Date(input.trip.pickupDate);
    }
    if (input.trip.dropoffDate !== undefined) {
      track("trip.dropoffDate", doc.trip.dropoffDate, new Date(input.trip.dropoffDate));
      doc.trip.dropoffDate = new Date(input.trip.dropoffDate);
    }
    for (const key of ["pickupLocation", "dropoffLocation"] as const) {
      const next = input.trip[key];
      if (next === undefined) continue;
      track(`trip.${key}`, doc.trip[key] ?? null, next);
      doc.trip[key] = next;
    }
    // Same invariant creation enforces: a booking cannot end before it starts.
    if (doc.trip.dropoffDate <= doc.trip.pickupDate) {
      throw new ValidationError("Drop-off must be after pick-up");
    }
  }

  // ─── Money, if this change re-prices the booking ────────────────────────
  const previousAmount = doc.pricing.amount;
  let amountChanged = false;
  let supersededLiveSession = false;

  if (input.charges) {
    const summary = summarizeCharges(input.charges);
    if (summary.prepaid <= 0) {
      throw new ValidationError(
        "At least one prepaid charge is required to collect payment",
      );
    }
    if (summary.prepaid !== previousAmount) {
      // Money is the one thing a settled order will not give up.
      if (doc.status === OrderStatus.PAID) {
        throw new ConflictError(
          "This order is already paid. Its amount can no longer be changed.",
        );
      }
      amountChanged = true;
      supersededLiveSession = await supersedeCurrentAttempt(
        doc,
        "REPRICED",
        previousAmount,
      );
      doc.payment.priceRevision = (doc.payment.priceRevision ?? 0) + 1;
      track("pricing.amount", previousAmount, summary.prepaid);
    }
    doc.charges = summary.charges;
    doc.pricing.amount = summary.prepaid;
  }

  if (changes.length === 0) {
    return {
      order: orderToDTO(doc.toObject() as OrderDoc & { _id: Types.ObjectId }),
      changes: [],
      amountChanged: false,
    };
  }

  await doc.save();

  await recordAudit({
    action: AuditAction.ORDER_UPDATED,
    entityType: AuditEntity.ORDER,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: {
      action: "mco_modified",
      orderNumber: doc.orderNumber,
      changes,
      amountChanged,
      supersededLiveSession,
      priceRevision: doc.payment.priceRevision ?? 0,
      reason: input.reason ?? null,
    },
  });

  return {
    order: orderToDTO(doc.toObject() as OrderDoc & { _id: Types.ObjectId }),
    changes,
    amountChanged,
  };
}

/**
 * REQ-2 — move an unpaid order to a DIFFERENT gateway, keeping the same order.
 *
 * The customer's Stripe card declined; the operator offers PayPal instead.
 * Order #123 stays Order #123: nothing here creates an order, and `_id` /
 * `orderNumber` are never assigned to.
 *
 * WHY THIS BYPASSES `resolveGatewayForOrder`. That helper treats an existing
 * `payment.gateway` as authoritative and refuses to trade it, because the
 * session, the webhook that settles it and the money all live in one
 * merchant account — swapping it underneath a live session is how an earlier
 * bug minted a Stripe session over a PayPal order. That rule is right for
 * every implicit path and is left untouched. This is the one EXPLICIT path
 * where an operator has decided to change gateway, so it resolves the target
 * directly via `getGatewayForOrganization` — which still resolves credentials
 * from the order's own organization, so the cross-brand settlement hole the
 * pin exists to close stays closed.
 *
 * DOUBLE-PAYMENT POSITION, stated honestly. The outgoing session cannot be
 * reliably killed: Stripe's `expireSession` swallows errors and returns void,
 * PayPal has no cancel for an unapproved order, and a declined Stripe payment
 * happens INSIDE a session that stays open. So two payable links can briefly
 * coexist. Rather than pretend otherwise, the outgoing attempt is recorded as
 * superseded, and `applyCheckoutPaid`'s gate turns any success on it into a
 * flagged, audited competing payment instead of a second settlement. The
 * first success to arrive establishes the payment state; the second is
 * preserved for an operator to reconcile.
 */
export async function switchOrderGateway(
  id: string,
  input: { gateway: PaymentGatewayKey },
  ctx: OrderContext,
): Promise<{ order: OrderDTO; checkoutUrl: string }> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Order not found");
  const doc = await Order.findById(id);
  if (!doc) throw new NotFoundError("Order not found");
  await assertOrderInScope(doc);

  // ORDER_UPDATE (admin-only), NOT ORDER_REGENERATE_LINK — which STAFF also
  // holds. Regenerating a link re-opens the SAME merchant relationship;
  // switching gateway opens a second payable link on a DIFFERENT merchant
  // account while the old one may still be live. That is the same class of
  // action as re-pricing, so it carries the same permission.
  if (!roleHasPermission(ctx.actor.role, Permission.ORDER_UPDATE)) {
    throw new ForbiddenError("You are not allowed to change this order's gateway");
  }
  // A settled order has nothing left to collect, and issuing a second payable
  // link against it is exactly the double-charge this feature must not create.
  if (doc.status === OrderStatus.PAID) {
    throw new ConflictError("Order is already paid");
  }
  if (doc.state === RecordState.ARCHIVED) {
    throw new ConflictError("Cannot change the gateway on an archived order");
  }
  if (doc.payment.gateway === input.gateway) {
    throw new ConflictError(
      `This order is already on ${input.gateway}. Regenerate the link instead.`,
    );
  }

  const orgId = doc.organizationId ? String(doc.organizationId) : null;
  // Throws PaymentProviderNotEnabledError / NotConfiguredError when the
  // organization has not switched the target on — a loud refusal rather than
  // a silent fallback to whatever is configured.
  const gateway = await getGatewayForOrganization(orgId, {
    kind: "requested",
    provider: input.gateway,
  });

  const previousGateway = doc.payment.gateway ?? null;
  const previousAmount = doc.pricing.amount;

  // Stand the outgoing attempt down BEFORE opening the new one, so a success
  // arriving in between is already classifiable as superseded.
  await supersedeCurrentAttempt(doc, "GATEWAY_SWITCHED", previousAmount);
  await doc.save();

  const settings = await getSettings();
  const expiresAt = new Date(
    Date.now() + settings.paymentExpiryHours * 60 * 60 * 1000,
  );
  const publicBrand = await resolvePublicBrand(orgId, await getBranding());
  const productName = describeProductName({
    bookingType: doc.bookingType,
    provider: doc.provider?.id ?? resolveProvider(undefined).id,
    vehicle: { company: doc.vehicle.company, type: doc.vehicle.type },
  });
  const description = describeProductDescription({
    trip: {
      pickupDate: doc.trip.pickupDate.toISOString(),
      dropoffDate: doc.trip.dropoffDate.toISOString(),
      pickupLocation: doc.trip.pickupLocation ?? null,
      dropoffLocation: doc.trip.dropoffLocation ?? null,
    },
  });

  let session: CreatedPaymentSession;
  try {
    session = await gateway.createSession({
      // The switch itself changes the idempotency key via the gateway, but
      // carrying the revision keeps a re-priced order from replaying an old
      // session on the NEW gateway either.
      priceRevision: doc.payment.priceRevision ?? 0,
      orderId: String(doc._id),
      orderNumber: doc.orderNumber,
      amount: doc.pricing.amount,
      currency: doc.pricing.currency,
      customer: doc.customer,
      productName,
      description,
      imageUrls: doc.vehicle.imageUrl ? [doc.vehicle.imageUrl] : undefined,
      successUrl: settings.successRedirectUrl,
      cancelUrl: settings.cancelRedirectUrl,
      expiresAt,
      metadata: {
        orderId: String(doc._id),
        orderNumber: doc.orderNumber,
        bookingType: doc.bookingType,
        actorId: ctx.actor.id,
        actorEmail: ctx.actor.email,
        appName: publicBrand.brandName,
      },
    });
  } catch (err) {
    logger.error("orders.gateway_switch_failed", {
      orderId: String(doc._id),
      from: previousGateway,
      to: input.gateway,
      err: err instanceof Error ? err.message : String(err),
    });
    // The outgoing attempt is already recorded as superseded and its link is
    // down. That is the safe direction to fail in: the order collects
    // nothing until a link is successfully issued, rather than having two.
    throw new PaymentError(
      `Could not create the ${gateway.label} payment session for this order`,
      err,
    );
  }

  const initiatedAt = new Date();
  doc.payment.gateway = input.gateway;
  doc.payment.stripeSessionId = session.sessionId;
  doc.payment.checkoutUrl = session.url;
  doc.payment.paymentIntentId = null;
  doc.payment.status = OrderStatus.LINK_GENERATED;
  doc.payment.failureReason = null;
  doc.payment.expiresAt = expiresAt;
  doc.payment.initiatedAt = initiatedAt;
  doc.status = OrderStatus.LINK_GENERATED;
  // The incoming attempt joins the history immediately, so the order's own
  // record shows both the failed Stripe try and the live PayPal one.
  doc.payment.attempts = [
    ...(doc.payment.attempts ?? []),
    {
      gateway: input.gateway,
      sessionId: session.sessionId,
      paymentIntentId: null,
      checkoutUrl: session.url,
      amount: doc.pricing.amount,
      currency: doc.pricing.currency,
      status: OrderStatus.LINK_GENERATED,
      failureReason: null,
      supersededReason: null,
      supersededAt: null,
      createdAt: initiatedAt,
    },
  ];
  await doc.save();

  await recordAudit({
    action: AuditAction.ORDER_PAYMENT_LINK_REGENERATED,
    entityType: AuditEntity.ORDER,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: {
      action: "gateway_switched",
      orderNumber: doc.orderNumber,
      fromGateway: previousGateway,
      toGateway: input.gateway,
      amount: doc.pricing.amount,
      currency: doc.pricing.currency,
      newSessionId: session.sessionId,
    },
  });

  publishEvent({
    type: DomainEventType.ORDER_LINK_REGENERATED,
    audience: { kind: "all" },
    actor: { id: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    payload: {
      orderId: String(doc._id),
      orderNumber: doc.orderNumber,
      gateway: input.gateway,
    },
  });

  return {
    order: orderToDTO(doc.toObject() as OrderDoc & { _id: Types.ObjectId }),
    checkoutUrl: session.url,
  };
}

/**
 * The gateways this order could be switched to.
 *
 * `current` is what it collects on today; `options` excludes that one and
 * anything the order's organization has not enabled. MANUAL is excluded
 * because it is not a checkout gateway — offline payment is recorded, never
 * linked to.
 */
export async function getOrderGatewayOptions(
  id: string,
): Promise<{ current: PaymentGatewayKey | null; options: PaymentGatewayKey[] }> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Order not found");
  const doc = await Order.findById(id).lean<OrderDoc & { _id: Types.ObjectId }>();
  if (!doc) throw new NotFoundError("Order not found");
  await assertOrderInScope(doc);

  const org = await getOrganization();
  const enabled = enabledProvidersOf({
    payments: (org as unknown as { payments?: { enabledProviders?: PaymentGatewayKey[]; provider?: PaymentGatewayKey } }).payments,
  }) as PaymentGatewayKey[];

  const current = (doc.payment.gateway as PaymentGatewayKey | null) ?? null;
  return {
    current,
    options: enabled.filter(
      (g) => g !== current && g !== PaymentGatewayKey.MANUAL,
    ),
  };
}

/**
 * REQ-3 — record a payment that was collected OUTSIDE PayOps.
 *
 * The card is charged on a physical terminal, by bank transfer, or in cash.
 * PayOps never sees it. This function records the confirmation and nothing
 * else: no gateway call, no session, no fabricated transaction. That is why
 * `MANUAL` is not in the gateway registry's SUPPORTED list and never will be
 * — it is a bookkeeping outcome, not a checkout provider.
 *
 * DOUBLE-PAYMENT SAFETY, enforced here and not merely warned about in the UI.
 * A FAILED order routinely still holds a payable link: `failOrder` changes
 * three status fields and never expires the session, and a Stripe decline
 * happens inside a checkout session that stays open. So "the order failed"
 * is NOT evidence that no money can still arrive. Before settling, any live
 * session is explicitly stood down and recorded as superseded, which makes a
 * later success on it classifiable — `applyCheckoutPaid`'s gate then turns it
 * into a flagged competing payment instead of a second settlement.
 *
 * CONSENT is required exactly as it is for a gateway payment. The manual path
 * changes how money moves, not whether the customer agreed to the terms.
 */
export async function recordManualPayment(
  id: string,
  input: RecordManualPaymentInput,
  ctx: OrderContext,
): Promise<OrderDTO> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Order not found");
  const doc = await Order.findById(id);
  if (!doc) throw new NotFoundError("Order not found");
  await assertOrderInScope(doc);

  if (!roleHasPermission(ctx.actor.role, Permission.ORDER_UPDATE)) {
    throw new ForbiddenError("You are not allowed to record payments");
  }
  if (doc.state === RecordState.ARCHIVED) {
    throw new ConflictError("Cannot record a payment on an archived order");
  }
  // Idempotent by state: a second recording finds the order already settled
  // and refuses rather than stacking a duplicate payment.
  if (doc.status === OrderStatus.PAID) {
    throw new ConflictError("This order is already paid");
  }
  if (doc.pricing.amount <= 0) {
    throw new ValidationError("This order has nothing to collect");
  }

  // Consent is not waived by paying offline.
  if (doc.consent?.status !== ConsentStatus.RECEIVED) {
    throw new ConflictError(
      "The customer has not completed consent yet. Send the consent request and wait for their signature before recording payment.",
    );
  }

  // Stand down anything still payable BEFORE settling, so a race with a
  // customer paying the old link lands on the superseded path.
  const supersededLiveSession = await supersedeCurrentAttempt(
    doc,
    "GATEWAY_SWITCHED",
    doc.pricing.amount,
  );
  if (supersededLiveSession) await doc.save();

  const fresh = await Order.findById(id);
  if (!fresh) throw new NotFoundError("Order not found");

  // The full prepaid amount, always. Partial and split payments are out of
  // scope, and passing `amountTotal: null` makes the recorded figure equal
  // `pricing.amount` by construction rather than by trusting an input.
  const result = await applyCheckoutPaid(fresh, {
    eventId: `manual:${String(fresh._id)}:${fresh.payment.priceRevision ?? 0}`,
    sessionId: null,
    paymentIntentId: null,
    amountTotal: null,
    paidAtMs: Date.now(),
    source: "manual",
    actor: {
      userId: ctx.actor.id,
      name: ctx.actor.name,
      role: ctx.actor.role,
    },
    manualMethod: input.method,
    manualReference: input.reference,
  });

  if (result.duplicate) {
    throw new ConflictError("This payment has already been recorded");
  }

  // MANUAL has no gateway session, so the pointer must stop naming one.
  // Leaving the old session id in place makes `classifyPaymentSession` read
  // a dead Stripe session as the order's CURRENT one, which is exactly how a
  // late payment on it slipped past the gate. The session survives in
  // `attempts` for dispute routing; only the "what are we collecting on now"
  // pointer is cleared.
  await Order.updateOne(
    { _id: fresh._id },
    { $set: { "payment.stripeSessionId": null, "payment.checkoutUrl": null } },
  );

  await recordAudit({
    action: AuditAction.MANUAL_PAYMENT_RECORDED,
    entityType: AuditEntity.ORDER,
    entityId: String(fresh._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: {
      orderNumber: fresh.orderNumber,
      amount: fresh.pricing.amount,
      currency: fresh.pricing.currency,
      method: input.method,
      reference: input.reference,
      notes: input.notes ?? null,
      supersededLiveSession,
      priceRevision: fresh.payment.priceRevision ?? 0,
    },
  });

  const after = await Order.findById(id).lean<OrderDoc & { _id: Types.ObjectId }>();
  return orderToDTO(after!);
}
