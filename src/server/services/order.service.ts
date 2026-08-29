import "server-only";

import { Types } from "mongoose";

import { sessionOpt, withTx } from "@/server/db/transaction";

import {
  AuditAction,
  AuditEntity,
  BookingStatus,
  BookingType,
  CaptureMode,
  ConsentMethod,
  ConsentStatus,
  OrderEvidenceActorType,
  OrderEvidenceEventType,
  OrderStatus,
  PaymentCaptureStatus,
  PaymentGatewayKey,
  RecordState,
  ServiceType,
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
import {
  describeServiceDates,
  describeServiceItem,
  serviceTypeOf,
} from "@/lib/service-summary";
import { logger } from "@/lib/logger";
import { publishEvent } from "@/server/events/bus";
import { Order, type OrderDoc, Organization } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import {
  belongsToScope,
  organizationStamp,
  withOrganizationScope,
} from "@/server/db/organization-filter";
import { getRequestOrganizationScope } from "@/server/auth/organization";
import { resolvePublicBrand } from "@/server/email/identity";
import type {
  ArchiveOrderInput,
  CreateOrderInput,
  CreateOrderRequestInput,
  FlightOrderInput,
  HotelOrderInput,
  ListOrdersQuery,
} from "@/lib/validation";
import type { OrderDTO, PaginatedResult } from "@/types";

import type { RequestContext } from "@/server/api/request-context";
import type {
  CreatedPaymentSession,
  SessionStatus,
} from "@/server/payments/gateway";
import { getGatewayForOrganization } from "@/server/payments/resolve-gateway";
import { recordAudit } from "./audit.service";
import { applyPaymentAuthorized } from "./webhook.service";
import { captureEvidenceSafe } from "./evidence.service";
import { getSettings } from "./settings.service";
import { generateOrderNumber } from "./order-number";
import { buildProviderSnapshotFromKey } from "./provider.service";
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

export interface OrderContext {
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
    // `?? CAR_RENTAL` is load-bearing, not defensive noise: `.lean()` does
    // NOT apply Mongoose defaults, so every order stored before this field
    // existed arrives here with no `serviceType` key at all.
    serviceType: (doc.serviceType ?? ServiceType.CAR_RENTAL) as ServiceType,
    status: doc.status as OrderStatus,
    state: doc.state as RecordState,
    bookingStatus: (doc.bookingStatus ?? null) as BookingStatus | null,
    customer: { ...doc.customer },
    provider: doc.provider
      ? {
          id: doc.provider.id,
          name: doc.provider.name,
          logo: doc.provider.logo,
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
    vehicle: doc.vehicle
      ? {
          company: doc.vehicle.company,
          type: doc.vehicle.type,
          imageUrl: doc.vehicle.imageUrl ?? null,
        }
      : null,
    trip: doc.trip
      ? {
          pickupDate: new Date(doc.trip.pickupDate).toISOString(),
          dropoffDate: new Date(doc.trip.dropoffDate).toISOString(),
          pickupLocation: doc.trip.pickupLocation ?? null,
          dropoffLocation: doc.trip.dropoffLocation ?? null,
        }
      : null,
    flight: doc.flight
      ? {
          tripType: doc.flight.tripType,
          airline: doc.flight.airline ?? null,
          flightNumber: doc.flight.flightNumber ?? null,
          origin: doc.flight.origin,
          destination: doc.flight.destination,
          departureDate: new Date(doc.flight.departureDate).toISOString(),
          departureTimePreference: doc.flight.departureTimePreference ?? null,
          arrivalDate: doc.flight.arrivalDate
            ? new Date(doc.flight.arrivalDate).toISOString()
            : null,
          returnDate: doc.flight.returnDate
            ? new Date(doc.flight.returnDate).toISOString()
            : null,
          returnTimePreference: doc.flight.returnTimePreference ?? null,
          cabinClass: doc.flight.cabinClass,
          passengers: {
            adults: doc.flight.passengers?.adults ?? 1,
            children: doc.flight.passengers?.children ?? 0,
            infants: doc.flight.passengers?.infants ?? 0,
          },
          passengerNotes: doc.flight.passengerNotes ?? null,
          pnr: doc.flight.pnr ?? null,
        }
      : null,
    hotel: doc.hotel
      ? {
          hotelId: doc.hotel.hotelId ? String(doc.hotel.hotelId) : null,
          destination: doc.hotel.destination,
          propertyName: doc.hotel.propertyName ?? null,
          checkInDate: new Date(doc.hotel.checkInDate).toISOString(),
          checkOutDate: new Date(doc.hotel.checkOutDate).toISOString(),
          rooms: doc.hotel.rooms,
          guests: {
            adults: doc.hotel.guests?.adults ?? 1,
            children: doc.hotel.guests?.children ?? 0,
          },
          roomPreference: doc.hotel.roomPreference ?? null,
          guestNotes: doc.hotel.guestNotes ?? null,
          confirmationCode: doc.hotel.confirmationCode ?? null,
        }
      : null,
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
      // Null for every automatic-capture order, i.e. every order both
      // incumbent brands have. The UI keys its Capture / Release controls
      // off this, so those controls are unreachable for them.
      capture: doc.payment.capture
        ? {
            method: doc.payment.capture.method,
            status: doc.payment.capture.status,
            authorizedAt: doc.payment.capture.authorizedAt
              ? new Date(doc.payment.capture.authorizedAt).toISOString()
              : null,
            amountAuthorized: doc.payment.capture.amountAuthorized ?? null,
            captureExpiresAt: doc.payment.capture.captureExpiresAt
              ? new Date(doc.payment.capture.captureExpiresAt).toISOString()
              : null,
            capturedAt: doc.payment.capture.capturedAt
              ? new Date(doc.payment.capture.capturedAt).toISOString()
              : null,
            amountCaptured: doc.payment.capture.amountCaptured ?? null,
            cancelledAt: doc.payment.capture.cancelledAt
              ? new Date(doc.payment.capture.cancelledAt).toISOString()
              : null,
            cancelReason: doc.payment.capture.cancelReason ?? null,
            lastError: doc.payment.capture.lastError ?? null,
          }
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
/**
 * Whether an organization's payments authorize-then-capture.
 *
 * `?? AUTOMATIC` is load-bearing: the resolvers read organizations with
 * `.lean()`, which does NOT apply Mongoose defaults, so a document stored
 * before `captureMode` existed — i.e. both incumbent brands' rows — arrives
 * with no such key and must read as AUTOMATIC.
 *
 * A null organizationId also means AUTOMATIC. Manual capture is only ever
 * enabled by an explicit, stored, per-organization decision.
 */
export async function getOrganizationCaptureMode(
  organizationId: string | null,
): Promise<CaptureMode> {
  if (!organizationId || !Types.ObjectId.isValid(organizationId)) {
    return CaptureMode.AUTOMATIC;
  }
  const org = await Organization.findById(organizationId)
    .select("payments.captureMode")
    .lean<{ payments?: { captureMode?: CaptureMode } } | null>();
  return org?.payments?.captureMode ?? CaptureMode.AUTOMATIC;
}

interface ResolvedLegal {
  termsAndConditions: string;
  termsVersion: string;
  cancellationPolicy: string;
  cancellationPolicyVersion: string;
}

/**
 * The Terms & cancellation policy frozen onto a new order.
 *
 * These strings end up in the customer's receipt, on the consent page, and
 * in the dispute evidence chain, so they must describe what the customer
 * actually bought — a brand selling flights cannot be freezing car-rental
 * terms onto its orders.
 *
 * The organization's own text WINS; an empty value falls through to the
 * deployment Settings singleton. Both incumbent brands have no per-org
 * legal text, so every field falls through and their orders are frozen
 * with exactly the terms they are frozen with today.
 */
async function resolveOrderLegal(
  organizationId: Types.ObjectId | null,
  settings: {
    termsAndConditions: string;
    termsVersion: string;
    cancellationPolicy: string;
    cancellationPolicyVersion: string;
  },
): Promise<ResolvedLegal> {
  const fallback: ResolvedLegal = {
    termsAndConditions: settings.termsAndConditions,
    termsVersion: settings.termsVersion,
    cancellationPolicy: settings.cancellationPolicy,
    cancellationPolicyVersion: settings.cancellationPolicyVersion,
  };
  if (!organizationId) return fallback;

  const org = await Organization.findById(organizationId)
    .select("legal")
    .lean<{ legal?: Partial<ResolvedLegal> | null } | null>();
  const legal = org?.legal;
  if (!legal) return fallback;

  // Field by field, so an organization can override only its T&Cs and
  // still inherit the deployment cancellation policy.
  return {
    termsAndConditions:
      legal.termsAndConditions?.trim() || fallback.termsAndConditions,
    termsVersion: legal.termsVersion?.trim() || fallback.termsVersion,
    cancellationPolicy:
      legal.cancellationPolicy?.trim() || fallback.cancellationPolicy,
    cancellationPolicyVersion:
      legal.cancellationPolicyVersion?.trim() ||
      fallback.cancellationPolicyVersion,
  };
}

export async function createOrder(
  input: CreateOrderRequestInput | CreateOrderInput,
  ctx: OrderContext,
): Promise<CreateOrderResult> {
  await connectMongo();
  const settings = await getSettings();

  if (!settings.allowedBookingTypes.includes(input.bookingType)) {
    throw new ValidationError(
      "This booking type is currently disabled. Update operational settings to enable it.",
    );
  }

  // A payload with no `serviceType` is a pre-multi-service client — i.e.
  // the existing car-rental form — and is exactly what it always was.
  const serviceType =
    ("serviceType" in input ? input.serviceType : undefined) ??
    ServiceType.CAR_RENTAL;

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

  // GUARD: a non-CAR_RENTAL order must be OWNED.
  //
  // An unowned order (organizationId null) is read as belonging to the
  // DEFAULT organization and, critically, its payment resolves to the
  // DEPLOYMENT Stripe account. For a car rental that is the historic
  // pre-migration behaviour and is left alone. For a flight or a hotel it
  // would mean FlightBizz money landing in RentalConfirmation's merchant
  // account, so it is refused outright rather than quietly mis-charged.
  if (serviceType !== ServiceType.CAR_RENTAL && !organizationId) {
    throw new ValidationError(
      "Select an organization before creating this order.",
    );
  }

  // Legal text frozen onto the order. The organization's own text wins;
  // an organization that has none — which is both incumbent brands —
  // falls back to the deployment settings singleton, so their orders carry
  // exactly the terms they have always carried.
  const legal = await resolveOrderLegal(organizationId, settings);

  const serviceFields =
    serviceType === ServiceType.FLIGHT
      ? {
          flight: {
            ...(input as FlightOrderInput).flight,
            departureDate: new Date(
              (input as FlightOrderInput).flight.departureDate,
            ),
            arrivalDate: (input as FlightOrderInput).flight.arrivalDate
              ? new Date((input as FlightOrderInput).flight.arrivalDate!)
              : null,
            returnDate: (input as FlightOrderInput).flight.returnDate
              ? new Date((input as FlightOrderInput).flight.returnDate!)
              : null,
          },
          vehicle: null,
          trip: null,
          hotel: null,
        }
      : serviceType === ServiceType.HOTEL
        ? {
            hotel: {
              ...(input as HotelOrderInput).hotel,
              hotelId: (input as HotelOrderInput).hotel.hotelId
                ? new Types.ObjectId(
                    (input as HotelOrderInput).hotel.hotelId!,
                  )
                : null,
              checkInDate: new Date(
                (input as HotelOrderInput).hotel.checkInDate,
              ),
              checkOutDate: new Date(
                (input as HotelOrderInput).hotel.checkOutDate,
              ),
            },
            vehicle: null,
            trip: null,
            flight: null,
          }
        : {
            // Unchanged car-rental write path.
            vehicle: (input as CreateOrderInput).vehicle,
            trip: {
              pickupDate: new Date((input as CreateOrderInput).trip.pickupDate),
              dropoffDate: new Date(
                (input as CreateOrderInput).trip.dropoffDate,
              ),
              pickupLocation: (input as CreateOrderInput).trip.pickupLocation,
              dropoffLocation: (input as CreateOrderInput).trip.dropoffLocation,
            },
            flight: null,
            hotel: null,
          };

  const created = await withTx(async (session) => {
    const inserted = await Order.create(
      [
        {
          _id: orderId,
          organizationId,
          orderNumber,
          bookingType: input.bookingType,
          serviceType,
          status: OrderStatus.NOT_INITIATED,
          state: RecordState.ACTIVE,
          customer: input.customer,
          provider: providerSnapshot,
          ...serviceFields,
          pricing: { amount: chargeSummary.prepaid, currency },
          charges: chargeSummary.charges,
          terms: {
            text: legal.termsAndConditions,
            version: legal.termsVersion,
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
            version: legal.cancellationPolicyVersion,
            text: legal.cancellationPolicy,
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
          serviceType,
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
          serviceType: serviceTypeOf(orderDoc),
          // The rental keys keep their exact historic shape when present, so
          // a CAR_RENTAL evidence row is byte-identical to what it was; the
          // flight/hotel keys are simply absent for those orders.
          vehicle: orderDoc.vehicle
            ? {
                company: orderDoc.vehicle.company,
                type: orderDoc.vehicle.type,
                imageUrl: orderDoc.vehicle.imageUrl ?? null,
              }
            : null,
          trip: orderDoc.trip
            ? {
                pickupDate: new Date(orderDoc.trip.pickupDate).toISOString(),
                dropoffDate: new Date(orderDoc.trip.dropoffDate).toISOString(),
                pickupLocation: orderDoc.trip.pickupLocation ?? null,
                dropoffLocation: orderDoc.trip.dropoffLocation ?? null,
              }
            : null,
          flight: orderDoc.flight
            ? {
                tripType: orderDoc.flight.tripType,
                airline: orderDoc.flight.airline ?? null,
                flightNumber: orderDoc.flight.flightNumber ?? null,
                origin: orderDoc.flight.origin,
                destination: orderDoc.flight.destination,
                departureDate: new Date(
                  orderDoc.flight.departureDate,
                ).toISOString(),
                returnDate: orderDoc.flight.returnDate
                  ? new Date(orderDoc.flight.returnDate).toISOString()
                  : null,
                cabinClass: orderDoc.flight.cabinClass,
                passengers: orderDoc.flight.passengers,
              }
            : null,
          hotel: orderDoc.hotel
            ? {
                destination: orderDoc.hotel.destination,
                propertyName: orderDoc.hotel.propertyName ?? null,
                checkInDate: new Date(
                  orderDoc.hotel.checkInDate,
                ).toISOString(),
                checkOutDate: new Date(
                  orderDoc.hotel.checkOutDate,
                ).toISOString(),
                rooms: orderDoc.hotel.rooms,
                guests: orderDoc.hotel.guests,
              }
            : null,
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
  const productName = describeProductName(doc);
  const description = describeProductDescription(doc);

  // Capture mode comes from the ORDER'S organization, for the same reason
  // the gateway does: an operator who has switched tenants in another tab
  // must not change how this order's money is taken.
  const captureMode = await getOrganizationCaptureMode(
    doc.organizationId ? String(doc.organizationId) : null,
  );
  const isManualCapture =
    captureMode === CaptureMode.MANUAL &&
    gatewayKey === PaymentGatewayKey.STRIPE;

  let session: CreatedPaymentSession;
  try {
    session = await gateway.createSession({
      orderId: String(doc._id),
      orderNumber: doc.orderNumber,
      amount: doc.pricing.amount,
      currency: doc.pricing.currency,
      customer: doc.customer,
      productName,
      description,
      // Undefined for an automatic-capture organization, which makes the
      // outgoing Stripe payload byte-identical to what it has always been.
      ...(isManualCapture ? { captureMethod: "manual" as const } : {}),
      imageUrls: doc.vehicle?.imageUrl ? [doc.vehicle.imageUrl] : undefined,
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
          // Written ONLY for a manual-capture order. For every other order
          // this key is absent from the $set entirely, so `payment.capture`
          // stays null and the stored document is unchanged in shape.
          ...(isManualCapture
            ? {
                "payment.capture": {
                  method: CaptureMode.MANUAL,
                  status: PaymentCaptureStatus.PENDING_AUTHORIZATION,
                },
                bookingStatus: BookingStatus.PENDING,
              }
            : {}),
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
          captureMode,
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

/**
 * The line-item name on the gateway-hosted checkout page.
 *
 * THE CAR_RENTAL OUTPUT IS UNCHANGED. The three `bookingType` cases below
 * are the original strings verbatim; only the noun they interpolate is now
 * sourced from `describeServiceItem`, which returns
 * `${company} ${type}` for a rental exactly as the old
 * `${input.vehicle.company} ${input.vehicle.type}` did.
 *
 * Without this a FlightBizz customer would read "Delta • Boeing 737 rental"
 * on the page where they authorise the charge.
 */
function describeProductName(order: OrderDoc): string {
  const providerName = resolveProvider({
    id: order.provider?.id ?? resolveProvider(undefined).id,
  }).name;
  const item = describeServiceItem(order);
  const serviceType = serviceTypeOf(order);

  if (serviceType === ServiceType.CAR_RENTAL) {
    switch (order.bookingType) {
      case BookingType.NEW_BOOKING:
        return `${providerName} • ${item} rental`;
      case BookingType.MODIFICATION:
        return `${providerName} booking modification • ${item}`;
      case BookingType.CANCELLATION_CHARGE:
        return `${providerName} cancellation charge • ${item}`;
      default:
        return `${providerName} • ${item}`;
    }
  }

  const noun = serviceType === ServiceType.FLIGHT ? "flight" : "hotel";
  switch (order.bookingType) {
    case BookingType.NEW_BOOKING:
      return `${providerName} • ${item} ${noun}`;
    case BookingType.MODIFICATION:
      return `${providerName} booking modification • ${item}`;
    case BookingType.CANCELLATION_CHARGE:
      return `${providerName} cancellation charge • ${item}`;
    default:
      return `${providerName} • ${item}`;
  }
}

/**
 * The line-item description on the gateway-hosted checkout page.
 * `describeServiceDates` reproduces the rental "Pick-up: … • Drop-off: …"
 * string byte-for-byte.
 */
function describeProductDescription(order: OrderDoc): string {
  return describeServiceDates(order);
}

// ---------- Listing / fetching ----------

export async function listOrders(
  query: ListOrdersQuery,
  ctx: OrderContext,
): Promise<PaginatedResult<OrderDTO>> {
  await connectMongo();
  const scope = await getRequestOrganizationScope();
  const filter: Record<string, unknown> = {};
  filter.state = query.state ?? RecordState.ACTIVE;
  if (query.status) filter.status = query.status;
  if (query.bookingType) filter.bookingType = query.bookingType;
  if (query.serviceType) {
    // CAR_RENTAL must also match rows written before `serviceType` existed.
    // Until the backfill has run they carry no such key, and a bare equality
    // filter would hide every historical order from both incumbent brands.
    filter.serviceType =
      query.serviceType === ServiceType.CAR_RENTAL
        ? { $in: [ServiceType.CAR_RENTAL, null] }
        : query.serviceType;
  }

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
  const scoped = withOrganizationScope(filter, scope);

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
export async function resolveGatewayForOrder(
  doc: { organizationId?: Types.ObjectId | null; payment: { gateway?: string | null } },
  override: PaymentGatewayKey | null,
) {
  const orgId = doc.organizationId ? String(doc.organizationId) : null;
  const pinned = (doc.payment.gateway as PaymentGatewayKey | null) ?? null;

  // Already has a session: stay on the SAME provider, so a regenerate or a
  // status lookup hits the merchant account that holds the original.
  if (pinned) return getGatewayForOrganization(orgId, pinned);

  // New session: pass the requested provider through, but the organization
  // has the final say — getGatewayForOrganization honours it only if the
  // brand has that provider enabled, and otherwise uses its default. That
  // lets one brand offer several gateways while a stray client value (the
  // composer hardcodes STRIPE) can never select one it has no account for.
  if (orgId) return getGatewayForOrganization(orgId, override);

  // Unmigrated deployment — no organization to consult, so an explicit
  // choice is all there is. This is the pre-organization behaviour.
  return getGatewayForOrganization(null, override);
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
export async function assertOrderInScope(doc: {
  organizationId?: Types.ObjectId | null;
}): Promise<void> {
  const scope = await getRequestOrganizationScope();
  if (!belongsToScope(doc.organizationId, scope)) {
    throw new NotFoundError("Order not found");
  }
}

/**
 * DELIBERATELY UNSCOPED BY ORGANIZATION. Do not "fix" this.
 *
 * The only caller is the PUBLIC /pay/success page, which the customer
 * reaches by being redirected back from Stripe or PayPal. That request
 * carries no session and no organization cookie, so a tenancy filter here
 * resolves to `denyAll` → match-nothing and the payment-success page breaks
 * for EVERY brand.
 *
 * The protection is at the call site and is sound: the page requires the
 * gateway session id as well as the order number and refuses to render
 * unless the pair matches the stored order (src/app/pay/success/page.tsx).
 * Knowing an order number alone buys an attacker nothing.
 *
 * Any future ADMIN caller must use `getOrderById`, which does scope.
 */
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
  // A LIVE authorization must not be orphaned.
  //
  // Regenerating repoints `payment.paymentIntentId` at a brand-new intent.
  // If the old one is still holding the customer's funds, that hold becomes
  // unreachable — Capture and Release would both act on the NEW intent, the
  // customer stays out of pocket until Stripe expires the old hold ~7 days
  // later, and a second successful payment would charge them twice.
  //
  // Release the authorization first, then regenerate. `payment.capture` is
  // null on every automatic-capture order, so neither incumbent brand can
  // reach this branch.
  const liveCapture = doc.payment?.capture?.status;
  if (
    liveCapture === PaymentCaptureStatus.AUTHORIZED ||
    liveCapture === PaymentCaptureStatus.CAPTURE_PENDING
  ) {
    throw new ConflictError(
      "This order has a live authorization. Release the authorization before generating a new payment link.",
    );
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

  // THE CAPTURE MODE MUST BE CARRIED OVER.
  //
  // `initiatePayment` resolves this from the order's organization and pins
  // `payment.capture`. Regeneration has to resolve it again, or the
  // replacement session is created with AUTOMATIC capture while the order
  // still says MANUAL — Stripe would charge the customer at checkout while
  // the webhook path recorded it as a mere authorization, leaving an order
  // that took real money and never became PAID.
  //
  // Resolved from the ORDER's organization for the same reason the gateway
  // is: an operator who has switched tenants in another tab must not change
  // how this order's money is taken.
  const regenCaptureMode = await getOrganizationCaptureMode(
    doc.organizationId ? String(doc.organizationId) : null,
  );
  const regenIsManual =
    regenCaptureMode === CaptureMode.MANUAL &&
    gateway.key === PaymentGatewayKey.STRIPE;

  let session: CreatedPaymentSession;
  try {
    session = await gateway.createSession({
      orderId: String(doc._id),
      orderNumber: doc.orderNumber,
      // Undefined for an automatic-capture organization, so the outgoing
      // payload for both incumbent brands is byte-identical to today's.
      ...(regenIsManual ? { captureMethod: "manual" as const } : {}),
      // Regeneration reuses the snapshot already attached to the order —
      // never re-validates against the live catalog so disabled providers
      // can still have outstanding payment links refreshed. `pricing.amount`
      // is already the PREPAID total, so the refreshed link charges only the
      // prepaid amount, identical to the initial link.
      amount: doc.pricing.amount,
      currency: doc.pricing.currency,
      customer: doc.customer,
      productName: describeProductName(doc),
      description: describeProductDescription(doc),
      imageUrls: doc.vehicle?.imageUrl ? [doc.vehicle.imageUrl] : undefined,
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
  // Re-arm the authorization record against the NEW intent. Without this a
  // regenerated manual-capture order carries stale capture state — e.g. a
  // CANCELLED or AUTHORIZATION_EXPIRED status that would make the incoming
  // authorization for the new session fail its `PENDING_AUTHORIZATION`
  // filter and be silently dropped.
  if (regenIsManual) {
    doc.payment.capture = {
      method: CaptureMode.MANUAL,
      status: PaymentCaptureStatus.PENDING_AUTHORIZATION,
      authorizedAt: null,
      amountAuthorized: null,
      captureExpiresAt: null,
      capturedAt: null,
      amountCaptured: null,
      cancelledAt: null,
      cancelReason: null,
      lastError: null,
    };
    doc.bookingStatus = BookingStatus.PENDING;
  }

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
  // Tenancy: an operator may only delete orders belonging to the
  // organization they are acting as. This only ever RESTRICTS — the default
  // organization's clause still matches its own rows plus the unattributed
  // pre-migration ones, so RentalConfirmation deletes exactly what it could
  // delete before. What it stops is a third tenant reaching another brand's
  // records by id.
  const deleteScope = withOrganizationScope(
    { _id: { $in: objectIds } },
    await getRequestOrganizationScope(),
  );
  const docs = await Order.find(deleteScope)
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
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError("Order not found");
  const doc = await Order.findById(id);
  if (!doc) throw new NotFoundError("Order not found");

  if (ctx?.actor) {
    // TENANCY. This was the ONLY by-id order path without a scope check,
    // while eight siblings had one. Without it an ADMIN or SUPER_ADMIN who
    // supplies another tenant's order id gets the full OrderDTO back —
    // customer name, email, phone, amounts — and can drive that order to
    // PAID, firing a confirmation email against the other brand's Stripe
    // account. The ORDER_VIEW_ALL check below is a ROLE check, not a
    // TENANT check, and grants no cross-brand right.
    //
    // Deliberately inside the authenticated branch ONLY. The public
    // /pay/success caller (src/app/pay/success/page.tsx:121) passes no
    // `ctx`, carries no session and no organization cookie, so the ambient
    // scope there resolves to denyAll — running this on that path would
    // break the payment-success page for all three brands. That caller is
    // protected instead by the gateway-session-id pairing in the `else`
    // branch below, which is sound.
    await assertOrderInScope(doc);

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
  // THE MANUAL-CAPTURE CARVE-OUT.
  //
  // For an automatic-capture order `manual` is false and this expression
  // reduces to the ORIGINAL `paymentStatus === "paid" || status === "complete"`
  // exactly — `payment.capture` is null on every order both incumbent brands
  // have, so their reconcile behaviour is untouched.
  //
  // For a manual-capture order `status === "complete"` is true the instant
  // the customer authorizes, while no money has moved. Accepting it would
  // reintroduce, via reconcile, precisely the bug the webhook guard exists
  // to prevent — so only a gateway-reported "paid" counts.
  const manual = doc.payment?.capture?.method === CaptureMode.MANUAL;
  const gatewaySaysPaid = manual
    ? status.paymentStatus === "paid"
    : status.paymentStatus === "paid" || status.status === "complete";

  if (
    manual &&
    !gatewaySaysPaid &&
    status.status === "complete" &&
    status.paymentStatus === "unpaid"
  ) {
    // Authorized but uncaptured. Record it idempotently under a namespace
    // disjoint from both real Stripe event ids and the reconcile key, then
    // report the authorization rather than a payment.
    await applyPaymentAuthorized(doc, {
      eventId: `authorize:${doc.payment.stripeSessionId}`,
      paymentIntentId: status.paymentIntentId,
      amountAuthorizedMinor: status.amountTotalMinor,
      authorizedAtMs: Date.now(),
      source: "reconcile",
    });
    const refreshedAuth = await Order.findById(id).lean<
      OrderDoc & { _id: Types.ObjectId }
    >();
    if (!refreshedAuth) throw new NotFoundError("Order not found");
    return {
      order: orderToDTO(refreshedAuth),
      changed: wasPending,
      stripeStatus: "unpaid",
    };
  }

  if (gatewaySaysPaid) {
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
  // Tenancy: the at-risk dashboard must show the acting organization's own
  // orders. Composed under `$and` because the risk predicate already owns
  // the top-level `$or` — assigning a second one would silently drop
  // whichever lost the key collision.
  const scoped = withOrganizationScope(
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
  );
  const docs = await Order.find(scoped)
    .sort({ "risk.flagged": -1, updatedAt: -1 })
    .limit(100)
    .lean<(OrderDoc & { _id: Types.ObjectId })[]>();
  return docs.map(orderToDTO);
}
