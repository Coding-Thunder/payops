import { beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

import {
  CaptureMode,
  PaymentGatewayKey,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { isAppError, type AppError } from "@/lib/errors";
import { Branding, Order, Organization } from "@/server/db/models";
import { createOrder } from "@/server/services/order.service";
import { actorFor } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * Requirement 20 — email configuration is ORGANIZATION-SPECIFIC.
 *
 * GlobeVista trades as FlightBizz. Everything a FlightBizz customer reads
 * must say FlightBizz: the From header, the Reply-To, the brand in the body,
 * and the support contacts. NOTHING may come from the deployment's
 * EMAIL_FROM, which is RentalConfirmation's mailbox — a customer receiving a
 * flight receipt from a car-rental address is a trust failure, and SPF/DKIM
 * would not align with the brand they expect either.
 *
 * THE BEHAVIOUR THIS FILE PINS DOWN, since the requirement asks which of the
 * two the implementation chose: a NON-DEFAULT organization with no sender
 * configured THROWS (`ConflictError`, HTTP 409) and sends nothing. It does
 * not inherit the deployment identity. A visible failure an operator can fix
 * beats a silent mis-send under the wrong brand.
 *
 * The mirror-image assertion runs alongside every case: RentalConfirmation
 * (the DEFAULT organization) and TripReservations (configured, non-default)
 * resolve to exactly what they resolve to today.
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
      sentMail.push({ ...m, __transport: `org:${cfg.host}:${cfg.user}` });
      return { messageId: "<org>", response: "250" };
    },
  }),
  verifyMailer: async () => {},
  _resetOrgMailersForTests: () => {},
}));

const { resolveEmailIdentity, organizationIdForOrder } = await import(
  "@/server/email/identity"
);
const { sendPaymentConfirmationEmail } = await import(
  "@/server/services/email.service"
);

const actor = actorFor(UserRole.ADMIN);

/** The deployment mailbox and singleton — RentalConfirmation's, in prod. */
const DEPLOYMENT_FROM = "PayOps Test <test@payops.local>";
const DEPLOYMENT_BRANDING = {
  brandName: "Rental Confirmation",
  supportEmail: "support@rentalconfirmation.com",
  supportPhone: "+15513071441",
};

