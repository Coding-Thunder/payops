/* eslint-disable no-console */
/**
 * Seed: Aurora staging fixture — a complete rental-car lifecycle
 * (order → consent → payment → dispute → win) loaded into the
 * staging database so the UI can be screenshotted, walked through,
 * and shown to prospects without depending on real customer data.
 *
 * Safety guarantees:
 *
 *   1. Refuses to run against the prod database name `payops` unless
 *      the caller explicitly passes `--unsafe-prod`. Default target
 *      is `payops-staging` on the same Atlas cluster.
 *   2. Idempotent — if order `ORD-260805-K4M9P2RT3W` already exists,
 *      the script exits cleanly without re-seeding.
 *   3. Operator user "Mira Holst" is created with an unguessable
 *      bcrypt password (hash of `crypto.randomUUID()`); no one can
 *      log in as her even if the database is exposed.
 *   4. Real Stripe / SMTP integrations are NEVER contacted — the
 *      script writes Mongoose docs directly. No external traffic.
 *
 * Usage:
 *
 *   npm run seed:aurora                         # safe default
 *   npx tsx --env-file=.env.prod ... --unsafe-prod   # force prod write
 */

import { createHash, randomUUID } from "node:crypto";

import bcrypt from "bcryptjs";
import { Types } from "mongoose";

// Type-only imports — stripped at compile, no runtime side effects.
import type {
  OrderEvidenceActorType,
  OrderEvidenceEventType,
  UserRole,
} from "../src/lib/constants/enums";

/* ───────────────────── Env override + safety guards ────────────────────── */

const PROD_DB_NAME = "payops";
const DEFAULT_STAGING_DB_NAME = "payops-staging";
const FIXTURE_ORDER_NUMBER = "ORD-260805-K4M9P2RT3W";

const args = new Set(process.argv.slice(2));
const allowProd = args.has("--unsafe-prod");
const envDb = process.env.MONGODB_DB;

let targetDb: string;
if (allowProd) {
  targetDb = envDb ?? PROD_DB_NAME;
  if (targetDb === PROD_DB_NAME) {
    console.warn(
      "\n⚠  --unsafe-prod is set. This WILL write to the prod database `payops`.\n",
    );
  }
} else {
  targetDb =
    envDb && envDb !== PROD_DB_NAME ? envDb : DEFAULT_STAGING_DB_NAME;
  if (envDb === PROD_DB_NAME) {
    console.log(
      `  ↪ MONGODB_DB was "${PROD_DB_NAME}" (prod); auto-overriding to "${DEFAULT_STAGING_DB_NAME}" for safety.`,
    );
  }
}

process.env.MONGODB_DB = targetDb;

if (process.env.MONGODB_URI) {
  const rewritten = process.env.MONGODB_URI.replace(
    /\/[^/?]+(\?|$)/,
    `/${targetDb}$1`,
  );
  process.env.MONGODB_URI = rewritten;
}

process.env.PAYOPS_TEST_MODE = "integration";

console.log(`\n› Seed target: db=${targetDb}`);

/* ───────────────────────────── Scenario data ───────────────────────────── */

// Anchor the scenario to "47 days ago" so the timeline reads as a
// recently-resolved dispute.
const DAY_0 = new Date(Date.now() - 47 * 24 * 60 * 60 * 1000);
const at = (dayOffset: number, hour: number, minute = 0, second = 0) =>
  new Date(
    DAY_0.getTime() +
      dayOffset * 24 * 60 * 60 * 1000 +
      hour * 60 * 60 * 1000 +
      minute * 60 * 1000 +
      second * 1000,
  );

