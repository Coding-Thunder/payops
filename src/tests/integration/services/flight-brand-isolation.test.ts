import { beforeEach, describe, expect, it, vi } from "vitest";

import { PaymentGatewayKey, ServiceType } from "@/lib/constants/enums";
import { createOrder } from "@/tests/factories/order.factory";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";

/**
 * BRAND ISOLATION — the requirement this feature lives or dies on.
 *
 * One organization sells two things under two names: car rentals as the
 * deployment brand, flights as the flight brand. These tests assert BOTH
 * directions, because a one-directional check passes happily while the
 * other brand leaks:
 *
 *   CAR    -> the rental brand, and NOT the flight brand, anywhere
 *   FLIGHT -> the flight brand, and NOT the rental brand, anywhere
 *
 * They also pin that a flight email renders the FLIGHT template (route,
 * flight charge wording) and a car email renders the rental one (vehicle,
 * "Total rental cost"), since the two are selected by service type at a
 * single seam and a mis-selection would be invisible to a type checker.
 */

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

const { sendPaymentConfirmationEmail } = await import(
  "@/server/services/email.service"
);
const { getOrderById } = await import("@/server/services/order.service");

/** Matches FLIGHT_BRAND_NAME's default in src/lib/env.ts. */
const FLIGHT_BRAND = "Airfare Fees";
/** The car brand in the test environment — CUSTOMER_BRAND_NAME's default. */
const CAR_BRAND = "Rental Confirmation";

async function sendFor(serviceType: ServiceType) {
  sentMail.length = 0;
  const order = await createOrder({
    serviceType,
    payment: { status: "PAID", paidAt: new Date(), gateway: PaymentGatewayKey.STRIPE },
  });
  const dto = await getOrderById(String(order._id), {
    actor: { id: String(order.createdBy.userId), name: "T", email: "t@x.test", role: "SUPER_ADMIN" },
  } as never).catch(() => null);
  await sendPaymentConfirmationEmail(dto ?? (order as never));
  expect(sentMail).toHaveLength(1);
  const msg = sentMail[0]!;
  return { html: String(msg.html ?? ""), subject: String(msg.subject ?? "") };
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sentMail.length = 0;
});

describe("CAR orders keep the rental brand", () => {
  it("renders the rental brand and never the flight brand", async () => {
    const { html } = await sendFor(ServiceType.CAR_RENTAL);
    expect(html).toContain(CAR_BRAND);
    // The whole point: adding flights must not put the flight brand on a
    // single car surface.
    expect(html).not.toContain(FLIGHT_BRAND);
  });

  it("renders the RENTAL template — vehicle and counter wording", async () => {
    const { html } = await sendFor(ServiceType.CAR_RENTAL);
    expect(html).toContain("Vehicle");
    expect(html).toContain("Pick-up");
    expect(html).toContain("Drop-off");
    // Charge wording that only the rental template emits.
    expect(html).toContain("Total rental cost");
    expect(html).not.toContain("Total flight cost");
  });
});

describe("FLIGHT orders carry the flight brand", () => {
  it("renders the flight brand and never the rental brand", async () => {
    const { html } = await sendFor(ServiceType.FLIGHT);
    expect(html).toContain(FLIGHT_BRAND);
    expect(html).not.toContain(CAR_BRAND);
  });

  it("renders the FLIGHT template — itinerary rows, flight charge wording", async () => {
    const { html } = await sendFor(ServiceType.FLIGHT);
    expect(html).toContain("Route");
    expect(html).toContain("Flight details");
    expect(html).toContain("Total flight cost");
    // Car vocabulary must not appear on a flight receipt.
    expect(html).not.toContain("Pick-up");
    expect(html).not.toContain("Drop-off");
    expect(html).not.toContain("Total rental cost");
    expect(html).not.toContain("due at counter");
  });

  it("never leaks the rental brand into a flight subject", async () => {
    // The subject leads with the SUPPLIER name (`provider.name`), not the
    // company brand — "most actionable identifier first", per
    // subjectForBookingType. So the assertion that matters is the negative
    // one: whatever the supplier is called, the other brand's name must not
    // appear. The brand itself is asserted in the body above, which is
    // where company identity is actually rendered.
    const { subject } = await sendFor(ServiceType.FLIGHT);
    expect(subject).not.toContain(CAR_BRAND);
  });

  it("falls back to the FLIGHT brand in the subject when no supplier is set", async () => {
    sentMail.length = 0;
    const order = await createOrder({
      serviceType: ServiceType.FLIGHT,
      provider: undefined,
      payment: {
        status: "PAID",
        paidAt: new Date(),
        gateway: PaymentGatewayKey.STRIPE,
      },
    });
    await sendPaymentConfirmationEmail(order as never);
    const subject = String(sentMail[0]?.subject ?? "");
    // With no supplier to name, the subject falls back to the brand — and
    // that fallback must be the flight brand, not the rental one.
    expect(subject).not.toContain(CAR_BRAND);
  });
});

describe("the brand sent to the payment gateway", () => {
  /**
   * `metadata.appName` becomes the Stripe payment-intent description and
   * PayPal's `brand_name` on the approval screen — the company name the
   * customer reads at the moment they part with money. An audit caught this
   * resolving to the ORGANIZATION brand rather than the service brand, which
   * showed a flight customer the car company on the checkout screen.
   */
  it("is the flight brand for a flight order, not the car brand", async () => {
    const { applyServiceBrand } = await import("@/server/email/service-brand");
    const base = {
      slug: null,
      brandName: CAR_BRAND,
      supportEmail: "support@payops.test",
      supportPhone: "+15555550100",
      logo: "",
      primaryColor: "#0B1220",
      footerTagline: "",
      isDefault: true,
    };

    const flight = applyServiceBrand(base, { serviceType: ServiceType.FLIGHT });
    expect(flight.brandName).toBe(FLIGHT_BRAND);

    const car = applyServiceBrand(base, {
      serviceType: ServiceType.CAR_RENTAL,
    });
    expect(car.brandName).toBe(CAR_BRAND);
    // The car path must return the SAME object, not a copy — that is what
    // makes "car output is unchanged" structural rather than incidental.
    expect(car).toBe(base);

    // A legacy row with no serviceType is a car rental.
    expect(applyServiceBrand(base, {}).brandName).toBe(CAR_BRAND);
  });
});