async function seedBranding() {
  await Branding.findOneAndUpdate(
    { key: "default" },
    { $set: { key: "default", ...DEPLOYMENT_BRANDING, primaryColor: "#0B1220" } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function makeOrg(opts: {
  slug: string;
  brandName: string;
  isDefault: boolean;
  captureMode?: CaptureMode;
  serviceTypes?: ServiceType[];
  email?: Record<string, unknown>;
  support?: Record<string, unknown>;
}) {
  const doc = await Organization.create({
    slug: opts.slug,
    name: opts.slug,
    brandName: opts.brandName,
    isDefault: opts.isDefault,
    payments: {
      provider: PaymentGatewayKey.STRIPE,
      captureMode: opts.captureMode ?? CaptureMode.AUTOMATIC,
    },
    serviceTypes: opts.serviceTypes ?? [ServiceType.CAR_RENTAL],
    ...(opts.email ? { email: opts.email } : {}),
    ...(opts.support ? { support: opts.support } : {}),
  });
  return doc._id as Types.ObjectId;
}

/** GlobeVista as it is actually configured: manual capture, FlightBizz. */
function makeGlobeVista(email?: Record<string, unknown>) {
  return makeOrg({
    slug: "globevista",
    brandName: "FlightBizz",
    isDefault: false,
    captureMode: CaptureMode.MANUAL,
    serviceTypes: [ServiceType.FLIGHT],
    email: email ?? {
      fromName: "FlightBizz",
      fromEmail: "no-reply@flightbizz.test",
      replyTo: "help@flightbizz.test",
    },
  });
}

const makeRentalConfirmation = () =>
  makeOrg({
    slug: "rentalconfirmation",
    brandName: "Rental Confirmation",
    isDefault: true,
  });

const makeTripReservations = () =>
  makeOrg({
    slug: "tripreservations",
    brandName: "Trip Reservations",
    isDefault: false,
    email: {
      fromName: "Trip Reservations",
      fromEmail: "no-reply@tripreservations.co.uk",
      replyTo: "help@tripreservations.co.uk",
    },
  });

/** An order owned by `orgId` (null = an unattributed pre-migration row). */
async function orderIn(orgId: Types.ObjectId | null) {
  const { order } = await createOrder(validCreateOrderInput(), { actor });
  await Order.updateOne({ _id: order.id }, { $set: { organizationId: orgId } });
  return order;
}

/** Resolve identity the way the send path does: from the ORDER. */
async function identityForOrder(orderId: string) {
  return resolveEmailIdentity(
    await organizationIdForOrder(orderId),
    DEPLOYMENT_BRANDING,
  );
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await seedBranding();
  sentMail.length = 0;
});

describe("a GlobeVista order sends as FlightBizz", () => {
  it("resolves the FlightBizz sender, reply-to and brand", async () => {
    const gv = await makeGlobeVista();
    const order = await orderIn(gv);

    const identity = await identityForOrder(order.id);

    expect(identity.from).toBe("FlightBizz <no-reply@flightbizz.test>");
    expect(identity.replyTo).toBe("help@flightbizz.test");
    expect(identity.brandName).toBe("FlightBizz");
  });

  it("NEVER falls back to the deployment EMAIL_FROM or the deployment brand", async () => {
    const gv = await makeGlobeVista();
    const order = await orderIn(gv);

    const identity = await identityForOrder(order.id);

    expect(identity.from).not.toBe(DEPLOYMENT_FROM);
    expect(identity.from).not.toContain("payops.local");
    expect(identity.brandName).not.toBe(DEPLOYMENT_BRANDING.brandName);
    // Support contacts are part of the same story: printing the incumbent's
    // address and US phone number in a FlightBizz email is the same leak in
    // a different field. Absent its own, the sending mailbox is the last
    // resort — never someone else's inbox.
    expect(identity.supportEmail).toBe("no-reply@flightbizz.test");
    expect(identity.supportEmail).not.toBe(DEPLOYMENT_BRANDING.supportEmail);
    expect(identity.supportPhone).toBe("");
    expect(identity.supportPhone).not.toBe(DEPLOYMENT_BRANDING.supportPhone);
  });

  it("uses its own support contacts when it publishes them", async () => {
    const gv = await makeOrg({
      slug: "globevista",
      brandName: "FlightBizz",
      isDefault: false,
      captureMode: CaptureMode.MANUAL,
      serviceTypes: [ServiceType.FLIGHT],
      email: { fromName: "FlightBizz", fromEmail: "no-reply@flightbizz.test" },
      support: { email: "support@flightbizz.test", phone: "+442079460000" },
    });
    const identity = await identityForOrder((await orderIn(gv)).id);

    expect(identity.supportEmail).toBe("support@flightbizz.test");
    expect(identity.supportPhone).toBe("+442079460000");
  });

  it("actually SENDS as FlightBizz — header and body agree", async () => {
    const gv = await makeGlobeVista();
    const order = await orderIn(gv);

    await sendPaymentConfirmationEmail(order);

    expect(sentMail).toHaveLength(1);
    const msg = sentMail[0]!;
    expect(msg.from).toBe("FlightBizz <no-reply@flightbizz.test>");
    expect(msg.replyTo).toBe("help@flightbizz.test");
    expect(String(msg.html)).toContain("FlightBizz");
    expect(String(msg.html)).not.toContain("Rental Confirmation");
    expect(String(msg.html)).not.toContain("rentalconfirmation.com");
    expect(String(msg.html)).not.toContain(DEPLOYMENT_BRANDING.supportPhone);
  });

  it("honours ORG_GLOBEVISTA_EMAIL_FROM ahead of the document", async () => {
    // Env-first precedence, same as payment credentials. Silently ignoring
    // a value an operator set is worse than not supporting it.
    const gv = await makeGlobeVista();
    const order = await orderIn(gv);
    process.env.ORG_GLOBEVISTA_EMAIL_FROM = "tickets@flightbizz.test";
    process.env.ORG_GLOBEVISTA_EMAIL_FROM_NAME = "FlightBizz Tickets";
    try {
      const identity = await identityForOrder(order.id);
      expect(identity.from).toBe("FlightBizz Tickets <tickets@flightbizz.test>");
    } finally {
      delete process.env.ORG_GLOBEVISTA_EMAIL_FROM;
      delete process.env.ORG_GLOBEVISTA_EMAIL_FROM_NAME;
    }
  });
});

describe("an unconfigured non-default organization THROWS rather than inheriting", () => {
  it("refuses to resolve an identity for a GlobeVista with no sender", async () => {
    // WHICH BEHAVIOUR THE IMPLEMENTATION CHOSE: it THROWS. It does not fall
    // back to EMAIL_FROM, and it does not send with an empty From.
    const gv = await makeGlobeVista({});
    const order = await orderIn(gv);

    const err = await identityForOrder(order.id).catch((e) => e);
    expect(isAppError(err)).toBe(true);
    expect((err as AppError).statusCode).toBe(409);
    expect(String((err as Error).message)).toMatch(/FlightBizz/);
    expect(String((err as Error).message)).toMatch(/no sender email/i);
  });

  it("refuses to SEND, rather than posting the mail from the incumbent's mailbox", async () => {
    const gv = await makeGlobeVista({});
    const order = await orderIn(gv);

    const err = await sendPaymentConfirmationEmail(order).catch((e) => e);
    expect(isAppError(err)).toBe(true);
    expect((err as AppError).statusCode).toBe(409);
    expect(sentMail).toHaveLength(0);
  });

  it("refuses a sender-configured GlobeVista whose SMTP host has no password", async () => {
    // A host with no credential cannot authenticate. Falling through to the
    // deployment transport would put FlightBizz mail in RentalConfirmation's
    // outbound stream, so this refuses too.
    const gv = await makeGlobeVista({
      fromName: "FlightBizz",
      fromEmail: "no-reply@flightbizz.test",
      transport: {
        host: "smtp.flightbizz.test",
        port: 587,
        secure: false,
        user: "mailer",
      },
    });
    const order = await orderIn(gv);

    await expect(sendPaymentConfirmationEmail(order)).rejects.toThrow(
      /no password stored/i,
    );
    expect(sentMail).toHaveLength(0);
  });
});

describe("the two incumbents' email configuration is untouched", () => {
  it("RentalConfirmation, the default organization, still sends from EMAIL_FROM", async () => {
    const rc = await makeRentalConfirmation();
    const order = await orderIn(rc);

    const identity = await identityForOrder(order.id);
    expect(identity.from).toBe(DEPLOYMENT_FROM);
    expect(identity.brandName).toBe(DEPLOYMENT_BRANDING.brandName);
    // The default organization is the one place the deployment support
    // contacts are correct — it IS the deployment.
    expect(identity.supportEmail).toBe(DEPLOYMENT_BRANDING.supportEmail);
    expect(identity.supportPhone).toBe(DEPLOYMENT_BRANDING.supportPhone);
    expect(identity.transport).toBeNull();

    await sendPaymentConfirmationEmail(order);
    expect(sentMail[0]!.from).toBe(DEPLOYMENT_FROM);
    expect(sentMail[0]!.__transport).toBe("deployment");
  });

  it("an unattributed pre-migration order still sends from EMAIL_FROM", async () => {
    const order = await orderIn(null);

    expect((await identityForOrder(order.id)).from).toBe(DEPLOYMENT_FROM);

    await sendPaymentConfirmationEmail(order);
    expect(sentMail[0]!.from).toBe(DEPLOYMENT_FROM);
  });

  it("TripReservations still sends as itself", async () => {
    const trip = await makeTripReservations();
    const order = await orderIn(trip);

    const identity = await identityForOrder(order.id);
    expect(identity.from).toBe(
      "Trip Reservations <no-reply@tripreservations.co.uk>",
    );
    expect(identity.replyTo).toBe("help@tripreservations.co.uk");
    expect(identity.brandName).toBe("Trip Reservations");
  });

  it("adding GlobeVista does not perturb either incumbent's identity", async () => {
    // The regression that matters operationally: a new brand is added to a
    // live deployment. Neither existing brand's mail may move an inch.
    const rc = await makeRentalConfirmation();
    const trip = await makeTripReservations();
    const rcBefore = await identityForOrder((await orderIn(rc)).id);
    const tripBefore = await identityForOrder((await orderIn(trip)).id);

    await makeGlobeVista();

    expect(await identityForOrder((await orderIn(rc)).id)).toEqual(rcBefore);
    expect(await identityForOrder((await orderIn(trip)).id)).toEqual(tripBefore);
  });

  it("keeps all three From headers independent in one deployment", async () => {
    const rc = await makeRentalConfirmation();
    const trip = await makeTripReservations();
    const gv = await makeGlobeVista();

    await sendPaymentConfirmationEmail(await orderIn(rc));
    await sendPaymentConfirmationEmail(await orderIn(trip));
    await sendPaymentConfirmationEmail(await orderIn(gv));

    expect(sentMail.map((m) => m.from)).toEqual([
      DEPLOYMENT_FROM,
      "Trip Reservations <no-reply@tripreservations.co.uk>",
      "FlightBizz <no-reply@flightbizz.test>",
    ]);
    // Three brands, three senders, one process — and no shared state
    // between them.
    expect(new Set(sentMail.map((m) => m.from)).size).toBe(3);
  });
});
