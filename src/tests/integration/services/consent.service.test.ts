import { beforeEach, describe, expect, it } from "vitest";

import {
  AuditAction,
  ConsentMethod,
  ConsentStatus,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { AuditLog, Order, PaymentConsent } from "@/server/db/models";
import {
  getPublicConsentView,
  recordConsentFromToken,
  requestConsent,
} from "@/server/services/consent.service";
import { generateConsentToken } from "@/server/services/consent-token";
import { actorFor } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { createOrder as factoryCreateOrder } from "@/tests/factories/order.factory";
import { createSettings } from "@/tests/factories/settings.factory";

/**
 * Consent service — full integration. Locks down the contract the hosted
 * page depends on: signedName is required to flip REQUESTED → RECEIVED,
 * replays are idempotent (refresh-after-consent must NOT 422), and the
 * returned PublicConsentView always carries the Stripe URL so the page
 * can auto-redirect with no dead state.
 *
 * And a record is never refused for the length of what it folds into its
 * rental-shaped slots: an item longer than `vehicle`'s 160 characters (a
 * hotel's property beside its destination, a multi-city route) is clamped
 * for every service, while a value that fits is stored exactly as built.
 */

const BRANDING = { brandName: "Test Brand" } as const;

async function seedRequestedConsent() {
  const order = await factoryCreateOrder({
    payment: {
      status: "PAYMENT_PENDING",
      checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_seed",
      stripeSessionId: "cs_test_seed",
      processedWebhookEventIds: [],
    },
  });
  const actor = actorFor(UserRole.ADMIN);
  const result = await requestConsent(
    {
      orderId: String(order._id),
      customerEmail: order.customer.email,
      customerName: order.customer.name,
      consentMessage:
        "I confirm that I understand and agree to proceed with this payment and booking.",
      consentEmailSubject: "Test subject",
      snapshot: {
        bookingType: order.bookingType,
        provider: order.provider.name,
        // Non-null assertions, not fallbacks: this helper seeds a CAR_RENTAL
        // order, where `vehicle` / `trip` are required by the model. The
        // fields only became nullable for FLIGHT / HOTEL.
        vehicle: `${order.vehicle!.company} • ${order.vehicle!.type}`,
        pickupDate: order.trip!.pickupDate.toISOString(),
        dropoffDate: order.trip!.dropoffDate.toISOString(),
        amount: order.pricing.amount,
        currency: order.pricing.currency,
        paymentLinkRef: order.payment.checkoutUrl ?? null,
      },
    },
    { actor, appUrl: "http://127.0.0.1:3100" },
  );
  return { order, result };
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
});