const SCENARIO = {
  order: {
    number: FIXTURE_ORDER_NUMBER,
    amount: 2840,
    currency: "USD" as const,
    customer: {
      // example.com is reserved by IANA (RFC 2606) for documentation,
      // so the address can never collide with a real inbox. Reads as
      // a normal email in the UI.
      name: "Talia M. Berenson",
      email: "talia.berenson@example.com",
      phone: "+1-555-0142",
    },
    provider: "BUDGET" as const,
    providerLogo: "/providers/budget.png",
    vehicle: {
      company: "Toyota",
      type: "Camry XLE 2025",
      // Stable Unsplash CDN URL — neutral silver sedan.
      imageUrl:
        "https://images.unsplash.com/photo-1621007947382-bb3c3994e3fb?auto=format&fit=crop&w=1200&q=80" as string | null,
    },
    trip: {
      pickupDate: at(0, 14, 2),
      dropoffDate: at(4, 17, 32),
    },
    policy: {
      acceptedAt: at(0, 14, 2),
      version: "v3.2",
      text:
        "Budget Rent A Car cancellation & no-show policy v3.2 (effective 2025-11-01). " +
        "Cancellations more than 24 hours before pick-up are fully refundable. " +
        "Same-day cancellations and no-shows are charged the full first-day rate. " +
        "Disputes are governed by the merchant's chosen payment processor's rules.",
    },
  },
  // Stripe-style sandbox identifiers — match the prefix conventions
  // Stripe uses for test mode (cs_test_, pi_, evt_, etc.) so the
  // values look like legitimate gateway IDs in admin views.
  payment: {
    sessionId: "cs_test_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6",
    paymentIntentId: "pi_3R7kx2KZ4mN8AbCdEfGhIjKl",
    chargeId: "ch_3R7kx2KZ4mN8QYr5d7K9pLm",
    checkoutUrl:
      "https://checkout.stripe.com/c/pay/cs_test_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6",
    paidAt: at(0, 14, 10),
    confirmationEmailSentAt: at(0, 14, 10),
    gatewayEventId_completed: "evt_3R7kx2KZ4mN8AB1234CdEf",
  },
  consent: {
    signedName: "Talia M. Berenson",
    consentMessage:
      "I authorize Budget Rent A Car to charge $2,840.00 USD to my payment method on file " +
      "for the rental of a Toyota Camry XLE 2025. " +
      "I have reviewed the cancellation and no-show policy dated 2025-11-01 (v3.2) and agree to its terms.",
    consentEmailSubject:
      "Budget · Confirm your Toyota Camry rental · ORD-260805-K4M9P2RT3W",
    requestedAt: at(0, 14, 3),
    receivedAt: at(0, 14, 9, 47),
    verifiedAt: at(0, 14, 9, 47),
    ip: "73.114.142.18",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  },
  dispute: {
    gatewayDisputeId: "du_1Q9PqRsTuVwXyZ1A2B3C4D",
    reason: "product_not_received",
    openedAt: at(33, 11, 8),
    updatedAt: at(38, 4, 51),
    closedAt: at(41, 9, 17),
    evidenceDueAt: at(47, 23, 59),
    gatewayEventId_created: "evt_4S8mq9PA7nQ2DEF5678GhIj",
    gatewayEventId_updated: "evt_5T9np0QB8oR3GHI9012KlMn",
    gatewayEventId_closed: "evt_6U0op1RC9pS4JKL3456OpQr",
  },
  operator: {
    name: "Mira Holst",
    email: "mira.holst@example.com",
    role: "ADMIN" as const,
  },
  operatorNote:
    "First-time customer. Confirmed pick-up window 14:00–16:00 PT via email follow-up. Insurance + GPS add-ons included.",
};

/* ───────────────────────────── Seed runner ─────────────────────────────── */

