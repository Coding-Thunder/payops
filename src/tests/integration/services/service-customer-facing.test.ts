import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OrderEvidenceEventType,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { Provider } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { setOrganizationServiceTypes } from "@/tests/utils/organization";
import {
  validCreateOrderInput,
  validCruiseOrderInput,
  validFlightOrderInput,
  validOneWayFlightOrderInput,
} from "@/tests/fixtures/order-input.fixture";

// `vi.mock` is hoisted above imports, so the recorder has to be created in a
// hoisted block or it would be in the temporal dead zone when the factory
// runs. Capturing at the transport is what lets these tests assert on the
// bytes a customer actually receives.
const { sentMail } = vi.hoisted(() => ({
  sentMail: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/server/email/smtp", () => ({
  getMailer: () => ({
    sendMail: async (message: Record<string, unknown>) => {
      sentMail.push(message);
      return { messageId: "<test-message-id>", response: "250 Accepted" };
    },
  }),
  verifyMailer: async () => {},
}));

// Imported after the mock so the service picks up the fake transport.
const { createOrder, initiatePayment, getOrderById } = await import(
  "@/server/services/order.service"
);
const { sendPaymentRequestEmail, sendPaymentConfirmationEmail } = await import(
  "@/server/services/email.service"
);
const { getEvidenceChain } = await import("@/server/services/evidence.service");
const { listConsentsForOrder } = await import(
  "@/server/services/consent.service"
);
const { buildConsentMailto } = await import("@/server/email/consent-mailto");

/** The HTML body of the most recent send. */
function lastHtml(): string {
  expect(sentMail.length, "expected an email to have been sent").toBeGreaterThan(0);
  return String(sentMail.at(-1)!.html);
}

/** The single consent record this order carries. */
async function consentFor(orderId: string) {
  const rows = await listConsentsForOrder(orderId, { actor });
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** Same arguments the payment-request template passes. */
function mailtoFor(order: Parameters<typeof buildConsentMailto>[0]["order"]) {
  return decodeURIComponent(
    buildConsentMailto({
      toEmail: "support@payops.test",
      brandName: "RCR Cruise",
      order,
      consentMessage: "I agree to this booking and authorise the payment.",
    }),
  );
}

const actor = actorFor(UserRole.ADMIN);
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

/**
 * WHAT THE CUSTOMER ACTUALLY SEES.
 *
 * The order model can be perfectly correct and the product still broken, if
 * the receipt for a cruise says "Drop-off" or the evidence pack for a flight
 * asserts a vehicle. These tests read the rendered artefacts — the email
 * HTML, the consent snapshot, the evidence chain — rather than the document
 * they were built from.
 *
 * The car-rental cases are regressions, pinned so that widening the platform
 * cannot silently reword an inherited receipt.
 */

async function seedServiceProviders() {
  await Provider.create([
    {
      key: "TESTAIR",
      name: "Test Airways",
      logo: "/providers/_placeholder.svg",
      primaryColor: "#0078D2",
      onPrimaryColor: "#FFFFFF",
      tagline: "Test airline",
      serviceTypes: [ServiceType.FLIGHT],
      status: RecordState.ACTIVE,
      sortOrder: 100,
    },
    {
      key: "TESTCRUISE",
      name: "Test Cruise Line",
      logo: "/providers/_placeholder.svg",
      primaryColor: "#003DA5",
      onPrimaryColor: "#FFFFFF",
      tagline: "Test cruise line",
      serviceTypes: [ServiceType.CRUISE],
      status: RecordState.ACTIVE,
      sortOrder: 200,
    },
  ]);
}

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
});

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await seedServiceProviders();
  await setOrganizationServiceTypes([
    ServiceType.CAR_RENTAL,
    ServiceType.FLIGHT,
    ServiceType.CRUISE,
  ]);
  sentMail.length = 0;
  sessionMock = await mockSession(actor);
});

/** Create, generate a link, send the request email, return the sent HTML. */
async function sendRequestFor(
  input: Parameters<typeof createOrder>[0],
): Promise<{ html: string; orderId: string }> {
  const { order } = await createOrder(input, { actor });
  await initiatePayment(order.id, { actor });
  const live = await getOrderById(order.id, { actor });
  await sendPaymentRequestEmail(live, {}, { actor });
  return { html: lastHtml(), orderId: order.id };
}

