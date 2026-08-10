import { beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

import { PaymentGatewayKey, UserRole } from "@/lib/constants/enums";
import { isAppError, type AppError } from "@/lib/errors";
import { Order, Organization } from "@/server/db/models";
import { createOrder } from "@/server/services/order.service";
import { actorFor } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * Which brand a customer email comes FROM.
 *
 * Identity resolves from the ORDER'S organization, never from ambient
 * request context — almost every customer email is dispatched by the outbox
 * drainer or a webhook, neither of which has a session or an organization
 * cookie.
 *
 * The fallback mirrors payments: the DEFAULT organization keeps using
 * EMAIL_FROM unchanged, and any OTHER organization must have a sender
 * configured. Falling back there would post a TripReservations customer a
 * receipt that says RentalConfirmation, from a rentalconfirmation.com
 * address, about money they just paid.
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

const { sendPaymentConfirmationEmail } = await import(
  "@/server/services/email.service"
);

const actor = actorFor(UserRole.ADMIN);
const DEPLOYMENT_FROM = "TraceTxn Test <test@tracetxn.local>";

async function makeOrg(
  slug: string,
  isDefault: boolean,
  email?: Record<string, unknown>,
) {
  const doc = await Organization.create({
    slug,
    name: slug,
    brandName: `${slug} brand`,
    isDefault,
    payments: { provider: PaymentGatewayKey.STRIPE },
    ...(email ? { email } : {}),
  });
  return doc._id as Types.ObjectId;
}

async function orderIn(orgId: Types.ObjectId | null) {
  const { order } = await createOrder(validCreateOrderInput(), { actor });
  await Order.updateOne(
    { _id: order.id },
    { $set: { organizationId: orgId } },
  );
  return order;
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sentMail.length = 0;
});

describe("unmigrated and default organizations are unchanged", () => {
  it("sends from EMAIL_FROM for an order with no organization", async () => {
    const order = await orderIn(null);
    await sendPaymentConfirmationEmail(order);
    expect(sentMail[0]!.from).toBe(DEPLOYMENT_FROM);
    expect(sentMail[0]!.__transport).toBe("deployment");
  });

  it("sends from EMAIL_FROM for the default organization with no sender set", async () => {
    const org = await makeOrg("rentalconfirmation", true);
    const order = await orderIn(org);
    await sendPaymentConfirmationEmail(order);
    expect(sentMail[0]!.from).toBe(DEPLOYMENT_FROM);
  });
});

describe("a configured organization sends as itself", () => {
  it("uses its own From, Reply-To and brand", async () => {
    const org = await makeOrg("tripreservations", false, {
      fromName: "Trip Reservations",
      fromEmail: "no-reply@tripreservations.co.uk",
      replyTo: "help@tripreservations.co.uk",
    });
    const order = await orderIn(org);
    await sendPaymentConfirmationEmail(order);

    const msg = sentMail[0]!;
    expect(msg.from).toBe("Trip Reservations <no-reply@tripreservations.co.uk>");
    expect(msg.replyTo).toBe("help@tripreservations.co.uk");
    // Brand in the body follows the same source as the header.
    expect(String(msg.html)).toContain("tripreservations brand");
    expect(String(msg.html)).not.toContain("Rental Confirmation");
  });

  it("routes through its own SMTP account when one is configured", async () => {
    // No vault password stored, so this must refuse rather than send the
    // brand's mail out of the incumbent's mailbox.
    const org = await makeOrg("tripreservations", false, {
      fromEmail: "no-reply@tripreservations.co.uk",
      transport: { host: "smtp.trip.example", port: 587, secure: false, user: "mailer" },
    });
    const order = await orderIn(org);
    await expect(sendPaymentConfirmationEmail(order)).rejects.toThrow(
      /no password stored/i,
    );
  });

  it("quotes a display name containing a comma so it stays one address", async () => {
    const org = await makeOrg("acme", false, {
      fromName: "Acme, Inc.",
      fromEmail: "no-reply@acme.test",
    });
    const order = await orderIn(org);
    await sendPaymentConfirmationEmail(order);
    expect(sentMail[0]!.from).toBe('"Acme, Inc." <no-reply@acme.test>');
  });
});

describe("an unconfigured second organization must not borrow the incumbent's identity", () => {
  it("refuses to send rather than mislabel the sender", async () => {
    const org = await makeOrg("tripreservations", false);
    const order = await orderIn(org);
    const err = await sendPaymentConfirmationEmail(order).catch((e) => e);
    expect(isAppError(err)).toBe(true);
    expect((err as AppError).statusCode).toBe(409);
    expect(sentMail).toHaveLength(0);
  });
});

describe("two organizations do not share a sender", () => {
  it("keeps their From headers independent", async () => {
    const rc = await makeOrg("rentalconfirmation", true);
    const trip = await makeOrg("tripreservations", false, {
      fromName: "Trip Reservations",
      fromEmail: "no-reply@tripreservations.co.uk",
    });

    await sendPaymentConfirmationEmail(await orderIn(rc));
    await sendPaymentConfirmationEmail(await orderIn(trip));

    expect(sentMail.map((m) => m.from)).toEqual([
      DEPLOYMENT_FROM,
      "Trip Reservations <no-reply@tripreservations.co.uk>",
    ]);
  });
});
