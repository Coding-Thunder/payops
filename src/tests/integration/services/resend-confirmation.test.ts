import { beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

import { ConflictError, ForbiddenError } from "@/lib/errors";
import {
  EmailKind,
  OrderEvidenceActorType,
  OrderEvidenceEventType,
  OrderStatus,
  PaymentTiming,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { Order, OrderEvidence } from "@/server/db/models";
import { sendPaymentConfirmationEmail } from "@/server/services/email.service";
import {
  getOrderById,
  resendConfirmationEmail,
  setConfirmationNumber,
} from "@/server/services/order.service";
import { actorFor } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import {
  createOrder as factoryCreateOrder,
  createPaidOrder,
  itineraryFlight,
} from "@/tests/factories/order.factory";
import { createSettings } from "@/tests/factories/settings.factory";

// The mail transport, recorded, so a resent confirmation can be read back
// exactly as the customer receives it. `vi.mock` is hoisted above the
// imports, so the recorder is created in a hoisted block too.
const { sentMail } = vi.hoisted(() => ({
  sentMail: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/server/email/smtp", () => ({
  getMailer: () => ({
    sendMail: async (m: Record<string, unknown>) => {
      sentMail.push(m);
      return { messageId: "<resend>", response: "250" };
    },
  }),
  getMailerFor: () => ({
    sendMail: async (m: Record<string, unknown>) => {
      sentMail.push(m);
      return { messageId: "<resend-org>", response: "250" };
    },
  }),
  verifyMailer: async () => {},
  _resetOrgMailersForTests: () => {},
}));

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sentMail.length = 0;
});

/** The last confirmation email that left: its subject, and its HTML as the
 *  customer reads it — tags dropped, React's text-node separators and
 *  escaped apostrophes undone, whitespace collapsed. */