describe("the payment-request email speaks the booking's own language", () => {
  it("shows a flight's route and never a rental counter", async () => {
    const { html } = await sendRequestFor(validFlightOrderInput());

    expect(html).toContain("Route");
    expect(html).toContain("LHR");
    expect(html).toContain("JFK");
    expect(html).toContain("Cabin");
    // The strings that would betray the wrong product. Asserted against the
    // BOOKING-DETAILS and CHARGE-SUMMARY copy, which this code owns —
    // deliberately not against the whole body, because the Terms & Conditions
    // block is operator-configured legal text that the platform must not be
    // asserting the wording of.
    expect(html).not.toContain("Pick-up");
    expect(html).not.toContain("Drop-off");
    expect(html).not.toContain("Total rental cost");
    expect(html).not.toContain("Amount due at counter");
  });

  it("names the airport, not a counter, when part of the fare is due later", async () => {
    const { html } = await sendRequestFor(
      validFlightOrderInput({
        charges: [
          { name: "Airfare", amount: 900, timing: "PREPAID" },
          { name: "Checked bags", amount: 80, timing: "DUE_AT_COUNTER" },
        ],
      }),
    );
    expect(html).toContain("Amount due at the airport");
    expect(html).toContain("(due at the airport)");
    expect(html).toContain("Total flight cost");
    expect(html).not.toContain("Amount due at counter");
    expect(html).not.toContain("(due at counter)");
  });

  it("shows a cruise's ship and pier wording", async () => {
    const { html } = await sendRequestFor(validCruiseOrderInput());

    expect(html).toContain("Wonder of the Seas");
    expect(html).toContain("Departs from");
    expect(html).toContain("Miami, FL");
    // The fixture has gratuities due later, so the pier wording must render.
    expect(html).toContain("Amount due at the pier");
    expect(html).toContain("(due at the pier)");
    expect(html).toContain("Total cruise cost");
    expect(html).not.toContain("Pick-up");
    expect(html).not.toContain("Total rental cost");
    expect(html).not.toContain("Amount due at counter");
  });

  it("still renders the rental triple, verbatim, for a car rental", async () => {
    const { html } = await sendRequestFor(validCreateOrderInput());

    expect(html).toContain("Vehicle");
    expect(html).toContain("Toyota • Camry");
    expect(html).toContain("Pick-up");
    expect(html).toContain("Drop-off");
    // Locations are appended with " · " — the original expression, which
    // `serviceDetailRows` does NOT reproduce. This is the regression guard.
    expect(html).toContain("LAX Airport — Terminal 1");
  });
});

describe("the confirmation email speaks the booking's own language", () => {
  it("shows a cruise's rows and pier wording", async () => {
    const { order } = await createOrder(validCruiseOrderInput(), { actor });
    await sendPaymentConfirmationEmail(await getOrderById(order.id, { actor }));
    const html = lastHtml();
    expect(html).toContain("Ship");
    expect(html).toContain("Royal Caribbean");
    expect(html).toContain("Total cruise cost");
    expect(html).not.toContain("Total rental cost");
  });

  it("shows a flight's rows", async () => {
    const { order } = await createOrder(validFlightOrderInput(), { actor });
    await sendPaymentConfirmationEmail(await getOrderById(order.id, { actor }));
    const html = lastHtml();
    expect(html).toContain("Route");
    expect(html).toContain("Departure");
    expect(html).not.toContain("Pick-up");
  });

  it("still renders the rental rows for a car rental", async () => {
    const { order } = await createOrder(validCreateOrderInput(), { actor });
    await sendPaymentConfirmationEmail(await getOrderById(order.id, { actor }));
    const html = lastHtml();
    expect(html).toContain("Vehicle");
    expect(html).toContain("Pick-up");
    expect(html).toContain("Drop-off");
    expect(html).toContain("Total rental cost");
  });
});

