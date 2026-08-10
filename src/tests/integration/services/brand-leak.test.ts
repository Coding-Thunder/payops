import { beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

import { PaymentGatewayKey, UserRole } from "@/lib/constants/enums";
import { Branding, Order, Organization } from "@/server/db/models";
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

const { sendPaymentConfirmationEmail, composePaymentRequestProps } =
  await import("@/server/services/email.service");
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
  return doc._id as Types.ObjectId;
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
  orgId: Types.ObjectId | null,
  patch: Record<string, unknown> = {},
) {
  const { order } = await createOrder(validCreateOrderInput(), { actor });
  await Order.updateOne(
    { _id: order.id },
    { $set: { organizationId: orgId, ...patch } },
  );
  const { getOrderById } = await import("@/server/services/order.service");
  return getOrderById(order.id, { actor });
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await seedBranding();
  sentMail.length = 0;
  process.env.ORG_TRIPRESERVATIONS_SMTP_PASSWORD = "app-password";
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
