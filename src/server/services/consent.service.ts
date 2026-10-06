import "server-only";

import { Types } from "mongoose";

import {
  AuditAction,
  AuditEntity,
  type BookingType,
  ConsentMethod,
  ConsentStatus,
  type Currency,
  FlightTripType,
  OrderEvidenceActorType,
  OrderEvidenceEventType,
  type PaymentGatewayKey,
  ServiceType,
  type UserRole,
} from "@/lib/constants/enums";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import {
  buildFlightItinerary,
  type FlightItinerarySource,
  type FlightJourneyLike,
  type FlightLayoverView,
  type FlightSegmentView,
  formatDuration,
  type LocalDateTime,
  normalizeTripType,
  segmentCarrier,
  toPlainJourney,
  truncateText,
} from "@/lib/flight-itinerary";
import { logger } from "@/lib/logger";
import { PaymentGatewayLabel } from "@/lib/constants/labels";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import { DomainEventType } from "@/lib/constants/events";
import { publishEvent } from "@/server/events/bus";
import { Order, Organization, PaymentConsent } from "@/server/db/models";
import type { PaymentConsentDoc } from "@/server/db/models";
import { resolvePublicBrand } from "@/server/email/identity";
import { connectMongo } from "@/server/db/mongoose";
import {
  belongsToScope,
  withOrganizationScope,
} from "@/server/db/organization-filter";
import { getRequestOrganizationScope } from "@/server/auth/organization";
import type {
  OrderFlightJourney,
  PaymentConsentDTO,
  PaymentConsentFlightSnapshot,
  PaymentConsentSnapshot,
  PublicConsentView,
} from "@/types";

import type { RequestContext } from "@/server/api/request-context";

import { recordAudit } from "./audit.service";
import {
  captureEvidenceSafe,
  hashConsentToken,
} from "./evidence.service";
import {
  buildConsentUrl,
  generateConsentToken,
  parseConsentToken,
} from "./consent-token";

