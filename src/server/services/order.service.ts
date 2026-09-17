import "server-only";

import { Types } from "mongoose";

import { sessionOpt, withTx } from "@/server/db/transaction";

import {
  AuditAction,
  AuditEntity,
  BookingType,
  ConsentMethod,
  ConsentStatus,
  EmailKind,
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
import { hasCustomerConsent } from "@/lib/consent";
import {
  isOperatorSupersede,
  outstandingHeldPayments,
} from "@/lib/payment-state";
import { logger } from "@/lib/logger";
import { publishEvent } from "@/server/events/bus";
import {
  Order,
  Organization,
  PaymentConsent,
  PendingEmail,
  PendingEmailStatus,
  type OrderDoc,
  type OrderDocument,
} from "@/server/db/models";
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
import {
  checkoutRequestKey,
  type CreatedPaymentSession,
  type SessionStatus,
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
      detailsChangedAt: doc.payment.detailsChangedAt
        ? doc.payment.detailsChangedAt.toISOString()
        : null,
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
        held: Boolean(a.held),
        heldReviewedAt: a.heldReviewedAt ? a.heldReviewedAt.toISOString() : null,
        heldKind: (a.heldKind ?? null) as OrderDTO["payment"]["attempts"][number]["heldKind"],
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
      collectionMethod: doc.consent?.collectionMethod ?? null,
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
  assertNoHeldPayment(doc);
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
    // Asking for a DIFFERENT gateway than the one already holding a live
    // link used to return that link silently, so an operator who picked
    // PayPal was told a link was ready when it was still Stripe. Moving
    // gateways is its own action, with its own safeguards.
    if (
      options.gateway &&
      doc.payment.gateway &&
      options.gateway !== doc.payment.gateway
    ) {
      throw new ConflictError(
        `This order already has a ${doc.payment.gateway} payment link. Use "Try another gateway" on the order page to move it to ${options.gateway}.`,
      );
    }
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
      attempt: (doc.payment.attempts ?? []).length,
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
      {
        _id: doc._id,
        status: OrderStatus.NOT_INITIATED,
        // The session above was created for THIS amount. A re-price landing
        // meanwhile must make this write miss, or the order would go live
        // on a link that collects an amount it no longer asks for. The
        // raced branch below cancels the orphaned session.
        "pricing.amount": doc.pricing.amount,
        "payment.priceRevision": revisionCondition(doc),
      },
      {
        $set: {
          status: OrderStatus.LINK_GENERATED,
          "payment.status": OrderStatus.LINK_GENERATED,
          "payment.gateway": gatewayKey,
          "payment.stripeSessionId": session.sessionId,
          "payment.checkoutKey": checkoutKeyFor(doc),
          "payment.detailsChangedAt": null,
          // A manual confirmation does not cover a gateway payment.
          ...(doc.consent?.collectionMethod === "MANUAL"
            ? {
                "consent.status": ConsentStatus.NOT_REQUESTED,
                "consent.currentConsentId": null,
                "consent.requestedAt": null,
                "consent.receivedAt": null,
                "consent.verifiedAt": null,
                "consent.method": null,
                "consent.collectionMethod": null,
              }
            : {}),
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
    await cancelOrphanSession(doc._id, gateway, session.sessionId);
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
  assertNoHeldPayment(doc);

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

  // Record the outgoing session BEFORE replacing it, then expire it.
  //
  // This used to expire the old session without recording it. The pointer
  // then moved to the new session and nothing remembered the old one, so a
  // late success on it classified as "unknown" and settled the order at
  // whatever amount it reported — and the customer's real payment on the
  // NEW link was then dropped as a duplicate. `supersedeCurrentAttempt`
  // records it (skipping a session a re-price already recorded) and does the
  // best-effort expire.
  //
  // Persisted immediately, in the same safe direction as a gateway switch:
  // if the new session cannot be created, the order shows no link rather
  // than advertising one that was just cancelled.
  const readRevision = revisionCondition(doc);
  const readAmount = doc.pricing.amount;
  const readRegenerateUpdatedAt = doc.updatedAt;
  const supersededNow = await supersedeCurrentAttempt(
    doc,
    "REGENERATED",
    doc.pricing.amount,
  );
  if (supersededNow) {
    await saveIfUnchanged(doc, {
      status: { $ne: OrderStatus.PAID },
      "payment.priceRevision": readRevision,
      "pricing.amount": readAmount,
      // Two regenerate clicks racing: only one may proceed to mint a session.
      updatedAt: readRegenerateUpdatedAt,
    });
  }

  let session: CreatedPaymentSession;
  try {
    session = await gateway.createSession({
      priceRevision: doc.payment.priceRevision ?? 0,
      attempt: (doc.payment.attempts ?? []).length,
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
    // By now the customer's previous link has been stood down. Saying only
    // "could not regenerate" let the operator believe it still worked.
    throw new PaymentError(
      supersededNow
        ? "Could not create the new payment link. The previous link has already been cancelled — try again, or record a manual payment."
        : "Could not regenerate the payment link",
      err,
    );
  }

  if (!session.url) {
    throw new PaymentError(`${gateway.label} did not return a checkout URL`);
  }

  doc.payment.checkoutKey = checkoutKeyFor(doc);
  doc.payment.detailsChangedAt = null;
  retireManualConsentForGatewayLink(doc);
  doc.payment.stripeSessionId = session.sessionId;
  doc.payment.checkoutUrl = session.url;
  doc.payment.expiresAt = session.expiresAt;
  doc.payment.failureReason = null;
  doc.payment.paymentIntentId = session.paymentIntentId;
  // Pin the provider that actually holds this session, so a later reconcile
  // or webhook looks it up on the right merchant account.
  doc.payment.gateway = gateway.key;
  // The new link is "pending payment" only if the customer can already reach
  // it: an outstanding gateway request's consent page forwards to the
  // order's current link. With no request out (never sent, a manual one, or
  // one retired by an amount change) the link still has to be sent, and
  // PAYMENT_PENDING told the operator the customer already had it.
  const regeneratedStatus =
    doc.consent?.requestedAt && doc.consent?.collectionMethod !== "MANUAL"
      ? OrderStatus.PAYMENT_PENDING
      : OrderStatus.LINK_GENERATED;
  const statusBeforeRegenerate = doc.status;
  doc.status = regeneratedStatus;
  doc.payment.status = regeneratedStatus;

  // Transactional: order save + audit + evidence. The Stripe session
  // is already created above — if the tx aborts we don't roll it back
  // but the next regenerate call will expire-and-replace it.
  const regenerateSavedAt = doc.updatedAt;
  await withTx(async (txSession) => {
    try {
      // Nothing may have moved since the session was created: a payment, a
      // re-price or a second regenerate would each make this link wrong.
      await saveIfUnchanged(
        doc,
        {
          status: { $ne: OrderStatus.PAID },
          "payment.priceRevision": readRevision,
          "pricing.amount": readAmount,
          updatedAt: regenerateSavedAt,
        },
        {
          session: txSession,
          message:
            "This order changed while the new link was being created. The new link was cancelled — reload and try again.",
        },
      );
    } catch (err) {
      await cancelOrphanSession(doc._id, gateway, session.sessionId);
      throw err;
    }

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
    previousState: statusBeforeRegenerate,
    nextState: regeneratedStatus,
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
    // Clearing the flag is how an operator says a held payment has been
    // reconciled (refunded). It must not come back if the order is flagged
    // again for another reason.
    const now = new Date();
    for (const a of doc.payment.attempts ?? []) {
      const heldPayment =
        a.held || (a.status === OrderStatus.PAID && Boolean(a.supersededAt));
      if (heldPayment && !a.heldReviewedAt) a.heldReviewedAt = now;
    }
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

  // The automatic confirmation may still be queued (it is sent in the
  // background shortly after payment). Resending while it waited gave the
  // customer two identical emails, so the queued one is held while this
  // send runs and marked done once it succeeds.
  const queued = await PendingEmail.find({
    orderId: doc._id,
    kind: EmailKind.PAYMENT_CONFIRMATION,
    status: PendingEmailStatus.PENDING,
  })
    .select("_id")
    .lean<Array<{ _id: Types.ObjectId }>>();
  const heldIds = queued.map((q) => q._id);
  if (heldIds.length > 0) {
    await PendingEmail.updateMany(
      { _id: { $in: heldIds }, status: PendingEmailStatus.PENDING },
      { $set: { status: PendingEmailStatus.PROCESSING } },
    );
  }
  let sent: Awaited<ReturnType<typeof sendPaymentConfirmationEmail>>;
  try {
    sent = await sendPaymentConfirmationEmail(dto);
  } catch (err) {
    if (heldIds.length > 0) {
      await PendingEmail.updateMany(
        { _id: { $in: heldIds }, status: PendingEmailStatus.PROCESSING },
        { $set: { status: PendingEmailStatus.PENDING } },
      );
    }
    throw err;
  }
  if (heldIds.length > 0) {
    await PendingEmail.updateMany(
      { _id: { $in: heldIds }, status: PendingEmailStatus.PROCESSING },
      {
        $set: {
          status: PendingEmailStatus.SENT,
          sentAt: new Date(),
          lastError: "Sent by an operator's resend",
        },
      },
    );
  }

  await Order.updateOne(
    { _id: doc._id },
    { $set: { "payment.confirmationEmailSentAt": new Date() } },
    // Bookkeeping: must not make an open edit form look out of date.
    { timestamps: false },
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
  // Same tenancy rule as every other order route; this was the one path
  // without it.
  await assertOrderInScope(doc);

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
  // Scoped like every other order list; it was the one listing without it.
  const docs = await Order.find(
    withOrganizationScope(
      {
        $or: [
          { "risk.flagged": true },
          {
            state: RecordState.ACTIVE,
            status: { $in: [OrderStatus.FAILED, OrderStatus.EXPIRED] },
          },
        ],
      },
      await getRequestOrganizationScope(),
    ),
  )
    .sort({ "risk.flagged": -1, updatedAt: -1 })
    .limit(100)
    .lean<(OrderDoc & { _id: Types.ObjectId })[]>();
  return docs.map(orderToDTO);
}

/**
 * Re-price an existing order — change the MCO (the amount charged now).
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

  // Stand down any session that could still take money at the OLD amount,
  // recording it with the amount it was for so a late webhook on it is
  // recognisable. Shared with every other supersede path, which also stops a
  // second re-price from recording the same dead session twice. The ids stay
  // on the order: a dispute or a late webhook must remain routable.
  //
  // Status deliberately NOT reset to NOT_INITIATED. That would re-open
  // `initiatePayment`'s `{status: NOT_INITIATED}` filter and make the order
  // look like one that had never been billed, while an old payable link is
  // still in the wild.
  const readUpdatedAt = doc.updatedAt;
  const hadLiveSession = await supersedeCurrentAttempt(
    doc,
    "REPRICED",
    previousAmount,
  );
  if (summary.prepaid !== previousAmount) {
    noteRepriceOnStoodDownLink(doc, hadLiveSession);
  }

  doc.charges = summary.charges;
  doc.pricing.amount = summary.prepaid;
  doc.payment.priceRevision = (doc.payment.priceRevision ?? 0) + 1;
  const retiredConsent =
    summary.prepaid !== previousAmount ? retireConsent(doc) : null;
  await saveIfUnchanged(doc, { updatedAt: readUpdatedAt });

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
      consentReset: retiredConsent,
      reason: input.reason ?? null,
    },
  });

  return orderToDTO(doc.toObject() as OrderDoc & { _id: Types.ObjectId });
}

/**
 * Record the current checkout session as superseded and stand it down.
 *
 * Shared by the two things that can invalidate a live link: an amount change
 * and an order edit that re-prices. Extracted so both behave identically —
 * a second copy of this is how one of them quietly stops recording the old
 * amount.
 *
 * Returns whether there was anything to supersede.
 */
/**
 * Save an order only if it is still in the state this operation read.
 *
 * Money-moving operations read an order, do slow work (a gateway call), then
 * write. Without a condition, a payment or a re-price landing in between is
 * silently overwritten: a PAID order written back to FAILED, a live link
 * minted at an amount that is no longer owed. `where` is added to the save's
 * filter, so the write simply does not happen when the order moved, and the
 * operator is told to retry against the current state.
 */
async function saveIfUnchanged(
  doc: OrderDocument,
  where: Record<string, unknown>,
  opts: { session?: import("mongoose").ClientSession | null; message?: string } = {},
): Promise<void> {
  const d = doc as unknown as { $where?: Record<string, unknown> | null };
  d.$where = where;
  try {
    await doc.save(sessionOpt(opts.session ?? null));
    // Only now that the stand-down is recorded is the old session cancelled
    // at the gateway. Inside a transaction the commit decides, so the
    // expiry waits for a later, non-transactional save.
    if (!opts.session) await expirePendingSessions(doc);
  } catch (err) {
    if (err instanceof Error && err.name === "DocumentNotFoundError") {
      throw new ConflictError(
        opts.message ??
          "This order changed while your action was being processed. Reload it and try again.",
      );
    }
    throw err;
  } finally {
    d.$where = null;
  }
}

/**
 * Cancel a session this call created but could not attach to the order.
 *
 * Only when the order is not pointing at it: a gateway's idempotency can
 * hand two racing calls the SAME session, and expiring it then would cancel
 * the link the winning call just attached.
 */
async function cancelOrphanSession(
  orderId: Types.ObjectId | string,
  gateway: { expireSession(id: string): Promise<void> },
  sessionId: string,
): Promise<void> {
  const current = await Order.findById(orderId)
    .select("payment.stripeSessionId")
    .lean<{ payment?: { stripeSessionId?: string | null } } | null>();
  if (current?.payment?.stripeSessionId === sessionId) return;
  await gateway.expireSession(sessionId).catch(() => undefined);
}

/**
 * The key the order's NEXT checkout is created with — the same value the
 * gateway adapter uses as its request key, computed from the same inputs
 * (`priceRevision`, and the attempt ordinal = attempts recorded so far).
 * Call it before the new attempt is appended.
 */
function checkoutKeyFor(doc: OrderDocument): string {
  return checkoutRequestKey({
    orderId: String(doc._id),
    priceRevision: doc.payment.priceRevision ?? 0,
    attempt: (doc.payment.attempts ?? []).length,
  });
}

/** The `priceRevision` value as stored, for use in a save condition. A
 *  never-repriced legacy order may have no field at all. */
function revisionCondition(
  doc: OrderDocument,
): number | { $in: Array<number | null> } {
  const rev = doc.payment.priceRevision ?? 0;
  return rev === 0 ? { $in: [0, null] } : rev;
}

/**
 * Sessions stood down in memory whose gateway expiry is waiting for the
 * order write that records it. Expiring first meant a write that then lost
 * a race left the order presenting a link the gateway had already killed.
 */
const pendingExpiry = new WeakMap<OrderDocument, string[]>();

async function expirePendingSessions(doc: OrderDocument): Promise<void> {
  const ids = pendingExpiry.get(doc);
  if (!ids?.length) return;
  pendingExpiry.delete(doc);
  let gateway: { expireSession(id: string): Promise<void> };
  try {
    gateway = await resolveGatewayForOrder(doc, null);
  } catch (err) {
    logger.warn("orders.supersede_expire_failed", {
      orderId: String(doc._id),
      sessionIds: ids,
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  for (const sessionId of ids) {
    try {
      await gateway.expireSession(sessionId);
    } catch (err) {
      logger.warn("orders.supersede_expire_failed", {
        orderId: String(doc._id),
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function supersedeCurrentAttempt(
  doc: OrderDocument,
  reason: "GATEWAY_SWITCHED" | "REPRICED" | "REGENERATED",
  previousAmount: number,
  opts: { failureReason?: string } = {},
): Promise<boolean> {
  // The pointer is deliberately kept after a supersede (late webhooks and
  // disputes must stay routable), so "has a session id" alone does not mean
  // "has a LIVE session". Without this check a second re-price recorded the
  // same dead session again, at an amount it was never created for.
  const pointerAlreadyRecorded =
    Boolean(doc.payment.stripeSessionId) &&
    (doc.payment.attempts ?? []).some(
      (a) => a.sessionId === doc.payment.stripeSessionId && a.supersededAt,
    );
  const hadLiveSession =
    Boolean(doc.payment.checkoutUrl) ||
    (Boolean(doc.payment.stripeSessionId) && !pointerAlreadyRecorded);
  if (!hadLiveSession) return false;

  doc.payment.attempts = [
    ...(doc.payment.attempts ?? []),
    {
      gateway: (doc.payment.gateway ?? PaymentGatewayKey.STRIPE) as PaymentGatewayKey,
      sessionId: doc.payment.stripeSessionId ?? null,
      checkoutKey: doc.payment.checkoutKey ?? null,
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

  // Expired at the gateway once the caller's conditional save succeeds —
  // see `saveIfUnchanged`. Every caller saves straight after this.
  if (doc.payment.stripeSessionId) {
    pendingExpiry.set(doc, [
      ...(pendingExpiry.get(doc) ?? []),
      doc.payment.stripeSessionId,
    ]);
  }

  doc.payment.checkoutUrl = null;
  doc.payment.expiresAt = null;
  doc.payment.status = OrderStatus.FAILED;
  doc.payment.failureReason =
    opts.failureReason ??
    (reason === "REPRICED"
      ? "Superseded by an amount change"
      : reason === "REGENERATED"
        ? "Replaced by a regenerated link"
        : "Superseded by a gateway change");
  doc.status = OrderStatus.FAILED;
  return true;
}

/**
 * Refuse to start collecting again while a payment the order did not accept
 * is still waiting to be reconciled. Issuing and sending a new link at that
 * point is exactly how a customer who had already paid got charged twice.
 */
export function assertNoHeldPayment(doc: Parameters<typeof outstandingHeldPayments>[0]): void {
  if (outstandingHeldPayments(doc).length > 0) {
    throw new ConflictError(HELD_PAYMENT_BLOCK_MESSAGE);
  }
}

export const HELD_PAYMENT_BLOCK_MESSAGE =
  "A payment was already received on an earlier link. Reconcile it first — refund it and clear the order's flag, or record it as this order's payment — before asking the customer to pay again.";

/** A manual confirmation does not cover a gateway payment. When the order
 *  moves back to a gateway link, that confirmation stops counting. */
function retireManualConsentForGatewayLink(doc: OrderDocument): void {
  if (doc.consent?.collectionMethod === "MANUAL") retireConsent(doc);
}

/** Why a link was stood down when the operator chose manual collection. */
export const MANUAL_REQUEST_STAND_DOWN_REASON =
  "Replaced by a manual payment request";

/**
 * The operator has chosen to collect manually: stop the order's gateway link
 * from being payable before the customer is asked to confirm.
 *
 * A declined Stripe checkout stays open, and the order kept pointing at it,
 * so a customer who retried in that tab settled the order online — silently,
 * as the current session — while the operator was taking the same payment
 * on the terminal. Stood down here, a payment on it is a flagged competing
 * payment instead, and the old attempt stays in the history.
 *
 * Conditional on the order not having moved (a payment landing meanwhile is
 * never overwritten). Returns whether anything was stood down.
 */
export async function standDownLinkForManualRequest(
  id: string,
  ctx: OrderContext,
): Promise<boolean> {
  await connectMongo();
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Order not found");
  const doc = await Order.findById(id);
  if (!doc) throw new NotFoundError("Order not found");
  await assertOrderInScope(doc);
  if (doc.status === OrderStatus.PAID) {
    throw new ConflictError("Cannot send a request — order is already paid.");
  }
  if (!doc.payment.stripeSessionId && !doc.payment.checkoutUrl) return false;

  const readUpdatedAt = doc.updatedAt;
  const stoodDown = await supersedeCurrentAttempt(
    doc,
    "GATEWAY_SWITCHED",
    doc.pricing.amount,
    { failureReason: MANUAL_REQUEST_STAND_DOWN_REASON },
  );
  if (!stoodDown) return false;
  await saveIfUnchanged(
    doc,
    { status: { $ne: OrderStatus.PAID }, updatedAt: readUpdatedAt },
    {
      message:
        "This order changed while the manual request was being prepared. Reload it — it may already be paid.",
    },
  );
  await recordAudit({
    action: AuditAction.ORDER_UPDATED,
    entityType: AuditEntity.ORDER,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: {
      action: "link_stood_down_for_manual_request",
      orderNumber: doc.orderNumber,
      sessionId: doc.payment.stripeSessionId ?? null,
      gateway: doc.payment.gateway ?? null,
    },
  });
  return true;
}

/**
 * A link that was already stood down (a regenerate or switch that failed, or
 * lost a race) keeps that reason. Once the amount changes, the amount is why
 * a new link is needed, and the payment-request page keys its "re-priced"
 * guidance on exactly this reason.
 */
function noteRepriceOnStoodDownLink(doc: OrderDocument, supersededNow: boolean) {
  if (supersededNow) return;
  if (
    doc.status === OrderStatus.FAILED &&
    isOperatorSupersede(doc.payment.failureReason)
  ) {
    doc.payment.failureReason = "Superseded by an amount change";
  }
}

/** One field's before/after, for the audit trail. */
interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

/**
 * Order edit — apply a customer-requested change to an EXISTING booking.
 *
 * An order edit is a business operation, not an entity: the customer rings up
 * and asks for a different car, a later return date, a corrected email. The
 * order is amended in place. Nothing in this function creates an order, and
 * `_id` / `orderNumber` are never assigned to.
 *
 * LIFECYCLE RULES ARE PER-FIELD, not a blanket status gate. A blanket
 * "NOT_INITIATED only" rule would defeat the requirement outright, since the
 * archetypal edit — "extend my return date" — happens mid-rental, long after
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
): Promise<{
  order: OrderDTO;
  changes: FieldChange[];
  amountChanged: boolean;
  consentReset: boolean;
  checkoutDetailsChanged: boolean;
}> {
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

  // The operator's edit was made against a specific version of the order.
  // If anyone — a colleague, a webhook, another tab — has written since, the
  // values this request carries may be the stale ones it was opened with,
  // and applying them would silently undo that newer change.
  const STALE_EDIT_MESSAGE =
    "This order was changed after you opened it. Reload the page to see the latest version, then make your change again.";
  if (
    input.expectedUpdatedAt &&
    doc.updatedAt &&
    doc.updatedAt.toISOString() !== new Date(input.expectedUpdatedAt).toISOString()
  ) {
    throw new ConflictError(STALE_EDIT_MESSAGE);
  }
  const readUpdatedAt = doc.updatedAt;

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

  // ─── Provider (branding) ───────────────────────────────────────────────
  //
  // Re-snapshotted from the catalog rather than trusted from the request, so
  // an unknown or disabled key is refused the same way creation refuses it.
  //
  // Refused outright once the order is PAID: by then the snapshot is what the
  // customer actually saw on their receipt, and that receipt is the document
  // most likely to be attached to a chargeback. Re-branding it after the fact
  // would make our own evidence contradict the customer's copy.
  if (input.provider && input.provider !== doc.provider?.id) {
    if (doc.status === OrderStatus.PAID) {
      throw new ConflictError(
        "This order is already paid. Its rental provider can no longer be changed.",
      );
    }
    const snapshot = await buildProviderSnapshotFromKey(input.provider);
    track("provider", doc.provider?.id ?? null, snapshot.id);
    doc.provider = {
      id: snapshot.id,
      name: snapshot.name,
      logo: snapshot.logo,
      primaryColor: snapshot.primaryColor ?? null,
      onPrimaryColor: snapshot.onPrimaryColor ?? null,
    };
  }

  // ─── Vehicle ───────────────────────────────────────────────────────────
  if (input.vehicle) {
    for (const key of ["company", "type"] as const) {
      const next = input.vehicle[key];
      if (next === undefined) continue;
      track(`vehicle.${key}`, doc.vehicle[key], next);
      doc.vehicle[key] = next;
    }
    // Kept out of the loop above for a plain typing reason: over a union key
    // whose members have different value types (`string` vs `string | null`),
    // `doc.vehicle[key] = next` does not narrow. The `!== undefined` guard is
    // the same one the loop uses, and it is what makes "did not mention the
    // photo" mean "leave the photo alone" rather than "clear it".
    if (input.vehicle.imageUrl !== undefined) {
      track(
        "vehicle.imageUrl",
        doc.vehicle.imageUrl ?? null,
        input.vehicle.imageUrl,
      );
      doc.vehicle.imageUrl = input.vehicle.imageUrl;
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
    // Snapshot the breakdown BEFORE the assignment further down, or this
    // compares the array to itself. Both sides go through `summarizeCharges`
    // so the comparison is like-for-like: the stored lines are Mongoose
    // subdocuments carrying their own `_id`, which differs on every save, and
    // a legacy order with no `charges[]` needs its single synthesised line or
    // the diff reads as a phantom `[] → [Rental cost]`.
    const previousCharges = summarizeCharges(
      doc.charges,
      doc.pricing.amount,
    ).charges;

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
      noteRepriceOnStoodDownLink(doc, supersededLiveSession);
      doc.payment.priceRevision = (doc.payment.priceRevision ?? 0) + 1;
      track("pricing.amount", previousAmount, summary.prepaid);
    }

    // A breakdown can move without the prepaid TOTAL moving: renaming a line,
    // re-timing one, splitting 500 into 300 + 200, or editing a due-at-counter
    // line — which is the most common non-money booking change there is, and
    // is exactly what the customer's charge table shows them.
    //
    // Recorded separately because the block above only ever tracked
    // `pricing.amount`. With no change recorded, the early return below fired
    // before `doc.save()` and the edit was discarded — while the response,
    // built from the already-mutated in-memory document, reported it applied.
    //
    // Pushed directly rather than through `track()`: that helper compares with
    // `!==`, which on two arrays is reference inequality and always true.
    //
    // Deliberately NOT a supersession trigger. `summary.prepaid !==
    // previousAmount` remains the only thing that stands down a live payment
    // session or bumps the price revision — renaming a line must not kill a
    // checkout link the customer is part-way through.
    const breakdownChanged =
      JSON.stringify(previousCharges) !== JSON.stringify(summary.charges);
    if (breakdownChanged) {
      // The guard above covers the total; this covers the lines behind it.
      // Without it, fixing the silent discard would newly ALLOW rewriting a
      // settled order's breakdown, which is the opposite of the intent.
      if (doc.status === OrderStatus.PAID) {
        throw new ConflictError(
          "This order is already paid. Its charge breakdown can no longer be changed.",
        );
      }
      changes.push({
        field: "charges",
        from: previousCharges,
        to: summary.charges,
      });
    }

    doc.charges = summary.charges;
    doc.pricing.amount = summary.prepaid;
  }

  if (changes.length === 0) {
    return {
      order: orderToDTO(doc.toObject() as OrderDoc & { _id: Types.ObjectId }),
      changes: [],
      amountChanged: false,
      consentReset: false,
      checkoutDetailsChanged: false,
    };
  }

  // A live checkout page was built from a snapshot of these fields: the
  // product name (provider, vehicle), its description (trip dates and
  // places) and the prefilled email. Editing them does not stand the link
  // down — the amount is unchanged, and killing a link the customer may be
  // part-way through is worse — but the operator must be told the customer
  // will still see the old wording until a new link is generated.
  const linkIsLive =
    !amountChanged &&
    Boolean(doc.payment?.checkoutUrl) &&
    (doc.status === OrderStatus.LINK_GENERATED ||
      doc.status === OrderStatus.PAYMENT_PENDING);
  const checkoutDetailsChanged =
    linkIsLive &&
    changes.some(
      (c) =>
        c.field === "provider" ||
        c.field === "customer.email" ||
        c.field === "vehicle.company" ||
        c.field === "vehicle.type" ||
        c.field.startsWith("trip."),
    );

  if (checkoutDetailsChanged) doc.payment.detailsChangedAt = new Date();
  const retiredConsent = amountChanged ? retireConsent(doc) : null;

  // Written only if nothing has touched the order since it was read — see
  // `saveIfUnchanged`. A payment settling in between would otherwise be
  // overwritten back to FAILED by a re-price.
  await saveIfUnchanged(doc, { updatedAt: readUpdatedAt }, { message: STALE_EDIT_MESSAGE });

  await recordAudit({
    action: AuditAction.ORDER_UPDATED,
    entityType: AuditEntity.ORDER,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: {
      // Stored label kept as-is so existing audit history still matches;
      // it records an order edit (which may or may not change the MCO).
      action: "mco_modified",
      orderNumber: doc.orderNumber,
      changes,
      amountChanged,
      supersededLiveSession,
      priceRevision: doc.payment.priceRevision ?? 0,
      reason: input.reason ?? null,
      consentReset: retiredConsent,
      checkoutDetailsChanged,
    },
  });

  // Any other tab or payment-request page open on this order is now showing
  // the old version. Without this it kept offering the old amount and
  // details until someone reloaded it.
  publishEvent({
    type: DomainEventType.ORDER_UPDATED,
    audience: {
      kind: "creator",
      userId: doc.createdBy?.userId ? String(doc.createdBy.userId) : ctx.actor.id,
    },
    actor: { id: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    payload: {
      orderId: String(doc._id),
      orderNumber: doc.orderNumber,
      customerName: doc.customer.name,
      amountChanged,
      checkoutDetailsChanged,
      updatedAt: doc.updatedAt?.toISOString() ?? null,
    },
  });

  return {
    order: orderToDTO(doc.toObject() as OrderDoc & { _id: Types.ObjectId }),
    changes,
    amountChanged,
    consentReset: Boolean(retiredConsent),
    checkoutDetailsChanged,
  };
}

/**
 * A customer's consent covers the amount they were shown, and the way they
 * were told they would pay. When either changes, that consent no longer
 * covers it.
 *
 * Before this, a consent given at $500 stayed in force after a re-price to
 * $650: the customer's old confirmation page forwarded them to the $650
 * checkout, a re-send told them "you already confirmed", a manual payment
 * of $650 was recorded against the $500 consent, and the evidence pack cited
 * a consent for a different amount than was charged.
 *
 * The order's pointer is returned to NOT_REQUESTED so the next payment
 * request asks for a fresh confirmation. The old consent record is kept
 * untouched as history. Returns what was retired, for the audit trail, or
 * null when there was nothing to retire.
 */
function retireConsent(
  doc: OrderDocument,
): { status: string; consentId: string | null } | null {
  const status = doc.consent?.status ?? ConsentStatus.NOT_REQUESTED;
  if (status === ConsentStatus.NOT_REQUESTED) return null;
  const consentId = doc.consent?.currentConsentId
    ? String(doc.consent.currentConsentId)
    : null;
  doc.consent = {
    status: ConsentStatus.NOT_REQUESTED,
    currentConsentId: null,
    requestedAt: null,
    receivedAt: null,
    verifiedAt: null,
    method: null,
    collectionMethod: null,
  } as unknown as typeof doc.consent;
  return { status, consentId };
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
  assertNoHeldPayment(doc);
  if (doc.payment.gateway === input.gateway) {
    throw new ConflictError(
      `This order is already on ${input.gateway}. Regenerate the link instead.`,
    );
  }

  const orgId = doc.organizationId ? String(doc.organizationId) : null;
  // Throws PaymentProviderNotEnabledError / NotConfiguredError when the
  // organization has not switched the target on — a loud refusal rather than
  // a silent fallback to whatever is configured.
  const previousGateway = doc.payment.gateway ?? null;
  // A refused switch is part of the payment history an operator (or a
  // dispute) needs to see: "we tried PayPal and it was not available".
  const auditSwitchFailure = (reason: string) =>
    recordAudit({
      action: AuditAction.ORDER_UPDATED,
      entityType: AuditEntity.ORDER,
      entityId: String(doc._id),
      actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
      request: ctx.request ?? null,
      metadata: {
        action: "gateway_switch_failed",
        orderNumber: doc.orderNumber,
        fromGateway: previousGateway,
        toGateway: input.gateway,
        reason: reason.slice(0, 500),
      },
    }).catch(() => undefined);

  let gateway: Awaited<ReturnType<typeof getGatewayForOrganization>>;
  try {
    gateway = await getGatewayForOrganization(orgId, {
      kind: "requested",
      provider: input.gateway,
    });
  } catch (err) {
    await auditSwitchFailure(err instanceof Error ? err.message : String(err));
    throw err;
  }

  const previousAmount = doc.pricing.amount;

  // Stand the outgoing attempt down BEFORE opening the new one, so a success
  // arriving in between is already classifiable as superseded.
  //
  // Conditional on the order being exactly as read. Two switch requests that
  // raced each used to succeed and each issue a live session; a payment
  // landing between the read and this write used to be overwritten.
  const readUpdatedAt = doc.updatedAt;
  const readRevision = revisionCondition(doc);
  const hadLinkBeforeSwitch = Boolean(doc.payment.checkoutUrl);
  await supersedeCurrentAttempt(doc, "GATEWAY_SWITCHED", previousAmount);
  await saveIfUnchanged(doc, {
    status: { $ne: OrderStatus.PAID },
    updatedAt: readUpdatedAt,
    "payment.priceRevision": readRevision,
  });
  const supersededAt = doc.updatedAt;

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
      attempt: (doc.payment.attempts ?? []).length,
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
    await auditSwitchFailure(err instanceof Error ? err.message : String(err));
    // The outgoing attempt is already recorded as superseded and its link is
    // down. That is the safe direction to fail in: the order collects
    // nothing until a link is successfully issued, rather than having two.
    // Say so — the operator otherwise assumes the old link still works.
    throw new PaymentError(
      hadLinkBeforeSwitch
        ? `Could not create the ${gateway.label} payment session. The previous payment link has already been cancelled — generate a new link or record a manual payment.`
        : `Could not create the ${gateway.label} payment session for this order`,
      err,
    );
  }

  const initiatedAt = new Date();
  doc.payment.gateway = input.gateway;
  const switchedCheckoutKey = checkoutKeyFor(doc);
  doc.payment.checkoutKey = switchedCheckoutKey;
  doc.payment.detailsChangedAt = null;
  doc.payment.stripeSessionId = session.sessionId;
  doc.payment.checkoutUrl = session.url;
  doc.payment.paymentIntentId = null;
  doc.payment.status = OrderStatus.LINK_GENERATED;
  doc.payment.failureReason = null;
  doc.payment.expiresAt = expiresAt;
  doc.payment.initiatedAt = initiatedAt;
  doc.status = OrderStatus.LINK_GENERATED;
  // The customer confirmed a request that led to the OLD gateway's link.
  // That confirmation does not stand for a payment on another gateway: the
  // next request asks again, and the old request page stops forwarding.
  const retiredConsent = retireConsent(doc);
  // The incoming attempt joins the history immediately, so the order's own
  // record shows both the failed Stripe try and the live PayPal one.
  doc.payment.attempts = [
    ...(doc.payment.attempts ?? []),
    {
      gateway: input.gateway,
      sessionId: session.sessionId,
      checkoutKey: switchedCheckoutKey,
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
  try {
    await saveIfUnchanged(
      doc,
      { status: { $ne: OrderStatus.PAID }, updatedAt: supersededAt },
      {
        message:
          "This order changed while the new payment link was being created. The new link was cancelled — reload and try again.",
      },
    );
  } catch (err) {
    await cancelOrphanSession(doc._id, gateway, session.sessionId);
    throw err;
  }

  await recordAudit({
    action: AuditAction.ORDER_PAYMENT_LINK_REGENERATED,
    entityType: AuditEntity.ORDER,
    entityId: String(doc._id),
    actor: { userId: ctx.actor.id, name: ctx.actor.name, role: ctx.actor.role },
    request: ctx.request ?? null,
    metadata: {
      action: "gateway_switched",
      consentReset: retiredConsent,
      orderNumber: doc.orderNumber,
      fromGateway: previousGateway,
      toGateway: input.gateway,
      amount: doc.pricing.amount,
      currency: doc.pricing.currency,
      newSessionId: session.sessionId,
    },
  });

  // The dispute evidence chain must show the move too: which gateway took
  // over, and the link it issued.
  const switchActor = {
    type: OrderEvidenceActorType.AGENT,
    userId: ctx.actor.id,
    name: ctx.actor.name,
    email: ctx.actor.email,
    role: ctx.actor.role,
  };
  await captureEvidenceSafe({
    orderId: String(doc._id),
    orderNumber: doc.orderNumber,
    eventType: OrderEvidenceEventType.GATEWAY_SELECTED,
    actor: switchActor,
    request: ctx.request ?? null,
    payload: {
      gateway: input.gateway,
      gatewayLabel: gateway.label,
      previousGateway,
      reason: "gateway_switched",
      orderNumber: doc.orderNumber,
    },
  });
  await captureEvidenceSafe({
    orderId: String(doc._id),
    orderNumber: doc.orderNumber,
    eventType: OrderEvidenceEventType.PAYMENT_LINK_GENERATED,
    occurredAt: initiatedAt,
    actor: switchActor,
    request: ctx.request ?? null,
    payload: {
      gateway: input.gateway,
      paymentSessionId: session.sessionId,
      checkoutUrl: session.url,
      amount: doc.pricing.amount,
      currency: doc.pricing.currency,
      expiresAt: expiresAt.toISOString(),
      replacedGateway: previousGateway,
    },
    refs: {
      paymentSessionId: session.sessionId,
      customerEmail: doc.customer.email,
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

  // `getOrganization()` is a SUMMARY (id, slug, names) and carries no payment
  // settings. Reading `.payments` off it always yielded undefined, so the
  // enabled list collapsed to the Stripe default and "Try another gateway"
  // never offered PayPal to any organization. Load the settings themselves.
  const org = await getOrganization();
  const orgPayments = await Organization.findById(org.id)
    .select("payments")
    .lean<{
      payments?: {
        enabledProviders?: PaymentGatewayKey[];
        provider?: PaymentGatewayKey;
      };
    } | null>();
  const enabled = enabledProvidersOf({
    payments: orgPayments?.payments ?? null,
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

  // Money already held on an earlier link means this customer may have paid.
  // Charging the card on the terminal as well would take it twice, so the
  // operator must say they have checked it first.
  const held = outstandingHeldPayments(doc);
  if (held.length > 0 && !input.heldPaymentReviewed) {
    const summary = held
      .map((a) => `${a.amount} ${doc.pricing.currency} on ${a.gateway}`)
      .join(", ");
    throw new ConflictError(
      `A payment was already received on an earlier link (${summary}). Check it — refund it, or record it as this order's payment — before recording another.`,
    );
  }

  // Consent is not waived by paying offline. Recording a HELD payment as
  // this order's payment is the exception that proves the rule: the
  // customer confirmed a request and then paid it; a later change of
  // gateway retired that confirmation on the order, but not the fact.
  const consentOnRecord =
    hasCustomerConsent(doc.consent?.status as ConsentStatus | undefined) ||
    (held.length > 0 &&
      (await PaymentConsent.exists({
        orderId: doc._id,
        status: { $in: [ConsentStatus.RECEIVED, ConsentStatus.VERIFIED] },
      })) !== null);
  if (!consentOnRecord) {
    throw new ConflictError(
      "The customer has not completed consent yet. Send the consent request and wait for their signature before recording payment.",
    );
  }

  // Stand down anything still payable BEFORE settling, so a race with a
  // customer paying the old link lands on the superseded path.
  const readUpdatedAt = doc.updatedAt;
  const supersededLiveSession = await supersedeCurrentAttempt(
    doc,
    "GATEWAY_SWITCHED",
    doc.pricing.amount,
  );
  // Conditional: a gateway payment (or a second recording) that settled the
  // order after it was read must not be written back over with FAILED —
  // which is how two concurrent recordings used to leave a paid order FAILED
  // and re-open it to a fresh payment link.
  if (supersededLiveSession) {
    await saveIfUnchanged(
      doc,
      { status: { $ne: OrderStatus.PAID }, updatedAt: readUpdatedAt },
      {
        message:
          "This order changed while you were recording the payment. Reload it — it may already be paid.",
      },
    );
  }

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
  // The operator has dealt with the held payment(s) they were shown.
  if (held.length > 0) {
    const reviewedAt = new Date();
    // Two passes: held payments carry the marker, older records are PAID
    // attempts that were superseded.
    for (const filter of [
      { "h.held": true, "h.heldReviewedAt": null },
      { "h.status": OrderStatus.PAID, "h.supersededAt": { $ne: null }, "h.heldReviewedAt": null },
    ]) {
      await Order.updateOne(
        { _id: fresh._id },
        { $set: { "payment.attempts.$[h].heldReviewedAt": reviewedAt } },
        { arrayFilters: [filter], timestamps: false },
      );
    }
  }

  // A terminal authorisation or transfer reference identifies one
  // collection. Finding it on another paid order most often means the same
  // money is being recorded against two bookings. It is not refused — one
  // transfer can genuinely cover two bookings — but the order is flagged so
  // someone reconciles it, instead of both orders silently reading as paid.
  const referenceReusedOn = await Order.find(
    withOrganizationScope(
      {
        _id: { $ne: fresh._id },
        status: OrderStatus.PAID,
        "payment.manualReference": input.reference,
      },
      await getRequestOrganizationScope(),
    ),
  )
    .select("orderNumber")
    .limit(5)
    .lean<Array<{ orderNumber: string }>>();
  if (referenceReusedOn.length > 0) {
    const others = referenceReusedOn.map((o) => o.orderNumber).join(", ");
    const note = `Payment reference "${input.reference}" is also recorded on ${others}. Check this is not the same payment recorded twice.`;
    const previous = fresh.risk?.flagged ? fresh.risk.flaggedNote : null;
    await Order.updateOne(
      { _id: fresh._id },
      {
        $set: {
          "risk.flagged": true,
          "risk.flaggedNote": (previous ? `${previous}\n\n${note}` : note).slice(0, 2000),
          "risk.flaggedAt": new Date(),
        },
      },
    );
  }

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
      heldPaymentReviewed: held.length > 0 ? true : undefined,
      supersededLiveSession,
      priceRevision: fresh.payment.priceRevision ?? 0,
      referenceReusedOn: referenceReusedOn.map((o) => o.orderNumber),
    },
  });

  const after = await Order.findById(id).lean<OrderDoc & { _id: Types.ObjectId }>();
  return orderToDTO(after!);
}