describe("recordConsentFromToken", () => {
  it("rejects a missing signature on the REQUESTED → RECEIVED transition", async () => {
    const { result } = await seedRequestedConsent();
    await expect(
      recordConsentFromToken(
        {
          token: result.token,
          acknowledgement: result.consent.consentMessage,
          // no signedName
        },
        { branding: BRANDING },
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("rejects a blank / whitespace signature", async () => {
    const { result } = await seedRequestedConsent();
    await expect(
      recordConsentFromToken(
        {
          token: result.token,
          acknowledgement: result.consent.consentMessage,
          signedName: "   ",
        },
        { branding: BRANDING },
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("rejects a tampered acknowledgement statement", async () => {
    const { result } = await seedRequestedConsent();
    await expect(
      recordConsentFromToken(
        {
          token: result.token,
          acknowledgement: "I agree to anything.",
          signedName: "Test Customer",
        },
        { branding: BRANDING },
      ),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("auto-verifies on submission, persists signature/IP/UA, and returns a Stripe URL", async () => {
    const { order, result } = await seedRequestedConsent();
    const view = await recordConsentFromToken(
      {
        token: result.token,
        acknowledgement: result.consent.consentMessage,
        signedName: "  Ada Lovelace  ",
      },
      {
        branding: BRANDING,
        request: {
          ip: "203.0.113.42",
          userAgent: "smoke-agent/1.0",
          requestId: null,
        },
      },
    );

    // Customer submission IS the verification — status lands on VERIFIED.
    expect(view.status).toBe(ConsentStatus.VERIFIED);
    expect(view.paymentUrl).toBe(
      "https://checkout.stripe.com/c/pay/cs_test_seed",
    );
    expect(view.alreadyConfirmedAt).toBeTruthy();

    // Stored record carries the full evidence bundle.
    const stored = await PaymentConsent.findOne({
      orderId: order._id,
    }).lean();
    expect(stored?.status).toBe(ConsentStatus.VERIFIED);
    expect(stored?.signedName).toBe("Ada Lovelace"); // trimmed
    expect(stored?.method).toBe(ConsentMethod.HOSTED_PAGE);
    expect(stored?.receivedAt).toBeTruthy();
    expect(stored?.verifiedAt).toBeTruthy();
    expect(stored?.receiptIp).toBe("203.0.113.42");
    expect(stored?.receiptUserAgent).toBe("smoke-agent/1.0");

    // Order's denormalised pointer is updated to VERIFIED.
    const refreshed = await Order.findById(order._id).lean();
    expect(refreshed?.consent?.status).toBe(ConsentStatus.VERIFIED);
    expect(refreshed?.consent?.method).toBe(ConsentMethod.HOSTED_PAGE);
    expect(refreshed?.consent?.receivedAt).toBeTruthy();
    expect(refreshed?.consent?.verifiedAt).toBeTruthy();

    // Audit row written.
    const audits = await AuditLog.find({
      action: AuditAction.CONSENT_RECEIVED,
    }).lean();
    expect(audits).toHaveLength(1);
  });

  it("is idempotent: replaying without a signature after VERIFIED still returns the existing view", async () => {
    const { result } = await seedRequestedConsent();
    const first = await recordConsentFromToken(
      {
        token: result.token,
        acknowledgement: result.consent.consentMessage,
        signedName: "Ada Lovelace",
      },
      { branding: BRANDING },
    );
    // Replay (refresh, double-submit): missing signedName must NOT 400.
    const replay = await recordConsentFromToken(
      {
        token: result.token,
        acknowledgement: result.consent.consentMessage,
      },
      { branding: BRANDING },
    );
    expect(replay.status).toBe(ConsentStatus.VERIFIED);
    expect(replay.alreadyConfirmedAt).toBe(first.alreadyConfirmedAt);
    // Exactly one CONSENT_RECEIVED audit row — no duplicate written on replay.
    const audits = await AuditLog.find({
      action: AuditAction.CONSENT_RECEIVED,
    }).lean();
    expect(audits).toHaveLength(1);
  });

  it("rejects an invalid token", async () => {
    await expect(
      getPublicConsentView("not-a-token", BRANDING),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      recordConsentFromToken(
        {
          token: generateConsentToken("507f1f77bcf86cd799439011"),
          acknowledgement: "anything",
          signedName: "X",
        },
        { branding: BRANDING },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

/* ------------------------------------------------------------------ *
 * The rental-shaped slots never refuse a record
 * ------------------------------------------------------------------ */

describe("requestConsent stores what fits exactly and clamps what does not — for every service", () => {
  const actor = actorFor(UserRole.ADMIN);

  async function requestFor(
    order: Awaited<ReturnType<typeof factoryCreateOrder>>,
    snapshot: {
      serviceType: ServiceType;
      vehicle: string;
      pickupLocation: string | null;
      dropoffLocation: string | null;
    },
  ) {
    return requestConsent(
      {
        orderId: String(order._id),
        customerEmail: order.customer.email,
        customerName: order.customer.name,
        consentMessage: "I agree to proceed with this payment and booking.",
        consentEmailSubject: "Subject",
        snapshot: {
          bookingType: order.bookingType,
          provider: order.provider.name,
          ...snapshot,
          pickupDate: "2026-11-16T00:00:00.000Z",
          dropoffDate: "2026-11-19T00:00:00.000Z",
          amount: order.pricing.amount,
          currency: order.pricing.currency,
          paymentLinkRef: null,
        },
      },
      { actor, appUrl: "http://127.0.0.1:3100" },
    );
  }

  it("persists a HOTEL whose 138-character property beside its 56-character destination overruns the 160-character slot", async () => {
    const property = `The Grand ${"Harbourside ".repeat(10)}Residences & Spa`.slice(0, 138);
    const destination = "Lisbon, Portugal — Baixa-Chiado, Rua Garrett district 12".slice(0, 56);
    expect(property).toHaveLength(138);
    expect(destination).toHaveLength(56);
    const order = await factoryCreateOrder({
      serviceType: ServiceType.HOTEL,
      hotel: { propertyName: property, destination } as never,
    });
    const item = `${property} • ${destination}`;
    expect(item.length).toBeGreaterThan(160);

    const result = await requestFor(order, {
      serviceType: ServiceType.HOTEL,
      vehicle: item,
      pickupLocation: destination,
      dropoffLocation: destination,
    });

    expect(result.consentUrl).toContain(`/consent/${result.token}`);
    const stored = await PaymentConsent.findOne({ orderId: order._id }).lean();
    expect(stored?.snapshot.vehicle).toHaveLength(160);
    expect(stored?.snapshot.vehicle).toBe(`${item.slice(0, 159)}…`);
    expect(stored?.snapshot.pickupLocation).toBe(destination);
    expect(stored?.snapshot.dropoffLocation).toBe(destination);
  });

  it("stores a CAR's item and locations exactly as built when they fit — up to the slots' very limits", async () => {
    const order = await factoryCreateOrder({});
    const vehicle = `${"V".repeat(150)} • ${"T".repeat(7)}`;
    const location = "L".repeat(200);
    expect(vehicle).toHaveLength(160);

    await requestFor(order, {
      serviceType: ServiceType.CAR_RENTAL,
      vehicle,
      pickupLocation: location,
      dropoffLocation: "San Diego Downtown",
    });

    const stored = await PaymentConsent.findOne({ orderId: order._id }).lean();
    expect(stored?.snapshot.vehicle).toBe(vehicle);
    expect(stored?.snapshot.pickupLocation).toBe(location);
    expect(stored?.snapshot.dropoffLocation).toBe("San Diego Downtown");
    // A car's dates are stored as given — only a flight's are normalised.
    expect(stored?.snapshot.pickupDate.toISOString()).toBe("2026-11-16T00:00:00.000Z");
    expect(stored?.snapshot.dropoffDate.toISOString()).toBe("2026-11-19T00:00:00.000Z");
  });

  it("clamps a CAR's item too, rather than refuse the record — the link the customer is sent always exists", async () => {
    const order = await factoryCreateOrder({});
    const vehicle = `${"V".repeat(120)} • ${"T".repeat(60)}`;
    const result = await requestFor(order, {
      serviceType: ServiceType.CAR_RENTAL,
      vehicle,
      pickupLocation: null,
      dropoffLocation: null,
    });
    expect(result.token).toBeTruthy();
    const stored = await PaymentConsent.findOne({ orderId: order._id }).lean();
    expect(stored?.snapshot.vehicle).toBe(`${vehicle.slice(0, 159)}…`);
  });
});