interface ConsentActor {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

/** Schema limits of the rental-shaped slots a flight folds its route into
 *  (`vehicle`, `pickupLocation`, `dropoffLocation` in payment-consent.model.ts). */
const SNAPSHOT_VEHICLE_MAX_LENGTH = 160;
const SNAPSHOT_LOCATION_MAX_LENGTH = 200;

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A finite, non-negative amount, or null. */
function amountOrNull(value: number | null | undefined): number | null {
  const n = finiteOrNull(value);
  return n !== null && n >= 0 ? n : null;
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function clampText(value: string | null | undefined, max: number): string | null {
  return typeof value === "string" ? truncateText(value, max) : null;
}

/** One journey as plain data, with exactly one connection per gap — the
 *  same mapper the order DTO uses, so the two can never shape it apart. */
function journeySnapshot(
  journey: FlightJourneyLike | null | undefined,
): OrderFlightJourney | null {
  return toPlainJourney(journey);
}

/** What a flight snapshot is read from: the one the email service built, or
 *  a stored record (Mongoose subdocuments included). */
type FlightSnapshotSource = FlightItinerarySource & {
  cabinClass?: string | null;
  pnr?: string | null;
  passengers?: {
    adults?: number | null;
    children?: number | null;
    infants?: number | null;
  } | null;
};

/**
 * A flight snapshot as plain data, in exactly the
 * `PaymentConsentFlightSnapshot` shape. The one mapper both ways — persisting
 * what the email service built, and reading a stored record back for the
 * hosted page, the admin DTO and the evidence rows — so the frozen itinerary
 * only ever has one shape.
 */
function toFlightSnapshot(f: FlightSnapshotSource): PaymentConsentFlightSnapshot {
  const tripType = normalizeTripType(f.tripType);
  return {
    tripType,
    cabinClass: f.cabinClass ?? "",
    passengers: {
      adults: finiteOrNull(f.passengers?.adults) ?? 1,
      children: finiteOrNull(f.passengers?.children) ?? 0,
      infants: finiteOrNull(f.passengers?.infants) ?? 0,
    },
    pnr: f.pnr ?? null,
    outbound: journeySnapshot(f.outbound),
    return:
      tripType === FlightTripType.ROUND_TRIP ? journeySnapshot(f.return) : null,
    origin: f.origin ?? null,
    destination: f.destination ?? null,
    departureDate: isoOrNull(f.departureDate),
    arrivalDate: isoOrNull(f.arrivalDate),
    returnDate: isoOrNull(f.returnDate),
    airline: f.airline ?? null,
    flightNumber: f.flightNumber ?? null,
  };
}

interface FlightFieldsSource {
  serviceType?: ServiceType | null;
  flight?: FlightSnapshotSource | null;
  airlineFare?: number | null;
  bookingTotal?: number | null;
}

/**
 * The FLIGHT-only keys of a snapshot. Empty for every other service type,
 * so a rental's stored record and DTO keep their exact historic shape.
 */
function flightSnapshotFields(
  s: FlightFieldsSource,
): Pick<PaymentConsentSnapshot, "flight" | "airlineFare" | "bookingTotal"> {
  if (s.serviceType !== ServiceType.FLIGHT) return {};
  return {
    flight: s.flight ? toFlightSnapshot(s.flight) : null,
    airlineFare: amountOrNull(s.airlineFare),
    bookingTotal: amountOrNull(s.bookingTotal),
  };
}

/**
 * The snapshot as it is stored. Identity for every service type but FLIGHT,
 * so a rental is persisted exactly as the email service built it.
 *
 * A flight folds its route into the rental-shaped `vehicle` and location
 * slots, and a long multi-city route can overrun their schema limits. A
 * rejected record is swallowed by the payment-request email, so the customer
 * would silently get no hosted consent link — the slots are clamped instead,
 * and the itinerary itself is plain data the schema cannot reject.
 */
function storableSnapshot(s: PaymentConsentSnapshot): PaymentConsentSnapshot {
  if (s.serviceType !== ServiceType.FLIGHT) return s;
  const pickupDate = isoOrNull(s.pickupDate) ?? new Date().toISOString();
  return {
    ...s,
    vehicle: truncateText(s.vehicle, SNAPSHOT_VEHICLE_MAX_LENGTH),
    pickupDate,
    dropoffDate: isoOrNull(s.dropoffDate) ?? pickupDate,
    pickupLocation: clampText(s.pickupLocation, SNAPSHOT_LOCATION_MAX_LENGTH),
    dropoffLocation: clampText(s.dropoffLocation, SNAPSHOT_LOCATION_MAX_LENGTH),
  };
}

/**
 * A stored snapshot as the API returns it — one mapper for the admin DTO and
 * the public hosted-page view, so the two can never disagree.
 */
function snapshotToDTO(s: PaymentConsentDoc["snapshot"]): PaymentConsentSnapshot {
  return {
    bookingType: s.bookingType as BookingType,
    provider: s.provider,
    serviceType: s.serviceType ?? ServiceType.CAR_RENTAL,
    vehicle: s.vehicle,
    pickupDate: s.pickupDate.toISOString(),
    dropoffDate: s.dropoffDate.toISOString(),
    pickupLocation: s.pickupLocation ?? null,
    dropoffLocation: s.dropoffLocation ?? null,
    amount: s.amount,
    currency: s.currency as Currency,
    charges: (s.charges ?? []).map((c) => ({
      name: c.name,
      amount: c.amount,
      timing: c.timing,
    })),
    dueAtCounter: s.dueAtCounter ?? 0,
    total: s.total ?? s.amount,
    ...flightSnapshotFields(s),
    paymentLinkRef: s.paymentLinkRef ?? null,
  };
}

/** "1. Delhi → Varanasi · Air India • AI123 · departs 2026-10-10 10:30 · arrives 2026-10-10 12:00" */
function segmentEvidenceLine(
  s: FlightSegmentView,
  timeZoneLabel: string | null,
): string {
  const at = (v: LocalDateTime) =>
    [v.date, v.time, timeZoneLabel].filter(Boolean).join(" ");
  return [
    `${s.number}. ${s.origin} → ${s.destination}`,
    segmentCarrier(s),
    s.departure ? `departs ${at(s.departure)}` : "",
    s.arrival ? `arrives ${at(s.arrival)}` : "",
    s.details ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "Layover after flight 1: 2h 30m — Varanasi · Change terminals" */
function layoverEvidenceLine(after: number, l: FlightLayoverView): string {
  const head =
    l.minutes !== null
      ? `Layover after flight ${after}: ${formatDuration(l.minutes)}`
      : `Layover after flight ${after}`;
  return [l.location ? `${head} — ${l.location}` : head, l.notes ?? ""]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The FLIGHT-only part of a consent evidence row: the money split and a
 * compact itinerary — one line per flight and per layover, as the hosted page
 * showed them. (The full structured itinerary is frozen on the consent record
 * itself.) Empty for every other service type, so a rental's evidence row
 * keeps its exact historic shape.
 */
function flightEvidence(s: FlightFieldsSource): Record<string, unknown> {
  if (s.serviceType !== ServiceType.FLIGHT) return {};
  const { flight, airlineFare, bookingTotal } = flightSnapshotFields(s);
  const view = flight ? buildFlightItinerary(flight) : null;
  return {
    airlineFare: airlineFare ?? null,
    bookingTotal: bookingTotal ?? null,
    itinerary:
      flight && view
        ? {
            tripType: view.tripType,
            cabinClass: flight.cabinClass || null,
            passengers: flight.passengers,
            pnr: flight.pnr,
            journeys: view.journeys.map((journey) => ({
              label: journey.label,
              route: journey.route,
              flights: journey.segments.map((segment) =>
                segmentEvidenceLine(segment, journey.timeZoneLabel),
              ),
              layovers: journey.connections.flatMap((c) =>
                c.layover ? [layoverEvidenceLine(c.after, c.layover)] : [],
              ),
            })),
          }
        : null,
  };
}

/**
 * The gateway an organization's next payment link would open — its
 * configured default. Only consulted for an order not yet pinned to a
 * gateway, which an order with a consent request (always sent alongside a
 * live link) practically never is.
 */
async function organizationDefaultGateway(
  organizationId: string | null,
): Promise<PaymentGatewayKey | null> {
  if (!organizationId) return null;
  const org = await Organization.findById(organizationId)
    .select("payments.provider")
    .lean<{ payments?: { provider?: PaymentGatewayKey | null } | null } | null>();
  return org?.payments?.provider ?? null;
}

function consentToDTO(doc: PaymentConsentDoc & { _id: Types.ObjectId | string }): PaymentConsentDTO {
  return {
    id: String(doc._id),
    orderId: String(doc.orderId),
    orderNumber: doc.orderNumber,
    status: doc.status as ConsentStatus,
    method: (doc.method as ConsentMethod | null | undefined) ?? null,
    customerEmail: doc.customerEmail,
    customerName: doc.customerName,
    consentMessage: doc.consentMessage,
    consentEmailSubject: doc.consentEmailSubject ?? null,
    signedName: doc.signedName ?? null,
    snapshot: snapshotToDTO(doc.snapshot),
    requestedAt: doc.requestedAt.toISOString(),
    receivedAt: doc.receivedAt ? doc.receivedAt.toISOString() : null,
    verifiedAt: doc.verifiedAt ? doc.verifiedAt.toISOString() : null,
    verifiedBy: doc.verifiedBy
      ? {
          userId: doc.verifiedBy.userId ? String(doc.verifiedBy.userId) : null,
          name: doc.verifiedBy.name ?? null,
        }
      : null,
    receiptIp: doc.receiptIp ?? null,
    receiptUserAgent: doc.receiptUserAgent ?? null,
    metadata: (doc.metadata as Record<string, unknown> | null | undefined) ?? null,
    createdAt: (doc.createdAt ?? new Date()).toISOString(),
    updatedAt: (doc.updatedAt ?? new Date()).toISOString(),
  };
}

export interface RequestConsentInput {
  orderId: string;
  customerEmail: string;
  customerName: string;
  consentMessage: string;
  consentEmailSubject: string | null;
  snapshot: PaymentConsentSnapshot;
}

export interface RequestConsentResult {
  consent: PaymentConsentDTO;
  token: string;
  consentUrl: string;
}

/**
 * Creates (or revives) a REQUESTED consent record against an order.
 *
 * Idempotent on re-send: if the order already has an outstanding REQUESTED
 * consent, we reuse its id so the existing /consent/:token link in the
 * customer's inbox keeps working. Once the customer has confirmed, a new
 * record is created — old confirmations are immutable.
 */
export async function requestConsent(
  input: RequestConsentInput,
  ctx: { actor: ConsentActor; appUrl: string; request?: RequestContext | null },
): Promise<RequestConsentResult> {
  await connectMongo();

  if (!Types.ObjectId.isValid(input.orderId)) {
    throw new ValidationError("Invalid order id");
  }
  const orderObjectId = new Types.ObjectId(input.orderId);

  const order = await Order.findById(orderObjectId);
  if (!order) throw new NotFoundError("Order not found");
  // Operator-triggered, so it must not reach across organizations. The
  // customer-facing token paths below are deliberately NOT scoped — the
  // customer has no session and the signed token is their credential.
  if (
    !belongsToScope(order.organizationId, await getRequestOrganizationScope())
  ) {
    throw new NotFoundError("Order not found");
  }

  const existing =
    order.consent?.currentConsentId &&
    order.consent.status === ConsentStatus.REQUESTED
      ? await PaymentConsent.findById(order.consent.currentConsentId)
      : null;

  // Single persisted snapshot shape, reused by the create + refresh paths so
  // the frozen record always carries locations + the full charge breakdown
  // (and, for a flight, the itinerary and the airline fare).
  const snapshot = storableSnapshot(input.snapshot);
  const persistedSnapshot = {
    bookingType: snapshot.bookingType,
    provider: snapshot.provider,
    serviceType: snapshot.serviceType ?? ServiceType.CAR_RENTAL,
    vehicle: snapshot.vehicle,
    pickupDate: new Date(snapshot.pickupDate),
    dropoffDate: new Date(snapshot.dropoffDate),
    pickupLocation: snapshot.pickupLocation ?? null,
    dropoffLocation: snapshot.dropoffLocation ?? null,
    amount: snapshot.amount,
    currency: snapshot.currency,
    charges: snapshot.charges ?? [],
    dueAtCounter: snapshot.dueAtCounter ?? 0,
    total: snapshot.total ?? snapshot.amount,
    ...flightSnapshotFields(snapshot),
    paymentLinkRef: snapshot.paymentLinkRef ?? null,
  };

  let doc: PaymentConsentDoc & { _id: Types.ObjectId };
  if (existing) {
    // Refresh the snapshot in case the agent edited the order between
    // sends — the customer should always see the latest details.
    existing.customerEmail = input.customerEmail;
    existing.customerName = input.customerName;
    existing.consentMessage = input.consentMessage;
    existing.consentEmailSubject = input.consentEmailSubject;
    existing.snapshot = persistedSnapshot;
    existing.requestedAt = new Date();
    await existing.save();
    doc = existing as unknown as PaymentConsentDoc & { _id: Types.ObjectId };
  } else {
    const created = await PaymentConsent.create({
      // Inherit from the order, so a record created on a customer/webhook
      // path still belongs to the right tenant.
      organizationId: order.organizationId ?? null,
      orderId: orderObjectId,
      orderNumber: order.orderNumber,
      status: ConsentStatus.REQUESTED,
      customerEmail: input.customerEmail,
      customerName: input.customerName,
      consentMessage: input.consentMessage,
      consentEmailSubject: input.consentEmailSubject,
      snapshot: persistedSnapshot,
      requestedAt: new Date(),
    });
    doc = created as unknown as PaymentConsentDoc & { _id: Types.ObjectId };
  }

  // Point the order at the fresh request, but DO NOT downgrade a previous
  // RECEIVED/VERIFIED status — a re-send shouldn't erase prior consent.
  const shouldPromote =
    order.consent?.status !== ConsentStatus.RECEIVED &&
    order.consent?.status !== ConsentStatus.VERIFIED;
  if (shouldPromote) {
    order.consent = {
      ...order.consent,
      status: ConsentStatus.REQUESTED,
      currentConsentId: doc._id,
      requestedAt: doc.requestedAt,
    };
    await order.save();
  } else {
    // Already received — still track that we re-requested in case ops needs
    // to see the resend history, but keep the dominant status.
    order.consent.requestedAt = doc.requestedAt;
    await order.save();
  }

  await recordAudit({
    action: AuditAction.CONSENT_REQUESTED,
    entityType: AuditEntity.CONSENT,
    entityId: String(doc._id),
    actor: {
      userId: ctx.actor.id,
      name: ctx.actor.name,
      email: ctx.actor.email,
      role: ctx.actor.role,
    },
    request: ctx.request ?? null,
    metadata: {
      orderId: String(orderObjectId),
      orderNumber: order.orderNumber,
      customerEmail: input.customerEmail,
      resend: Boolean(existing),
    },
  });

  const token = generateConsentToken(String(doc._id));
  const consentUrl = buildConsentUrl(ctx.appUrl, token);

  // Evidence chain: record what we asked the customer to acknowledge.
  // The raw token is sensitive (anyone with it can submit consent), so
  // we persist a SHA-256 hash of it for lookup, not the token itself.
  await captureEvidenceSafe({
    orderId: String(orderObjectId),
    orderNumber: order.orderNumber,
    eventType: OrderEvidenceEventType.CONSENT_REQUESTED,
    actor: {
      type: OrderEvidenceActorType.AGENT,
      userId: ctx.actor.id,
      name: ctx.actor.name,
      email: ctx.actor.email,
      role: ctx.actor.role,
    },
    request: ctx.request ?? null,
    payload: {
      consentId: String(doc._id),
      consentEmailSubject: input.consentEmailSubject,
      consentMessage: input.consentMessage,
      method: ConsentMethod.HOSTED_PAGE,
      resend: Boolean(existing),
      snapshot: {
        bookingType: snapshot.bookingType,
        provider: snapshot.provider,
        serviceType: snapshot.serviceType ?? ServiceType.CAR_RENTAL,
        vehicle: snapshot.vehicle,
        pickupDate: new Date(snapshot.pickupDate).toISOString(),
        dropoffDate: new Date(snapshot.dropoffDate).toISOString(),
        amount: snapshot.amount,
        currency: snapshot.currency,
        ...flightEvidence(snapshot),
        paymentLinkRef: snapshot.paymentLinkRef ?? null,
      },
    },
    refs: {
      consentId: String(doc._id),
      consentTokenHash: hashConsentToken(token),
      customerEmail: input.customerEmail,
    },
  });

  return { consent: consentToDTO(doc), token, consentUrl };
}

async function loadConsentByTokenOrThrow(token: string) {
  await connectMongo();
  const { consentId } = parseConsentToken(token);
  if (!Types.ObjectId.isValid(consentId)) {
    throw new BadRequestError("Invalid consent token");
  }
  const doc = await PaymentConsent.findById(consentId);
  if (!doc) throw new NotFoundError("Consent record not found");
  return doc;
}

/**
 * Load a consent record for the public-facing hosted page. Returns the
 * trimmed view shape so we never leak audit metadata (IP, UA, verifier)
 * to the customer.
 */
export async function getPublicConsentView(
  token: string,
  branding: { brandName: string; supportEmail?: string; supportPhone?: string },
): Promise<PublicConsentView> {
  const doc = await loadConsentByTokenOrThrow(token);
  await connectMongo();
  const order = await Order.findById(doc.orderId).lean();
  // Brand from the booking's organization. The caller used to pass the
  // deployment singleton straight through, so a customer who was emailed by
  // one brand was asked to confirm a booking under another brand's name.
  const organizationId = order?.organizationId
    ? String(order.organizationId)
    : null;
  const brand = await resolvePublicBrand(organizationId, {
    brandName: branding.brandName,
    supportEmail: branding.supportEmail ?? "",
    supportPhone: branding.supportPhone ?? "",
  });
  // Name the processor the payment link actually opens. The page used to say
  // "Stripe" to every brand, including the ones that take PayPal.
  const gateway =
    order?.payment?.gateway ?? (await organizationDefaultGateway(organizationId));
  return {
    status: doc.status as ConsentStatus,
    customerName: doc.customerName,
    customerEmail: doc.customerEmail,
    brandName: brand.brandName,
    organizationId,
    consentMessage: doc.consentMessage,
    snapshot: snapshotToDTO(doc.snapshot),
    paymentUrl: order?.payment?.checkoutUrl ?? null,
    gatewayLabel: gateway ? PaymentGatewayLabel[gateway] : null,
    alreadyConfirmedAt: doc.receivedAt ? doc.receivedAt.toISOString() : null,
  };
}

export interface RecordConsentInput {
  token: string;
  signedName?: string | null;
  /** Verbatim acknowledgement statement the customer confirmed. Echo of
   *  what the page rendered — we re-verify it matches the stored message
   *  to guard against tampering. */
  acknowledgement: string;
  method?: ConsentMethod;
}

/**
 * Public endpoint: record the customer's confirmation on the hosted page.
 * Always returns the trimmed PublicConsentView so the page can transition
 * straight into the "thanks, proceed to payment" state.
 */
export async function recordConsentFromToken(
  input: RecordConsentInput,
  ctx: { request?: RequestContext | null; branding: { brandName: string } },
): Promise<PublicConsentView> {
  const doc = await loadConsentByTokenOrThrow(input.token);

  if (
    input.acknowledgement.trim().toLowerCase() !==
    doc.consentMessage.trim().toLowerCase()
  ) {
    // Echo mismatch — refuse rather than silently accepting tampered copy.
    throw new BadRequestError("Acknowledgement statement does not match");
  }

  // Idempotent: a refresh or rapid double-click after the customer
  // already confirmed just returns the existing state. The replay path
  // is intentionally tolerant of a missing signature.
  if (doc.status === ConsentStatus.RECEIVED || doc.status === ConsentStatus.VERIFIED) {
    return getPublicConsentView(input.token, ctx.branding);
  }

  // First-time transition: a signature IS required. The UI enforces this
  // client-side; the server re-checks so a hand-rolled curl can't slip
  // an empty signature past us.
  const trimmedSignature = input.signedName?.trim() ?? "";
  if (trimmedSignature.length < 2) {
    throw new BadRequestError("Please type your full name as a digital signature.");
  }

  // Customer submission IS the verification — there is no separate admin
  // verify step any more. The hosted page is the only path; the customer
  // typed their name as a digital signature against the same message we
  // displayed, captured server-side with IP + user-agent. That's the
  // dispute-grade record. Stamp `receivedAt` and `verifiedAt` to the
  // same moment so the timeline reads cleanly either way.
  const now = new Date();
  doc.status = ConsentStatus.VERIFIED;
  doc.method = input.method ?? ConsentMethod.HOSTED_PAGE;
  doc.receivedAt = now;
  doc.verifiedAt = now;
  doc.receiptIp = ctx.request?.ip ?? null;
  doc.receiptUserAgent = ctx.request?.userAgent ?? null;
  doc.signedName = trimmedSignature.slice(0, 120);
  await doc.save();

  await Order.updateOne(
    { _id: doc.orderId },
    {
      $set: {
        "consent.status": ConsentStatus.VERIFIED,
        "consent.currentConsentId": doc._id,
        "consent.receivedAt": doc.receivedAt,
        "consent.verifiedAt": doc.verifiedAt,
        "consent.method": doc.method,
      },
    },
  );

  await recordAudit({
    action: AuditAction.CONSENT_RECEIVED,
    entityType: AuditEntity.CONSENT,
    entityId: String(doc._id),
    actor: {
      // Customer-side action — actor.userId is intentionally null. We
      // attribute via the email on the consent record.
      userId: null,
      name: doc.customerName,
      email: doc.customerEmail,
      role: null,
    },
    request: ctx.request ?? null,
    metadata: {
      method: doc.method,
      signedName: doc.signedName,
      orderId: String(doc.orderId),
      orderNumber: doc.orderNumber,
    },
  });

  // Evidence chain: this is the strongest single piece of dispute
  // defense — the customer typed their name against the same statement
  // the page displayed, captured server-side with IP + UA at receipt
  // time. We persist all of it including the hashed token so a future
  // search by token lands on this event.
  await captureEvidenceSafe({
    orderId: String(doc.orderId),
    orderNumber: doc.orderNumber,
    eventType: OrderEvidenceEventType.CONSENT_RECEIVED,
    occurredAt: doc.receivedAt ?? now,
    actor: {
      type: OrderEvidenceActorType.CUSTOMER,
      name: doc.customerName,
      email: doc.customerEmail,
    },
    request: ctx.request ?? null,
    payload: {
      consentId: String(doc._id),
      method: doc.method,
      signedName: doc.signedName,
      acknowledgement: input.acknowledgement,
      consentMessage: doc.consentMessage,
      snapshot: {
        bookingType: doc.snapshot.bookingType,
        provider: doc.snapshot.provider,
        serviceType: doc.snapshot.serviceType ?? ServiceType.CAR_RENTAL,
        vehicle: doc.snapshot.vehicle,
        pickupDate: doc.snapshot.pickupDate.toISOString(),
        dropoffDate: doc.snapshot.dropoffDate.toISOString(),
        amount: doc.snapshot.amount,
        currency: doc.snapshot.currency,
        ...flightEvidence(doc.snapshot),
        paymentLinkRef: doc.snapshot.paymentLinkRef ?? null,
      },
      receivedAt: (doc.receivedAt ?? now).toISOString(),
      verifiedAt: (doc.verifiedAt ?? now).toISOString(),
    },
    refs: {
      consentId: String(doc._id),
      consentTokenHash: hashConsentToken(input.token),
      customerEmail: doc.customerEmail,
      signatureName: doc.signedName ?? null,
    },
  });

  // Realtime push so the agent's order detail page flips the "Consent
  // received" timeline node instantly. Audience is the order creator —
  // the SSE filter widens it to admins.
  const owner = await Order.findById(doc.orderId)
    .select({ "createdBy.userId": 1, orderNumber: 1 })
    .lean<{ createdBy: { userId: Types.ObjectId } }>();
  if (owner?.createdBy?.userId) {
    logger.info("order.lifecycle.transition", {
      orderId: String(doc.orderId),
      orderNumber: doc.orderNumber,
      previousState: "REQUESTED",
      nextState: "VERIFIED",
      transition: "consent_received",
      source: "service.consent.hosted_page",
    });
    publishEvent({
      type: DomainEventType.ORDER_CONSENT_RECEIVED,
      audience: { kind: "creator", userId: String(owner.createdBy.userId) },
      payload: {
        orderId: String(doc.orderId),
        orderNumber: doc.orderNumber,
        customerName: doc.customerName,
        method: doc.method,
      },
    });
  }

  return getPublicConsentView(input.token, ctx.branding);
}

/**
 * Admin action: lock a RECEIVED consent record as dispute-grade evidence.
 * Only the consent itself moves to VERIFIED — we don't retroactively
 * mutate the customer-facing copy or timestamps.
 */
export async function verifyConsent(
  consentId: string,
  ctx: { actor: ConsentActor; request?: RequestContext | null },
): Promise<PaymentConsentDTO> {
  if (!roleHasPermission(ctx.actor.role, Permission.CONSENT_VERIFY)) {
    throw new ForbiddenError("You do not have permission to verify consent");
  }
  await connectMongo();
  if (!Types.ObjectId.isValid(consentId)) {
    throw new ValidationError("Invalid consent id");
  }
  const doc = await PaymentConsent.findById(consentId);
  if (!doc) throw new NotFoundError("Consent record not found");
  if (!belongsToScope(doc.organizationId, await getRequestOrganizationScope())) {
    throw new NotFoundError("Consent record not found");
  }
  if (doc.status === ConsentStatus.NOT_REQUESTED) {
    throw new ConflictError("Cannot verify a consent that was never requested");
  }
  if (doc.status === ConsentStatus.REQUESTED) {
    throw new ConflictError(
      "Customer has not yet confirmed — wait for the hosted page click",
    );
  }
  if (doc.status === ConsentStatus.VERIFIED) {
    return consentToDTO(doc);
  }
  doc.status = ConsentStatus.VERIFIED;
  doc.verifiedAt = new Date();
  doc.verifiedBy = {
    userId: new Types.ObjectId(ctx.actor.id),
    name: ctx.actor.name,
  };
  await doc.save();

  await Order.updateOne(
    { _id: doc.orderId },
    {
      $set: {
        "consent.status": ConsentStatus.VERIFIED,
        "consent.verifiedAt": doc.verifiedAt,
      },
    },
  );

  await recordAudit({
    action: AuditAction.CONSENT_VERIFIED,
    entityType: AuditEntity.CONSENT,
    entityId: String(doc._id),
    actor: {
      userId: ctx.actor.id,
      name: ctx.actor.name,
      email: ctx.actor.email,
      role: ctx.actor.role,
    },
    request: ctx.request ?? null,
    metadata: {
      orderId: String(doc.orderId),
      orderNumber: doc.orderNumber,
    },
  });

  await captureEvidenceSafe({
    orderId: String(doc.orderId),
    orderNumber: doc.orderNumber,
    eventType: OrderEvidenceEventType.CONSENT_VERIFIED,
    occurredAt: doc.verifiedAt ?? new Date(),
    actor: {
      type: OrderEvidenceActorType.AGENT,
      userId: ctx.actor.id,
      name: ctx.actor.name,
      email: ctx.actor.email,
      role: ctx.actor.role,
    },
    request: ctx.request ?? null,
    payload: {
      consentId: String(doc._id),
      verifiedAt: (doc.verifiedAt ?? new Date()).toISOString(),
      signedName: doc.signedName,
    },
    refs: {
      consentId: String(doc._id),
      customerEmail: doc.customerEmail,
      signatureName: doc.signedName ?? null,
    },
  });

  return consentToDTO(doc);
}

/** List all consent records associated with an order (history view). */
export async function listConsentsForOrder(
  orderId: string,
  ctx: { actor: ConsentActor },
): Promise<PaymentConsentDTO[]> {
  if (!roleHasPermission(ctx.actor.role, Permission.CONSENT_VIEW)) {
    throw new ForbiddenError("You do not have permission to view consent records");
  }
  await connectMongo();
  if (!Types.ObjectId.isValid(orderId)) return [];
  const docs = await PaymentConsent.find(
    withOrganizationScope(
      { orderId: new Types.ObjectId(orderId) },
      await getRequestOrganizationScope(),
    ),
  )
    .sort({ createdAt: -1 })
    .lean();
  return docs.map((d) =>
    consentToDTO(d as unknown as PaymentConsentDoc & { _id: Types.ObjectId }),
  );
}

export async function getConsentById(
  consentId: string,
  ctx: { actor: ConsentActor },
): Promise<PaymentConsentDTO> {
  if (!roleHasPermission(ctx.actor.role, Permission.CONSENT_VIEW)) {
    throw new ForbiddenError("You do not have permission to view consent records");
  }
  await connectMongo();
  if (!Types.ObjectId.isValid(consentId)) {
    throw new ValidationError("Invalid consent id");
  }
  const doc = await PaymentConsent.findById(consentId);
  if (!doc) throw new NotFoundError("Consent record not found");
  if (!belongsToScope(doc.organizationId, await getRequestOrganizationScope())) {
    throw new NotFoundError("Consent record not found");
  }
  return consentToDTO(doc as unknown as PaymentConsentDoc & { _id: Types.ObjectId });
}

/** Best-effort audit row for "payment after consent" — fires from the
 *  Stripe webhook path when an order with a RECEIVED/VERIFIED consent
 *  finishes payment. Operational signal only; never throws. */
export async function recordPaymentAfterConsent(
  orderId: string,
  context: {
    consentStatus: ConsentStatus;
    consentId: string | null;
    orderNumber: string;
  },
): Promise<void> {
  try {
    await recordAudit({
      action: AuditAction.PAYMENT_SUCCEEDED,
      entityType: AuditEntity.CONSENT,
      entityId: context.consentId,
      metadata: {
        orderId,
        orderNumber: context.orderNumber,
        consentStatus: context.consentStatus,
        note: "payment_after_consent",
      },
    });
  } catch (err) {
    logger.warn("consent.audit_payment_after_consent_failed", {
      orderId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