function lastConfirmation(): { subject: string; text: string } {
  const msg = [...sentMail]
    .reverse()
    .find(
      (m) =>
        (m.headers as Record<string, string> | undefined)?.["X-Entity-Kind"] ===
        EmailKind.PAYMENT_CONFIRMATION,
    );
  expect(msg, "no confirmation email was sent").toBeTruthy();
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

describe("resendConfirmationEmail", () => {
  it("resends a paid order's confirmation with the current confirmation number", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const order = await createPaidOrder({});

    // Agent pastes the supplier number AFTER payment.
    await setConfirmationNumber(String(order._id), "SUPP-9F3K2218", { actor });

    const result = await resendConfirmationEmail(String(order._id), { actor });

    expect(result.order.confirmationNumber).toBe("SUPP-9F3K2218");
    const stored = await Order.findById(order._id).lean();
    expect(stored?.payment.confirmationEmailSentAt).toBeInstanceOf(Date);
  });

  it("refuses to resend for a non-paid order", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const order = await factoryCreateOrder({
      status: OrderStatus.PAYMENT_PENDING,
    });
    await expect(
      resendConfirmationEmail(String(order._id), { actor }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("blocks a STAFF user from resending another staffer's order", async () => {
    const owner = actorFor(UserRole.STAFF);
    const intruder = actorFor(UserRole.STAFF);
    const order = await createPaidOrder({
      createdBy: { userId: owner.id, name: owner.name },
    });
    await expect(
      resendConfirmationEmail(String(order._id), { actor: intruder }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

/**
 * CAR PINS — the resent confirmation a car customer reads, exactly as it
 * reads today. The booking reference and the charge wording are becoming
 * per service (a flight's PNR, a hotel's confirmation number and "Total
 * hotel cost"); a car's copy must not move by a character.
 */
describe("a car rental's resent confirmation reads exactly as before", () => {
  it("opens with the pasted number under 'Confirmation number', above the booking details", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const order = await createPaidOrder({});
    await setConfirmationNumber(String(order._id), "SUPP-9F3K2218", { actor });

    await resendConfirmationEmail(String(order._id), { actor });

    const email = lastConfirmation();
    expect(email.text).toContain("Confirmation number SUPP-9F3K2218");
    // The top block: straight after the thank-you banner, before the
    // provider badge and the booking card.
    expect(email.text).toContain(
      "please keep this email for your records. Confirmation number SUPP-9F3K2218 Budget New booking Booking details",
    );
    expect(email.subject).toBe(`Budget booking confirmed • ${order.orderNumber}`);
  });

  it("carries no 'Confirmation number' block until a number is pasted", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const order = await createPaidOrder({});

    await resendConfirmationEmail(String(order._id), { actor });

    const { text } = lastConfirmation();
    expect(text).not.toContain("Confirmation number");
    expect(text).toContain(
      "please keep this email for your records. Budget New booking Booking details",
    );
  });

  it("keeps the car's 'Charge breakdown' wording, counter balance included", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const order = await createPaidOrder({
      charges: [
        { name: "Rental cost", amount: 199.5, timing: PaymentTiming.PREPAID },
        { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
      ],
    });

    await resendConfirmationEmail(String(order._id), { actor });

    const { text } = lastConfirmation();
    expect(text).toContain(`Amount paid $199.50 Order ${order.orderNumber}`);
    expect(text).toContain(
      "Charge breakdown Rental cost $199.50 Deposit (due at counter) $100.00 " +
        "Amount paid online $199.50 Amount due at counter $100.00 " +
        "Total rental cost $299.50",
    );
  });
});

/** The CONFIRMATION_EMAIL_SENT evidence rows of an order, oldest first. */
async function confirmationEvidence(orderId: string) {
  return OrderEvidence.find({
    orderId: new Types.ObjectId(orderId),
    eventType: OrderEvidenceEventType.CONFIRMATION_EMAIL_SENT,
  })
    .sort({ sequence: 1 })
    .lean<
      Array<{
        actor: { type: string; userId?: unknown; name?: string | null; email?: string | null; role?: string | null };
        payload: Record<string, unknown>;
      }>
    >();
}

/** The keys a car's confirmation evidence row has always carried, in order. */
const CONFIRMATION_EVIDENCE_KEYS = [
  "kind",
  "subject",
  "from",
  "replyTo",
  "to",
  "messageId",
  "brand",
  "amount",
  "paidOn",
  "receiptUrl",
  "html",
  "text",
];

/**
 * WHO SENT IT — a manual resend's evidence row names the agent who asked
 * for it and says it was a resend; the payment webhook's own confirmation
 * (what the outbox sends, with no options) keeps exactly its historic row,
 * so a dispute packet can tell the gateway's receipt from a resend.
 */
describe("a resent confirmation is attributed to the agent who resent it", () => {
  it("names the agent on the evidence row and marks it as a resend", async () => {
    const actor = actorFor(UserRole.ADMIN, { name: "Riya Resender" });
    const order = await createPaidOrder({});

    await resendConfirmationEmail(String(order._id), { actor });

    const [row] = await confirmationEvidence(String(order._id));
    expect(row, "the resend recorded no evidence").toBeTruthy();
    expect(row!.actor).toMatchObject({
      type: OrderEvidenceActorType.AGENT,
      name: "Riya Resender",
      email: actor.email,
      role: UserRole.ADMIN,
    });
    expect(String(row!.actor.userId)).toBe(actor.id);
    expect(row!.payload.resend).toBe(true);
    // The historic row, plus the one key that says it was a resend.
    expect(Object.keys(row!.payload)).toEqual([
      "kind",
      "resend",
      ...CONFIRMATION_EVIDENCE_KEYS.slice(1),
    ]);
  });

  it("leaves the payment webhook's confirmation row exactly as before — the webhook, no resend key", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const order = await createPaidOrder({});

    // What the outbox does once a payment webhook queues the confirmation.
    await sendPaymentConfirmationEmail(await getOrderById(String(order._id), { actor }));

    const [row] = await confirmationEvidence(String(order._id));
    expect(row!.actor.type).toBe(OrderEvidenceActorType.SYSTEM);
    expect(row!.actor.name).toBe("Payment webhook");
    expect(row!.actor.userId ?? null).toBeNull();
    expect("resend" in row!.payload).toBe(false);
    expect(Object.keys(row!.payload)).toEqual(CONFIRMATION_EVIDENCE_KEYS);
  });
});

/**
 * ONE BOOKING REFERENCE, NAMED THE SERVICE'S WAY — a flight's resent
 * confirmation opens with its PNR (the pasted reference over any legacy
 * copy, printed once), a hotel's with its hotel confirmation number. The
 * car's "Confirmation number" is pinned above.
 */
describe("a flight's and a hotel's resent confirmation name the booking reference their own way", () => {
  /** A paid itinerary flight: $400 airline charge, the "Rental Cost" $100
   *  collected — and a legacy PNR of its own. */
  const paidFlight = (pnr: string | null) =>
    createPaidOrder({
      serviceType: ServiceType.FLIGHT,
      flight: itineraryFlight({ pnr }),
      pricing: { amount: 100, currency: "USD" as never },
      charges: [{ name: "Rental Cost", amount: 100, timing: PaymentTiming.PREPAID }],
    });

  it("FLIGHT: opens with 'PNR' and the pasted reference — printed once, never beside its legacy PNR", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const order = await paidFlight("OLDPNR1");
    await setConfirmationNumber(String(order._id), "AXXXYY", { actor });

    await resendConfirmationEmail(String(order._id), { actor });

    const { text } = lastConfirmation();
    expect(text).toContain(
      "please keep this email for your records. PNR AXXXYY Budget New booking Booking details",
    );
    // Once — in the top block, not again as a booking-details row.
    expect(text.split("AXXXYY")).toHaveLength(2);
    expect(text.split("PNR")).toHaveLength(2);
    expect(text).not.toContain("OLDPNR1");
    expect(text).not.toContain("Confirmation number");
    // The collected charge, by its name, at what was collected.
    expect(text).toContain(`Rental Cost Paid $100.00 Order ${order.orderNumber}`);
  });

  it("FLIGHT: a flight created before the reference moved shows its own legacy PNR there", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const order = await paidFlight("LEGACY7");

    await resendConfirmationEmail(String(order._id), { actor });

    const { text } = lastConfirmation();
    expect(text).toContain("please keep this email for your records. PNR LEGACY7 Budget");
    expect(text.split("LEGACY7")).toHaveLength(2);
  });

  it("HOTEL: opens with 'Hotel confirmation number', and words its money the stay's way", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const order = await createPaidOrder({
      serviceType: ServiceType.HOTEL,
      pricing: { amount: 300, currency: "USD" as never },
      charges: [
        { name: "Room charge", amount: 300, timing: PaymentTiming.PREPAID },
        { name: "Resort fee", amount: 50, timing: PaymentTiming.DUE_AT_COUNTER },
      ],
    });
    await setConfirmationNumber(String(order._id), "83920174", { actor });

    await resendConfirmationEmail(String(order._id), { actor });

    const { text } = lastConfirmation();
    expect(text).toContain(
      "please keep this email for your records. Hotel confirmation number 83920174 Budget New booking Booking details",
    );
    expect(text.split("83920174")).toHaveLength(2);
    expect(text).toContain(
      "Charge breakdown Room charge $300.00 Resort fee (due at the property) $50.00 " +
        "Amount paid online $300.00 Amount due at the property $50.00 Total hotel cost $350.00",
    );
  });
});