async function main() {
  // Dynamic imports — fire AFTER env overrides above land in
  // process.env. tsx compiles to CJS which forbids top-level await,
  // so the imports live inside main().
  const { connectMongo, disconnectMongo } = await import(
    "../src/server/db/mongoose"
  );
  const { Order } = await import("../src/server/db/models/order.model");
  const { User } = await import("../src/server/db/models/user.model");
  const { PaymentConsent } = await import(
    "../src/server/db/models/payment-consent.model"
  );
  const { Dispute } = await import("../src/server/db/models/dispute.model");
  const { AuditLog } = await import("../src/server/db/models/audit-log.model");
  const { PendingEmail, PendingEmailStatus } = await import(
    "../src/server/db/models/outbox.model"
  );
  const { OrderEvidence } = await import(
    "../src/server/db/models/order-evidence.model"
  );
  const { computeEvidenceHash } = await import(
    "../src/lib/crypto/hash-chain"
  );
  const {
    AuditAction,
    AuditEntity,
    BookingType,
    ConsentMethod,
    ConsentStatus,
    DisputeOutcome,
    DisputeStatus,
    EmailKind,
    OrderEvidenceActorType,
    OrderEvidenceEventType,
    OrderStatus,
    PaymentGatewayKey,
    RecordState,
    UserRole,
  } = await import("../src/lib/constants/enums");
  void AuditEntity;

  globalThis.__seedDisconnect = disconnectMongo;

  await connectMongo();

  const existing = await Order.findOne({ orderNumber: FIXTURE_ORDER_NUMBER });
  if (existing) {
    console.log(
      `\n✓ Order ${FIXTURE_ORDER_NUMBER} already exists (id=${existing._id}). Skipping.\n`,
    );
    await disconnectMongo();
    process.exit(0);
  }

  // ── Inline evidence-chain primitives ─────────────────────────────
  // Re-implement the helpers from evidence.service.ts that we need.
  // The service file itself imports `server-only` which throws
  // outside a Next runtime; the underlying hash-chain primitives
  // have no such restriction.
  const hashConsentToken = (token: string) =>
    createHash("sha256").update(token).digest("hex");

  interface EvidenceWriteInput {
    orderId: string;
    orderNumber: string;
    eventType: OrderEvidenceEventType;
    occurredAt: Date;
    actor: {
      type: OrderEvidenceActorType;
      userId?: string | null;
      name?: string | null;
      email?: string | null;
      role?: UserRole | null;
    };
    request?: {
      ip?: string | null;
      userAgent?: string | null;
      requestId?: string | null;
    } | null;
    payload: Record<string, unknown>;
    refs?: Record<string, string | null | undefined> | null;
  }

  async function appendEvidence(input: EvidenceWriteInput) {
    const orderObjectId = new Types.ObjectId(input.orderId);
    const latest = await OrderEvidence.findOne({ orderId: orderObjectId })
      .sort({ sequence: -1 })
      .select({ sequence: 1, hash: 1 })
      .lean<{ sequence: number; hash: string }>();
    const sequence = (latest?.sequence ?? 0) + 1;
    const previousHash = latest?.hash ?? null;
    const normalisedPayload = JSON.parse(
      JSON.stringify(input.payload),
    ) as Record<string, unknown>;
    const { snapshotHash, hash } = computeEvidenceHash({
      previousHash,
      orderId: input.orderId,
      sequence,
      eventType: input.eventType,
      occurredAt: input.occurredAt,
      payload: normalisedPayload,
    });

    const refs = input.refs
      ? {
          paymentSessionId: input.refs.paymentSessionId ?? null,
          paymentIntentId: input.refs.paymentIntentId ?? null,
          transactionId: input.refs.transactionId ?? null,
          gatewayEventId: input.refs.gatewayEventId ?? null,
          consentId: input.refs.consentId ?? null,
          consentTokenHash: input.refs.consentTokenHash ?? null,
          customerEmail: input.refs.customerEmail
            ? input.refs.customerEmail.toLowerCase()
            : null,
          signatureName: input.refs.signatureName ?? null,
          messageId: input.refs.messageId ?? null,
        }
      : null;

    await OrderEvidence.create({
      orderId: orderObjectId,
      orderNumber: input.orderNumber,
      sequence,
      eventType: input.eventType,
      occurredAt: input.occurredAt,
      actor: {
        type: input.actor.type,
        userId: input.actor.userId
          ? new Types.ObjectId(input.actor.userId)
          : null,
        name: input.actor.name ?? null,
        email: input.actor.email ?? null,
        role: input.actor.role ?? null,
      },
      request: input.request
        ? {
            ip: input.request.ip ?? null,
            userAgent: input.request.userAgent ?? null,
            requestId: input.request.requestId ?? null,
            geoCountry: null,
          }
        : null,
      payload: normalisedPayload,
      refs,
      snapshotHash,
      previousHash,
      hash,
    });
  }

  console.log(`\n› Seeding Aurora scenario into db=${targetDb}…`);

  /* ── 1. Operator user (Mira) ───────────────────────────────────────── */

  const operatorPasswordHash = await bcrypt.hash(
    randomUUID() + randomUUID(),
    10,
  );
  const mira = await User.create({
    name: SCENARIO.operator.name,
    email: SCENARIO.operator.email,
    passwordHash: operatorPasswordHash,
    role: SCENARIO.operator.role,
    status: RecordState.ACTIVE,
    createdAt: at(-30, 9, 0),
    updatedAt: at(-30, 9, 0),
  });
  console.log(`  ✓ Created operator: ${mira.name} (${mira._id})`);

  /* ── 2. Order document ─────────────────────────────────────────────── */

  const orderId = new Types.ObjectId();
  await Order.collection.insertOne({
    _id: orderId,
    orderNumber: FIXTURE_ORDER_NUMBER,
    bookingType: BookingType.NEW_BOOKING,
    status: OrderStatus.PAID,
    state: RecordState.ACTIVE,
    customer: { ...SCENARIO.order.customer },
    provider: {
      id: SCENARIO.order.provider,
      name: "Budget",
      logo: SCENARIO.order.providerLogo,
      primaryColor: "#FF6900",
      onPrimaryColor: "#FFFFFF",
    },
    vehicle: { ...SCENARIO.order.vehicle },
    trip: { ...SCENARIO.order.trip },
    pricing: {
      amount: SCENARIO.order.amount,
      currency: SCENARIO.order.currency,
    },
    payment: {
      gateway: PaymentGatewayKey.STRIPE,
      stripeSessionId: SCENARIO.payment.sessionId,
      paymentIntentId: SCENARIO.payment.paymentIntentId,
      checkoutUrl: SCENARIO.payment.checkoutUrl,
      status: OrderStatus.PAID,
      paidAt: SCENARIO.payment.paidAt,
      expiresAt: at(1, 14, 2),
      initiatedAt: at(0, 14, 2, 18),
      amountReceived: SCENARIO.order.amount,
      receiptUrl: null,
      failureReason: null,
      confirmationEmailSentAt: SCENARIO.payment.confirmationEmailSentAt,
      processedWebhookEventIds: [
        SCENARIO.payment.gatewayEventId_completed,
      ],
    },
    createdBy: {
      userId: mira._id,
      name: mira.name,
      email: mira.email,
    },
    policy: { ...SCENARIO.order.policy },
    risk: {
      flagged: false,
      flaggedNote: null,
      flaggedAt: null,
      flaggedBy: null,
    },
    consent: {
      status: ConsentStatus.VERIFIED,
      currentConsentId: null,
      requestedAt: SCENARIO.consent.requestedAt,
      receivedAt: SCENARIO.consent.receivedAt,
      verifiedAt: SCENARIO.consent.verifiedAt,
      method: ConsentMethod.HOSTED_PAGE,
    },
    dispute: {
      status: DisputeStatus.WON,
      currentDisputeId: null,
      openedAt: SCENARIO.dispute.openedAt,
      closedAt: SCENARIO.dispute.closedAt,
      outcome: DisputeOutcome.WON,
      reason: SCENARIO.dispute.reason,
      amount: SCENARIO.order.amount,
      currency: SCENARIO.order.currency,
    },
    refundedAmount: 0,
    notes: SCENARIO.operatorNote,
    createdAt: at(0, 14, 2),
    updatedAt: at(41, 9, 32),
  });
  console.log(`  ✓ Created order: ${FIXTURE_ORDER_NUMBER} (${orderId})`);

  /* ── 3. PaymentConsent ──────────────────────────────────────────────── */

  const consentDoc = await PaymentConsent.create({
    orderId,
    orderNumber: FIXTURE_ORDER_NUMBER,
    status: ConsentStatus.VERIFIED,
    method: ConsentMethod.HOSTED_PAGE,
    customerEmail: SCENARIO.order.customer.email,
    customerName: SCENARIO.order.customer.name,
    consentMessage: SCENARIO.consent.consentMessage,
    consentEmailSubject: SCENARIO.consent.consentEmailSubject,
    signedName: SCENARIO.consent.signedName,
    snapshot: {
      bookingType: BookingType.NEW_BOOKING,
      provider: "Budget Rent A Car",
      vehicle: `${SCENARIO.order.vehicle.company} ${SCENARIO.order.vehicle.type}`,
      pickupDate: SCENARIO.order.trip.pickupDate,
      dropoffDate: SCENARIO.order.trip.dropoffDate,
      amount: SCENARIO.order.amount,
      currency: SCENARIO.order.currency,
      paymentLinkRef: SCENARIO.payment.checkoutUrl,
    },
    requestedAt: SCENARIO.consent.requestedAt,
    receivedAt: SCENARIO.consent.receivedAt,
    verifiedAt: SCENARIO.consent.verifiedAt,
    receiptIp: SCENARIO.consent.ip,
    receiptUserAgent: SCENARIO.consent.userAgent,
    metadata: null,
    createdAt: SCENARIO.consent.requestedAt,
    updatedAt: SCENARIO.consent.verifiedAt,
  });
  await Order.collection.updateOne(
    { _id: orderId },
    { $set: { "consent.currentConsentId": consentDoc._id } },
  );
  console.log(`  ✓ Created consent: VERIFIED, signed "${SCENARIO.consent.signedName}"`);

  /* ── 4. Dispute ─────────────────────────────────────────────────────── */

  const disputeDoc = await Dispute.create({
    orderId,
    orderNumber: FIXTURE_ORDER_NUMBER,
    gateway: PaymentGatewayKey.STRIPE,
    gatewayDisputeId: SCENARIO.dispute.gatewayDisputeId,
    chargeId: SCENARIO.payment.chargeId,
    paymentIntentId: SCENARIO.payment.paymentIntentId,
    status: DisputeStatus.WON,
    reason: SCENARIO.dispute.reason,
    outcome: DisputeOutcome.WON,
    amount: SCENARIO.order.amount,
    amountMinor: SCENARIO.order.amount * 100,
    currency: SCENARIO.order.currency,
    evidenceDueAt: SCENARIO.dispute.evidenceDueAt,
    openedAt: SCENARIO.dispute.openedAt,
    closedAt: SCENARIO.dispute.closedAt,
    processedWebhookEventIds: [
      SCENARIO.dispute.gatewayEventId_created,
      SCENARIO.dispute.gatewayEventId_updated,
      SCENARIO.dispute.gatewayEventId_closed,
    ],
    createdAt: SCENARIO.dispute.openedAt,
    updatedAt: SCENARIO.dispute.closedAt,
  });
  await Order.collection.updateOne(
    { _id: orderId },
    { $set: { "dispute.currentDisputeId": disputeDoc._id } },
  );
  console.log(`  ✓ Created dispute: WON, opened day 33, closed day 41`);

  /* ── 5. Hash-chained OrderEvidence (9 events) ───────────────────────── */

  const orderIdStr = String(orderId);
  const evidenceActorAgent = {
    type: OrderEvidenceActorType.AGENT,
    userId: String(mira._id),
    name: mira.name,
    email: mira.email,
    role: UserRole.ADMIN,
  };
  const evidenceActorCustomer = {
    type: OrderEvidenceActorType.CUSTOMER,
    name: SCENARIO.order.customer.name,
    email: SCENARIO.order.customer.email,
  };
  const evidenceActorGateway = {
    type: OrderEvidenceActorType.GATEWAY,
    name: "stripe.webhook",
  };
  const evidenceActorSystem = {
    type: OrderEvidenceActorType.SYSTEM,
    name: "Email composer",
  };

  // 1 — ORDER_CREATED
  await appendEvidence({
    orderId: orderIdStr,
    orderNumber: FIXTURE_ORDER_NUMBER,
    eventType: OrderEvidenceEventType.ORDER_CREATED,
    occurredAt: at(0, 14, 2),
    actor: evidenceActorAgent,
    payload: {
      orderNumber: FIXTURE_ORDER_NUMBER,
      bookingType: BookingType.NEW_BOOKING,
      customer: SCENARIO.order.customer,
      vehicle: SCENARIO.order.vehicle,
      pricing: {
        amount: SCENARIO.order.amount,
        currency: SCENARIO.order.currency,
      },
      policy: {
        version: SCENARIO.order.policy.version,
        text: SCENARIO.order.policy.text,
      },
    },
    refs: { customerEmail: SCENARIO.order.customer.email },
  });

  // 2 — GATEWAY_SELECTED
  await appendEvidence({
    orderId: orderIdStr,
    orderNumber: FIXTURE_ORDER_NUMBER,
    eventType: OrderEvidenceEventType.GATEWAY_SELECTED,
    occurredAt: at(0, 14, 2, 18),
    actor: evidenceActorAgent,
    payload: { gateway: "STRIPE", gatewayLabel: "Stripe" },
  });

  // 3 — PAYMENT_LINK_GENERATED
  await appendEvidence({
    orderId: orderIdStr,
    orderNumber: FIXTURE_ORDER_NUMBER,
    eventType: OrderEvidenceEventType.PAYMENT_LINK_GENERATED,
    occurredAt: at(0, 14, 2, 18),
    actor: evidenceActorAgent,
    payload: {
      gateway: "STRIPE",
      paymentSessionId: SCENARIO.payment.sessionId,
      paymentIntentId: SCENARIO.payment.paymentIntentId,
      checkoutUrl: SCENARIO.payment.checkoutUrl,
      amount: SCENARIO.order.amount,
      currency: SCENARIO.order.currency,
      expiresAt: at(1, 14, 2).toISOString(),
    },
    refs: {
      paymentSessionId: SCENARIO.payment.sessionId,
      paymentIntentId: SCENARIO.payment.paymentIntentId,
      customerEmail: SCENARIO.order.customer.email,
    },
  });

  // 4 — PAYMENT_REQUEST_EMAIL_SENT
  const requestEmailHtml = `<p>Hi Talia,</p><p>Please review and confirm your Budget Rent A Car reservation ORD-260805-K4M9P2RT3W — Toyota Camry XLE, $2,840.00, pick-up 14:00 PT.</p>`;
  const requestMessageId = `<2026040921031.6f3a2b.budget.smtp>`;
  await appendEvidence({
    orderId: orderIdStr,
    orderNumber: FIXTURE_ORDER_NUMBER,
    eventType: OrderEvidenceEventType.PAYMENT_REQUEST_EMAIL_SENT,
    occurredAt: at(0, 14, 3, 11),
    actor: evidenceActorSystem,
    payload: {
      kind: EmailKind.PAYMENT_LINK,
      subject: SCENARIO.consent.consentEmailSubject,
      to: SCENARIO.order.customer.email,
      messageId: requestMessageId,
      amount: `$${SCENARIO.order.amount.toFixed(2)}`,
      gateway: "STRIPE",
      gatewayLabel: "Stripe",
      html: requestEmailHtml,
    },
    refs: {
      messageId: requestMessageId,
      customerEmail: SCENARIO.order.customer.email,
      paymentSessionId: SCENARIO.payment.sessionId,
      paymentIntentId: SCENARIO.payment.paymentIntentId,
    },
  });

  // 5 — CONSENT_REQUESTED
  const consentToken = `tok_${randomUUID()}`;
  await appendEvidence({
    orderId: orderIdStr,
    orderNumber: FIXTURE_ORDER_NUMBER,
    eventType: OrderEvidenceEventType.CONSENT_REQUESTED,
    occurredAt: SCENARIO.consent.requestedAt,
    actor: evidenceActorAgent,
    payload: {
      consentId: String(consentDoc._id),
      consentEmailSubject: SCENARIO.consent.consentEmailSubject,
      consentMessage: SCENARIO.consent.consentMessage,
      method: ConsentMethod.HOSTED_PAGE,
      snapshot: {
        amount: SCENARIO.order.amount,
        currency: SCENARIO.order.currency,
      },
    },
    refs: {
      consentId: String(consentDoc._id),
      consentTokenHash: hashConsentToken(consentToken),
      customerEmail: SCENARIO.order.customer.email,
    },
  });

  // 6 — CONSENT_RECEIVED
  await appendEvidence({
    orderId: orderIdStr,
    orderNumber: FIXTURE_ORDER_NUMBER,
    eventType: OrderEvidenceEventType.CONSENT_RECEIVED,
    occurredAt: SCENARIO.consent.receivedAt,
    actor: evidenceActorCustomer,
    request: {
      ip: SCENARIO.consent.ip,
      userAgent: SCENARIO.consent.userAgent,
      requestId: null,
    },
    payload: {
      consentId: String(consentDoc._id),
      method: ConsentMethod.HOSTED_PAGE,
      signedName: SCENARIO.consent.signedName,
      acknowledgement: SCENARIO.consent.consentMessage,
      consentMessage: SCENARIO.consent.consentMessage,
      snapshot: {
        amount: SCENARIO.order.amount,
        currency: SCENARIO.order.currency,
      },
    },
    refs: {
      consentId: String(consentDoc._id),
      consentTokenHash: hashConsentToken(consentToken),
      customerEmail: SCENARIO.order.customer.email,
      signatureName: SCENARIO.consent.signedName,
    },
  });

  // 7 — PAYMENT_COMPLETED
  await appendEvidence({
    orderId: orderIdStr,
    orderNumber: FIXTURE_ORDER_NUMBER,
    eventType: OrderEvidenceEventType.PAYMENT_COMPLETED,
    occurredAt: SCENARIO.payment.paidAt,
    actor: evidenceActorGateway,
    payload: {
      gateway: "STRIPE",
      gatewayEventId: SCENARIO.payment.gatewayEventId_completed,
      paymentSessionId: SCENARIO.payment.sessionId,
      paymentIntentId: SCENARIO.payment.paymentIntentId,
      amountReceived: SCENARIO.order.amount,
      currency: SCENARIO.order.currency,
      paidAt: SCENARIO.payment.paidAt.toISOString(),
      source: "webhook",
      consentStatus: ConsentStatus.VERIFIED,
      consentId: String(consentDoc._id),
    },
    refs: {
      gatewayEventId: SCENARIO.payment.gatewayEventId_completed,
      paymentSessionId: SCENARIO.payment.sessionId,
      paymentIntentId: SCENARIO.payment.paymentIntentId,
      transactionId: SCENARIO.payment.paymentIntentId,
      customerEmail: SCENARIO.order.customer.email,
    },
  });

  // 8 — CONFIRMATION_EMAIL_SENT
  const confirmationEmailHtml = `<p>Hi Talia,</p><p>Payment received — $2,840.00 confirmed. Your Toyota Camry XLE is reserved for pick-up at Budget · LAX on the scheduled date.</p>`;
  const confirmationMessageId = `<2026040921104.9c2d8a.budget.smtp>`;
  await appendEvidence({
    orderId: orderIdStr,
    orderNumber: FIXTURE_ORDER_NUMBER,
    eventType: OrderEvidenceEventType.CONFIRMATION_EMAIL_SENT,
    occurredAt: SCENARIO.payment.confirmationEmailSentAt,
    actor: { type: OrderEvidenceActorType.SYSTEM, name: "Payment webhook" },
    payload: {
      kind: EmailKind.PAYMENT_CONFIRMATION,
      subject: "Budget · Payment received · ORD-260805-K4M9P2RT3W",
      to: SCENARIO.order.customer.email,
      messageId: confirmationMessageId,
      amount: `$${SCENARIO.order.amount.toFixed(2)}`,
      paidOn: SCENARIO.payment.paidAt.toISOString().slice(0, 10),
      html: confirmationEmailHtml,
    },
    refs: {
      messageId: confirmationMessageId,
      customerEmail: SCENARIO.order.customer.email,
    },
  });

  // 9 — Dispute opened (recorded as PAYMENT_FAILED with kind=dispute_created,
  // matching the production webhook handler).
  await appendEvidence({
    orderId: orderIdStr,
    orderNumber: FIXTURE_ORDER_NUMBER,
    eventType: OrderEvidenceEventType.PAYMENT_FAILED,
    occurredAt: SCENARIO.dispute.openedAt,
    actor: evidenceActorGateway,
    payload: {
      kind: "dispute_created",
      disputeId: String(disputeDoc._id),
      gatewayDisputeId: SCENARIO.dispute.gatewayDisputeId,
      status: DisputeStatus.NEEDS_RESPONSE,
      reason: SCENARIO.dispute.reason,
      amount: SCENARIO.order.amount,
      currency: SCENARIO.order.currency,
    },
    refs: {
      gatewayEventId: SCENARIO.dispute.gatewayEventId_created,
      paymentIntentId: SCENARIO.payment.paymentIntentId,
      customerEmail: SCENARIO.order.customer.email,
    },
  });

  console.log("  ✓ Replayed 9 hash-chained evidence events");

  /* ── 6. Audit log entries ──────────────────────────────────────────── */

  const auditRows = [
    {
      action: AuditAction.ORDER_CREATED,
      entityType: AuditEntity.ORDER,
      entityId: orderIdStr,
      actor: {
        userId: mira._id,
        name: mira.name,
        email: mira.email,
        role: UserRole.ADMIN,
      },
      request: { ip: null, userAgent: null, requestId: null },
      metadata: {
        orderNumber: FIXTURE_ORDER_NUMBER,
        amount: SCENARIO.order.amount,
        currency: SCENARIO.order.currency,
      },
      createdAt: at(0, 14, 2),
      updatedAt: at(0, 14, 2),
    },
    {
      action: AuditAction.PAYMENT_SUCCEEDED,
      entityType: AuditEntity.PAYMENT,
      entityId: orderIdStr,
      actor: { userId: null, name: "stripe.webhook", email: null, role: null },
      request: { ip: null, userAgent: null, requestId: null },
      metadata: {
        orderNumber: FIXTURE_ORDER_NUMBER,
        sessionId: SCENARIO.payment.sessionId,
        amountReceived: SCENARIO.order.amount,
        currency: SCENARIO.order.currency,
        eventId: SCENARIO.payment.gatewayEventId_completed,
        source: "webhook",
      },
      createdAt: SCENARIO.payment.paidAt,
      updatedAt: SCENARIO.payment.paidAt,
    },
    {
      action: AuditAction.DISPUTE_CREATED,
      entityType: AuditEntity.DISPUTE,
      entityId: String(disputeDoc._id),
      actor: { userId: null, name: "stripe.webhook", email: null, role: null },
      request: { ip: null, userAgent: null, requestId: null },
      metadata: {
        orderId: orderIdStr,
        orderNumber: FIXTURE_ORDER_NUMBER,
        gatewayDisputeId: SCENARIO.dispute.gatewayDisputeId,
        reason: SCENARIO.dispute.reason,
        amount: SCENARIO.order.amount,
        currency: SCENARIO.order.currency,
        eventId: SCENARIO.dispute.gatewayEventId_created,
      },
      createdAt: SCENARIO.dispute.openedAt,
      updatedAt: SCENARIO.dispute.openedAt,
    },
    {
      action: AuditAction.DISPUTE_UPDATED,
      entityType: AuditEntity.DISPUTE,
      entityId: String(disputeDoc._id),
      actor: { userId: null, name: "stripe.webhook", email: null, role: null },
      request: { ip: null, userAgent: null, requestId: null },
      metadata: {
        orderId: orderIdStr,
        orderNumber: FIXTURE_ORDER_NUMBER,
        status: DisputeStatus.UNDER_REVIEW,
        eventId: SCENARIO.dispute.gatewayEventId_updated,
      },
      createdAt: SCENARIO.dispute.updatedAt,
      updatedAt: SCENARIO.dispute.updatedAt,
    },
    {
      action: AuditAction.DISPUTE_CLOSED,
      entityType: AuditEntity.DISPUTE,
      entityId: String(disputeDoc._id),
      actor: { userId: null, name: "stripe.webhook", email: null, role: null },
      request: { ip: null, userAgent: null, requestId: null },
      metadata: {
        orderId: orderIdStr,
        orderNumber: FIXTURE_ORDER_NUMBER,
        outcome: DisputeOutcome.WON,
        status: DisputeStatus.WON,
        eventId: SCENARIO.dispute.gatewayEventId_closed,
      },
      createdAt: SCENARIO.dispute.closedAt,
      updatedAt: SCENARIO.dispute.closedAt,
    },
    {
      action: AuditAction.EVIDENCE_EXPORTED,
      entityType: AuditEntity.ORDER_EVIDENCE,
      entityId: orderIdStr,
      actor: {
        userId: mira._id,
        name: mira.name,
        email: mira.email,
        role: UserRole.ADMIN,
      },
      request: { ip: null, userAgent: null, requestId: null },
      metadata: {
        orderNumber: FIXTURE_ORDER_NUMBER,
        eventCount: 9,
        integrityValid: true,
      },
      createdAt: at(33, 11, 38),
      updatedAt: at(33, 11, 38),
    },
  ];
  await AuditLog.collection.insertMany(auditRows);
  console.log(`  ✓ Created ${auditRows.length} audit log entries`);

  /* ── 7. PendingEmail outbox rows (SENT) ────────────────────────────── */

  await PendingEmail.collection.insertMany([
    {
      orderId,
      kind: EmailKind.PAYMENT_LINK,
      recipient: SCENARIO.order.customer.email,
      status: PendingEmailStatus.SENT,
      attempts: 1,
      nextAttemptAt: at(0, 14, 3),
      lastError: null,
      sentAt: at(0, 14, 3, 11),
      metadata: { kindLabel: "payment-request" },
      createdAt: at(0, 14, 3),
      updatedAt: at(0, 14, 3, 11),
    },
    {
      orderId,
      kind: EmailKind.PAYMENT_CONFIRMATION,
      recipient: SCENARIO.order.customer.email,
      status: PendingEmailStatus.SENT,
      attempts: 1,
      nextAttemptAt: SCENARIO.payment.paidAt,
      lastError: null,
      sentAt: SCENARIO.payment.confirmationEmailSentAt,
      metadata: { kindLabel: "payment-confirmation" },
      createdAt: SCENARIO.payment.paidAt,
      updatedAt: SCENARIO.payment.confirmationEmailSentAt,
    },
  ]);
  console.log("  ✓ Created 2 PendingEmail outbox rows (SENT)");

  /* ── Summary ───────────────────────────────────────────────────────── */

  console.log(`
✓ Aurora scenario seed complete.

  Database:        ${targetDb}
  Order number:    ${FIXTURE_ORDER_NUMBER}
  Customer:        ${SCENARIO.order.customer.name} <${SCENARIO.order.customer.email}>
  Amount:          $${SCENARIO.order.amount.toLocaleString()} ${SCENARIO.order.currency}
  Final status:    PAID · Dispute WON

  Operator login is intentionally unguessable:
    email:    ${SCENARIO.operator.email}
    role:     ${SCENARIO.operator.role}
    password: <random UUID, hashed — cannot be logged into>

  To remove the fixture later: run \`npm run cleanup:aurora\`
  (or with --unsafe-prod if you seeded into the prod DB).
`);

  await disconnectMongo();
}

main().catch(async (err) => {
  console.error("\n✖ Seed failed:", err);
  try {
    const disconnect = (globalThis as { __seedDisconnect?: () => Promise<void> })
      .__seedDisconnect;
    if (disconnect) await disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

declare global {
  // eslint-disable-next-line no-var
  var __seedDisconnect: (() => Promise<void>) | undefined;
}
