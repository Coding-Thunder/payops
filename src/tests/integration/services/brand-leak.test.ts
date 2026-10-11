import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

import {
  ConsentMode,
  ConsentStatus,
  EmailKind,
  PaymentGatewayKey,
  PaymentTiming,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import {
  Branding,
  Order,
  Organization,
  OrganizationMember,
} from "@/server/db/models";
import { orgCookieName } from "@/server/auth/org-cookie";
import { mockSession } from "@/tests/utils/auth";
import { setNextHeaders } from "@/tests/utils/next-headers";
import { createOrder } from "@/server/services/order.service";
import { recordTermsAcknowledgement } from "@/server/services/acknowledgement.service";
import { getPublicAcknowledgementView } from "@/server/services/acknowledgement.service";
import { generateAckToken } from "@/server/services/ack-token";
import { actorFor } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * What a NON-DEFAULT brand's customer actually receives and sees.
 *
 * Every leak asserted here shipped to production and was found by audit, not
 * by this suite — the existing tests checked the From header and the query
 * scoping, both of which were already correct, while the brand NAME, the
 * support contacts, the processor attribution and the internal notification
 * all still came from the deployment.
 *
 * The invariant, stated once: anything a customer of organization X reads or
 * clicks must name X. The DEFAULT organization resolves to the deployment
 * Branding singleton byte-for-byte, so none of this changes the incumbent.
 */

const { sentMail } = vi.hoisted(() => ({
  sentMail: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/server/email/smtp", () => ({
  getMailer: () => ({
    sendMail: async (m: Record<string, unknown>) => {
      sentMail.push({ ...m, __transport: "deployment" });
      return { messageId: "<dep>", response: "250" };
    },
  }),
  getMailerFor: (cfg: { host: string; user: string }) => ({
    sendMail: async (m: Record<string, unknown>) => {
      sentMail.push({ ...m, __transport: `org:${cfg.user}` });
      return { messageId: "<org>", response: "250" };
    },
  }),
  verifyMailer: async () => {},
  _resetOrgMailersForTests: () => {},
}));

const {
  sendPaymentConfirmationEmail,
  sendPaymentRequestEmail,
  composePaymentRequestProps,
} = await import("@/server/services/email.service");
const { resolveEmailIdentity, resolvePublicBrand } = await import(
  "@/server/email/identity"
);
const { _setPayPalFetchForTesting } = await import(
  "@/server/payments/gateways/paypal"
);

const actor = actorFor(UserRole.ADMIN);

/** The deployment singleton — RentalConfirmation's, in production. */
const DEPLOYMENT = {
  brandName: "Rental Confirmation",
  supportEmail: "support@rentalconfirmation.com",
  supportPhone: "+15513071441",
};

async function seedBranding() {
  await Branding.findOneAndUpdate(
    { key: "default" },
    { $set: { key: "default", ...DEPLOYMENT, primaryColor: "#0B1220" } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function makeOrg(opts: {
  slug: string;
  brandName: string;
  isDefault: boolean;
  provider?: PaymentGatewayKey;
  email?: Record<string, unknown>;
  support?: Record<string, unknown>;
}) {
  const doc = await Organization.create({
    slug: opts.slug,
    name: opts.slug,
    brandName: opts.brandName,
    isDefault: opts.isDefault,
    payments: { provider: opts.provider ?? PaymentGatewayKey.STRIPE },
    ...(opts.email ? { email: opts.email } : {}),
    ...(opts.support ? { support: opts.support } : {}),
  });
  const id = doc._id as Types.ObjectId;
  await OrganizationMember.create({
    organizationId: id,
    userId: new Types.ObjectId(actor.id),
    role: UserRole.ADMIN,
    status: RecordState.ACTIVE,
  });
  return id;
}

/**
 * Put the request inside an organization, the way the cookie does.
 *
 * Reads are fail-closed now: on a deployment that HAS organizations, a
 * request with no selection sees nothing rather than everything. These tests
 * therefore have to act as a real tenant — which is also what the operator
 * UI does, so the coverage is closer to reality than it was.
 */
function actingAs(orgId: Types.ObjectId) {
  setNextHeaders({ cookies: { [orgCookieName()]: String(orgId) } });
}

/** Trip Reservations as configured in production: own Gmail, own support
 *  address, NO phone number, PayPal. */
async function makeTripReservations() {
  return makeOrg({
    slug: "tripreservations",
    brandName: "Trip Reservations",
    isDefault: false,
    provider: PaymentGatewayKey.PAYPAL,
    email: {
      fromName: "Trip Reservations",
      fromEmail: "contact@tripreservations.test",
      replyTo: "",
      transport: {
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        user: "contact@tripreservations.test",
      },
    },
    support: { email: "contact@tripreservations.test", phone: "" },
  });
}

async function orderIn(
  orgId: Types.ObjectId,
  patch: Record<string, unknown> = {},
) {
  actingAs(orgId);
  const { order } = await createOrder(validCreateOrderInput(), { actor });
  await Order.updateOne(
    { _id: order.id },
    { $set: { organizationId: orgId, ...patch } },
  );
  const { getOrderById } = await import("@/server/services/order.service");
  return getOrderById(order.id, { actor });
}

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await seedBranding();
  sessionMock = await mockSession(actor);
  sentMail.length = 0;
  process.env.ORG_TRIPRESERVATIONS_SMTP_PASSWORD = "app-password";
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
});

describe("resolvePublicBrand", () => {
  it("gives the default organization the deployment singleton verbatim", async () => {
    const rc = await makeOrg({
      slug: "rentalconfirmation",
      brandName: "Rental Confirmation",
      isDefault: true,
    });
    const brand = await resolvePublicBrand(String(rc), DEPLOYMENT);
    expect(brand.brandName).toBe(DEPLOYMENT.brandName);
    expect(brand.supportEmail).toBe(DEPLOYMENT.supportEmail);
    expect(brand.supportPhone).toBe(DEPLOYMENT.supportPhone);
    expect(brand.isDefault).toBe(true);
  });

  it("gives an unattributed order the deployment singleton too", async () => {
    const brand = await resolvePublicBrand(null, DEPLOYMENT);
    expect(brand.brandName).toBe(DEPLOYMENT.brandName);
  });

  it("never hands a non-default organization the incumbent's contacts", async () => {
    const trip = await makeTripReservations();
    const brand = await resolvePublicBrand(String(trip), DEPLOYMENT);
    expect(brand.brandName).toBe("Trip Reservations");
    expect(brand.supportEmail).toBe("contact@tripreservations.test");
    // The leak: an unset phone used to inherit RentalConfirmation's US
    // number, printed as a "Call us" link in a UK brand's email.
    expect(brand.supportPhone).toBe("");
    expect(brand.supportPhone).not.toBe(DEPLOYMENT.supportPhone);
  });
});

describe("the acknowledgement page names the booking's brand", () => {
  it("shows the organization's brand and support address, not the deployment's", async () => {
    const trip = await makeTripReservations();
    const order = await orderIn(trip, {
      "terms.text": "Some terms",
      "terms.version": "v1",
    });

    const view = await getPublicAcknowledgementView(
      generateAckToken(order.id),
    );
    expect(view.brandName).toBe("Trip Reservations");
    expect(view.supportEmail).toBe("contact@tripreservations.test");
    expect(view.brandName).not.toBe(DEPLOYMENT.brandName);
  });

  it("still shows the deployment brand for the default organization", async () => {
    const rc = await makeOrg({
      slug: "rentalconfirmation",
      brandName: "Rental Confirmation",
      isDefault: true,
    });
    const order = await orderIn(rc);
    const view = await getPublicAcknowledgementView(
      generateAckToken(order.id),
    );
    expect(view.brandName).toBe(DEPLOYMENT.brandName);
    expect(view.supportEmail).toBe(DEPLOYMENT.supportEmail);
  });
});

describe("the 'I Agree' notification reaches the brand that sold the booking", () => {
  it("sends from AND to the organization's own mailbox, over its own transport", async () => {
    // The reported bug: a Trip Reservations customer clicked "I Agree" and
    // the notification went to billing@rentalconfirmation.com, so nobody at
    // Trip Reservations ever saw it.
    const trip = await makeTripReservations();
    const order = await orderIn(trip, {
      "terms.text": "Some terms",
      "terms.version": "v1",
    });

    await recordTermsAcknowledgement(generateAckToken(order.id), {
      request: null,
    });

    const ack = sentMail.find((m) =>
      String(m.subject ?? "").startsWith("[Terms accepted]"),
    );
    expect(ack, "no acknowledgement notification was sent").toBeTruthy();
    expect(ack!.to).toBe("contact@tripreservations.test");
    expect(String(ack!.from)).toContain("contact@tripreservations.test");
    expect(ack!.__transport).toBe("org:contact@tripreservations.test");
    // Nothing about the other brand may appear.
    expect(String(ack!.to)).not.toContain("rentalconfirmation");
    expect(String(ack!.from)).not.toContain("rentalconfirmation");
    expect(String(ack!.subject)).toContain("Trip Reservations");
    // Reply still lands on the customer so ops can follow up directly.
    expect(ack!.replyTo).toBe(order.customer.email);
  });

  it("honours a per-organization recipient override", async () => {
    const trip = await makeTripReservations();
    process.env.ORG_TRIPRESERVATIONS_ACK_NOTIFICATION_EMAIL = "ops@trip.test";
    try {
      const order = await orderIn(trip, {
        "terms.text": "Some terms",
        "terms.version": "v1",
      });
      await recordTermsAcknowledgement(generateAckToken(order.id), {
        request: null,
      });
      const ack = sentMail.find((m) =>
        String(m.subject ?? "").startsWith("[Terms accepted]"),
      );
      expect(ack!.to).toBe("ops@trip.test");
    } finally {
      delete process.env.ORG_TRIPRESERVATIONS_ACK_NOTIFICATION_EMAIL;
    }
  });

  it("is recorded on the order so a missing email is distinguishable from a missing click", async () => {
    const trip = await makeTripReservations();
    const order = await orderIn(trip, {
      "terms.text": "Some terms",
      "terms.version": "v1",
    });
    await recordTermsAcknowledgement(generateAckToken(order.id), {
      request: null,
    });

    const { listAuditLogs } = await import("@/server/services/audit.service");
    const { items } = await listAuditLogs({ pageSize: 100 });
    const row = items.find(
      (i) =>
        i.entityId === order.id &&
        (i.metadata as Record<string, unknown> | null)?.kind ===
          "TERMS_ACKNOWLEDGED_OPS",
    );
    expect(row, "the ops notification left no audit trail").toBeTruthy();
  });
});

describe("no brand is told the wrong payment processor", () => {
  it("does not claim Stripe processed a PayPal payment", async () => {
    const trip = await makeTripReservations();
    const order = await orderIn(trip, {
      "payment.gateway": PaymentGatewayKey.PAYPAL,
    });

    await sendPaymentConfirmationEmail(
      await (async () => {
        const { getOrderById } = await import(
          "@/server/services/order.service"
        );
        return getOrderById(order.id, { actor });
      })(),
    );

    const sent = sentMail.find((m) => String(m.html ?? "").length > 0);
    expect(sent).toBeTruthy();
    const html = String(sent!.html);
    expect(html).toContain("PayPal");
    // The receipt used to assert "Payment processed securely by Stripe —
    // PCI-DSS Level 1 certified" and footer "Powered by Stripe." to a
    // customer who paid through PayPal.
    expect(html).not.toContain("Stripe");
  });

  it("names PayPal on the payment button instead of Stripe", async () => {
    const trip = await makeTripReservations();
    const order = await orderIn(trip, {
      "payment.gateway": PaymentGatewayKey.PAYPAL,
      "payment.checkoutUrl": "https://www.paypal.com/checkoutnow?token=X",
      "consent.status": "RECEIVED",
    });
    const { getOrderById } = await import("@/server/services/order.service");
    const props = await composePaymentRequestProps(
      await getOrderById(order.id, { actor }),
    );
    expect(props.gatewayLabel).toBe("PayPal");
    if (props.primaryCta) {
      expect(props.primaryCta.label).not.toContain("Stripe");
    }
  });

  it("leaves a Stripe brand's copy exactly as it was", async () => {
    const rc = await makeOrg({
      slug: "rentalconfirmation",
      brandName: "Rental Confirmation",
      isDefault: true,
    });
    const order = await orderIn(rc, {
      "payment.gateway": PaymentGatewayKey.STRIPE,
    });
    const { getOrderById } = await import("@/server/services/order.service");
    await sendPaymentConfirmationEmail(await getOrderById(order.id, { actor }));

    const sent = sentMail.find((m) => String(m.html ?? "").length > 0);
    const html = String(sent!.html);
    expect(html).toContain(
      "Payment processed securely by Stripe — PCI-DSS Level 1 certified",
    );
    expect(html).toContain("Powered by Stripe.");
  });
});

describe("the gateway's own approval screen names the right merchant", () => {
  it("sends the organization's brand to PayPal, not the deployment's", async () => {
    // PayPal renders `experience_context.brand_name` in the header of the
    // page where the customer authorises the charge. It used to read
    // "Rental Confirmation" for every brand — the wrong merchant name at the
    // exact moment money moves, which is what disputes are made of.
    const bodies: Record<string, unknown>[] = [];
    _setPayPalFetchForTesting((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/oauth2/token")) {
        return new Response(
          JSON.stringify({ access_token: "tok", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          id: "PP-1",
          status: "PAYER_ACTION_REQUIRED",
          links: [
            {
              rel: "payer-action",
              href: "https://www.paypal.com/checkoutnow?token=PP-1",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch);

    Object.assign(process.env, {
      ORG_TRIPRESERVATIONS_PAYPAL_CLIENT_ID: "cid",
      ORG_TRIPRESERVATIONS_PAYPAL_CLIENT_SECRET: "csec",
      ORG_TRIPRESERVATIONS_PAYPAL_WEBHOOK_ID: "wid",
      ORG_TRIPRESERVATIONS_PAYPAL_SANDBOX: "true",
    });

    try {
      const trip = await makeTripReservations();
      const order = await orderIn(trip);
      const { initiatePayment } = await import(
        "@/server/services/order.service"
      );
      await initiatePayment(order.id, { actor });

      const created = bodies.find((b) => "purchase_units" in b);
      expect(created, "PayPal order was never created").toBeTruthy();
      const brandName = (
        created as {
          payment_source?: {
            paypal?: { experience_context?: { brand_name?: string } };
          };
        }
      ).payment_source?.paypal?.experience_context?.brand_name;
      expect(brandName).toBe("Trip Reservations");
      expect(brandName).not.toBe(DEPLOYMENT.brandName);
    } finally {
      _setPayPalFetchForTesting(null);
      for (const k of Object.keys(process.env).filter((k) =>
        k.startsWith("ORG_TRIPRESERVATIONS_PAYPAL_"),
      )) {
        delete process.env[k];
      }
    }
  });
});

describe("Reply-To belongs to the sending brand", () => {
  it("does not substitute the deployment address when a brand publishes none", async () => {
    // identity.ts documents replyTo:"" as "no Reply-To header". The send site
    // used `||`, which turned that into the incumbent's support mailbox — so
    // a customer hitting Reply wrote to the other company.
    const trip = await makeTripReservations();
    const identity = await resolveEmailIdentity(String(trip), DEPLOYMENT);
    expect(identity.replyTo).toBe("");

    const order = await orderIn(trip);
    const { getOrderById } = await import("@/server/services/order.service");
    await sendPaymentConfirmationEmail(await getOrderById(order.id, { actor }));

    const sent = sentMail.find((m) => String(m.html ?? "").length > 0);
    expect(sent!.replyTo ?? "").not.toContain("rentalconfirmation");
  });
});

/**
 * CAR PINS — what a car customer of EITHER brand is asked to do, exactly as
 * today: the consent button, the pay button that names the brand's own
 * processor, the default subject, and the "What you're paying" block with
 * its counter wording. Payment buttons are about to name a flight's charge
 * and the charge wording is becoming per service; a car's copy must not
 * move by a character on either brand.
 */
const CAR_BRANDS = [
  {
    brand: "Rental Confirmation",
    gateway: PaymentGatewayKey.STRIPE,
    gatewayLabel: "Stripe",
    checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_car_pin",
    make: () =>
      makeOrg({
        slug: "rentalconfirmation",
        brandName: "Rental Confirmation",
        isDefault: true,
      }),
  },
  {
    brand: "Trip Reservations",
    gateway: PaymentGatewayKey.PAYPAL,
    gatewayLabel: "PayPal",
    checkoutUrl: "https://www.paypal.com/checkoutnow?token=CAR-PIN",
    make: () => makeTripReservations(),
  },
];

/** A car order in `b`'s organization, its link already generated through
 *  the brand's own gateway. */
async function linkedCarIn(
  b: (typeof CAR_BRANDS)[number],
  patch: Record<string, unknown> = {},
) {
  return orderIn(await b.make(), {
    "payment.gateway": b.gateway,
    "payment.checkoutUrl": b.checkoutUrl,
    ...patch,
  });
}

/** The last payment request that left: its subject, and its HTML as the
 *  customer reads it — tags dropped, React's text-node separators and
 *  escaped apostrophes undone, whitespace collapsed. */
function lastPaymentRequest(): { subject: string; text: string } {
  const msg = [...sentMail]
    .reverse()
    .find(
      (m) =>
        (m.headers as Record<string, string> | undefined)?.["X-Entity-Kind"] ===
        EmailKind.PAYMENT_LINK,
    );
  expect(msg, "no payment request was sent").toBeTruthy();
  return {
    subject: String(msg!.subject),
    text: String(msg!.html)
      .replace(/<!-- -->/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " "),
  };
}

describe("a car rental's payment request reads exactly as before — on either brand", () => {
  it.each(CAR_BRANDS)(
    "$brand: asks for consent with 'Review & Confirm Booking', under the default subject",
    async (b) => {
      const order = await linkedCarIn(b);
      await sendPaymentRequestEmail(order, {}, { actor });

      const email = lastPaymentRequest();
      expect(email.subject).toBe(
        `Complete your Budget payment • ${order.orderNumber}`,
      );
      expect(email.text).toContain(
        `You pay today $249.99 Order ${order.orderNumber} Review & Confirm Booking`,
      );
    },
  );

  it.each(CAR_BRANDS)(
    "$brand: asks to 'Agree & Continue to Payment' where consent is required",
    async (b) => {
      await createSettings({ consentMode: ConsentMode.REQUIRED });
      const order = await linkedCarIn(b);
      await sendPaymentRequestEmail(order, {}, { actor });

      expect(lastPaymentRequest().text).toContain(
        `Order ${order.orderNumber} Agree & Continue to Payment`,
      );
    },
  );

  it.each(CAR_BRANDS)(
    "$brand: once consented, the button pays the prepaid amount through $gatewayLabel",
    async (b) => {
      const order = await linkedCarIn(b, {
        "consent.status": ConsentStatus.RECEIVED,
      });

      const props = await composePaymentRequestProps(order);
      expect(props.primaryCta?.label).toBe(
        `Pay $249.99 securely with ${b.gatewayLabel} →`,
      );
      expect(props.primaryCta?.helperText).toBe(
        `You already confirmed this booking — this opens ${b.gatewayLabel} Checkout.`,
      );
      // …and the re-sent email carries exactly that button.
      await sendPaymentRequestEmail(order);
      expect(lastPaymentRequest().text).toContain(
        `Order ${order.orderNumber} Pay $249.99 securely with ${b.gatewayLabel} →`,
      );
    },
  );

  it.each(CAR_BRANDS)(
    "$brand: shows 'What you're paying' with the car's counter wording",
    async (b) => {
      const order = await linkedCarIn(b, {
        charges: [
          { name: "Rental cost", amount: 249.99, timing: PaymentTiming.PREPAID },
          { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
        ],
      });
      await sendPaymentRequestEmail(order, {}, { actor });

      expect(lastPaymentRequest().text).toContain(
        "What you're paying Rental cost $249.99 Deposit (due at counter) $100.00 " +
          "Amount paid online $249.99 Amount due at counter $100.00 " +
          "Total rental cost $349.99",
      );
    },
  );
});