describe("the consent snapshot carries the service type", () => {
  it("stamps a cruise consent record and maps its ports into the slots", async () => {
    const { orderId } = await sendRequestFor(validCruiseOrderInput());
    const consent = await consentFor(orderId);

    expect(consent.snapshot.serviceType).toBe(ServiceType.CRUISE);
    expect(consent.snapshot.vehicle).toContain("Wonder of the Seas");
    expect(consent.snapshot.pickupLocation).toBe("Miami, FL");
    // A round trip disembarks where it boarded.
    expect(consent.snapshot.dropoffLocation).toBe("Miami, FL");
    // Seven nights apart, so the page renders both rows.
    expect(consent.snapshot.dropoffDate).not.toBe(consent.snapshot.pickupDate);
  });

  it("repeats the departure for a one-way flight so the page can omit the return row", async () => {
    const { orderId } = await sendRequestFor(validOneWayFlightOrderInput());
    const consent = await consentFor(orderId);

    expect(consent.snapshot.serviceType).toBe(ServiceType.FLIGHT);
    // The consent page checks exactly this equality before deciding whether
    // to render a "Return" row.
    expect(consent.snapshot.dropoffDate).toBe(consent.snapshot.pickupDate);
  });

  it("stamps CAR_RENTAL and keeps the original rental slots", async () => {
    const { orderId } = await sendRequestFor(validCreateOrderInput());
    const consent = await consentFor(orderId);

    expect(consent.snapshot.serviceType).toBe(ServiceType.CAR_RENTAL);
    expect(consent.snapshot.vehicle).toBe("Toyota • Camry");
    expect(consent.snapshot.pickupLocation).toBe("LAX Airport — Terminal 1");
  });
});

describe("the consent mailto fallback", () => {
  it("lists a cruise's facts, not a vehicle", async () => {
    const { order } = await createOrder(validCruiseOrderInput(), { actor });
    const mailto = mailtoFor(order);
    expect(order.serviceType).toBe(ServiceType.CRUISE);
    expect(mailto).toContain("Ship:");
    expect(mailto).not.toContain("Vehicle:");
    expect(mailto).not.toContain("Pick-up:");
  });

  it("still lists Vehicle / Pick-up / Drop-off for a rental", async () => {
    const { order } = await createOrder(validCreateOrderInput(), { actor });
    const mailto = mailtoFor(order);
    expect(mailto).toContain("Vehicle: Toyota • Camry");
    expect(mailto).toContain("Pick-up:");
    expect(mailto).toContain("Drop-off:");
  });
});

describe("the evidence chain records what was sold", () => {
  it("carries the service type and a readable item for a flight", async () => {
    const { order } = await createOrder(validFlightOrderInput(), { actor });
    const chain = await getEvidenceChain(order.id, { actor });

    expect(chain.order.serviceType).toBe(ServiceType.FLIGHT);
    // No car on a flight — the PDF and the chain view both branch on this.
    expect(chain.order.vehicle).toBeNull();
    // …but the packet must still say what was bought.
    expect(chain.order.item).toContain("LHR");
    expect(chain.order.item).toContain("JFK");
  });

  it("carries the service type and a readable item for a cruise", async () => {
    const { order } = await createOrder(validCruiseOrderInput(), { actor });
    const chain = await getEvidenceChain(order.id, { actor });

    expect(chain.order.serviceType).toBe(ServiceType.CRUISE);
    expect(chain.order.vehicle).toBeNull();
    expect(chain.order.item).toContain("Wonder of the Seas");
  });

  it("keeps the vehicle snapshot for a car rental", async () => {
    const { order } = await createOrder(validCreateOrderInput(), { actor });
    const chain = await getEvidenceChain(order.id, { actor });

    expect(chain.order.serviceType).toBe(ServiceType.CAR_RENTAL);
    expect(chain.order.vehicle?.company).toBe("Toyota");
    expect(chain.order.item).toBe("Toyota Camry");
  });

  it("freezes the full service payload into the genesis evidence row", async () => {
    // The dispute pack is reconstructed from these payloads, so the cruise
    // facts have to be IN the hashed row, not merely joinable from the order.
    const { order } = await createOrder(validCruiseOrderInput(), { actor });
    const chain = await getEvidenceChain(order.id, { actor });

    const genesis = chain.events.find(
      (e) => e.eventType === OrderEvidenceEventType.ORDER_CREATED,
    );
    expect(genesis).toBeDefined();
    const payload = genesis!.payload as Record<string, unknown>;
    expect(payload.serviceType).toBe(ServiceType.CRUISE);
    expect(payload.item).toContain("Wonder of the Seas");
    expect(payload.cruise).toMatchObject({
      departurePort: "Miami, FL",
      cabinCategory: "BALCONY",
    });
    // A cruise row must not carry a rental payload at all.
    expect(payload.vehicle).toBeUndefined();
    expect(payload.trip).toBeUndefined();
  });

  it("verifies the hash chain on a cruise order", async () => {
    // Widening the evidence payload must not break the chain the whole
    // dispute story depends on.
    const { order } = await createOrder(validCruiseOrderInput(), { actor });
    const chain = await getEvidenceChain(order.id, { actor });
    expect(chain.verification.valid).toBe(true);
  });
});
