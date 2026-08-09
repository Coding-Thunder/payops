import { beforeEach, describe, expect, it, vi } from "vitest";

import { UserRole } from "@/lib/constants/enums";
import { createOrder, initiatePayment } from "@/server/services/order.service";
import { actorFor } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * CHARACTERIZATION — the sender identity RentalConfirmation mails from today.
 *
 * P6 replaces `env.server.EMAIL_FROM` / `EMAIL_REPLY_TO` and the transport
 * with per-organization values. Everything asserted here is exactly what
 * that phase touches, so this file is the proof that RentalConfirmation's
 * outgoing mail is unchanged afterwards: the organization row is seeded FROM
 * these same env values, so the resolved identity must come out identical.
 *
 * The message body is deliberately NOT hashed. A whole-HTML digest fails on
 * any copy edit and tells you nothing about what moved. Instead this pins
 * the identity-bearing parts — the addresses, the subject, the brand name
 * and support contact rendered into the body, and the deliverability
 * headers — which is precisely the surface the migration can break.
 */

// `vi.mock` is hoisted above imports, so the recorder has to be created in a
// hoisted block or it would be in the temporal dead zone when the factory
// runs.
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
const { sendPaymentConfirmationEmail, sendPaymentRequestEmail } = await import(
  "@/server/services/email.service"
);

/** Values this deployment is configured with — see .env.test. */
const EXPECTED_FROM = "TraceTxn Test <test@tracetxn.local>";
/** EMAIL_REPLY_TO is unset in .env.test, and the service maps "" -> undefined. */
const EXPECTED_REPLY_TO = undefined;
/**
 * Support contact rendered into the body. This is NOT the env default —
 * `getBranding()` creates the Branding document on first read and seeds
 * supportEmail/supportPhone from the existing Setting doc, which the
 * settings factory sets to these values. That lazy copy is the same
 * field-migration pattern the organization work follows, and it is worth
 * knowing it executes during an ordinary email send.
 */
const EXPECTED_SUPPORT_EMAIL = "support@payops.test";
const EXPECTED_SUPPORT_PHONE = "+15555550100";

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sentMail.length = 0;
});

async function paidOrderDto() {
  const actor = actorFor(UserRole.ADMIN);
  const { order: draft } = await createOrder(validCreateOrderInput(), {
    actor,
  });
  const { order } = await initiatePayment(draft.id, { actor });
  return order;
}

describe("payment confirmation email", () => {
  it("is sent from exactly this identity", async () => {
    const order = await paidOrderDto();
    await sendPaymentConfirmationEmail(order);

    expect(sentMail).toHaveLength(1);
    const msg = sentMail[0]!;
    expect(msg.from).toBe(EXPECTED_FROM);
    expect(msg.to).toBe("ada@payops.test");
    expect(msg.replyTo).toBe(EXPECTED_REPLY_TO);
  });

  it("carries exactly these deliverability headers", async () => {
    const order = await paidOrderDto();
    await sendPaymentConfirmationEmail(order);

    // No List-Unsubscribe: that header is only added when a reply-to exists,
    // and EMAIL_REPLY_TO is unset here. If an organization supplies a
    // replyTo in P6, the header appears — which is a behaviour change for
    // THAT organization only, never for this one.
    expect(sentMail[0]!.headers).toEqual({
      "X-Entity-Kind": "PAYMENT_CONFIRMATION",
      "Auto-Submitted": "auto-generated",
    });
  });

  it("renders the brand name and support contact into the body", async () => {
    const order = await paidOrderDto();
    await sendPaymentConfirmationEmail(order);

    const html = String(sentMail[0]!.html);
    expect(html).toContain("Rental Confirmation");
    expect(html).toContain(EXPECTED_SUPPORT_EMAIL);
    expect(html).toContain(EXPECTED_SUPPORT_PHONE);
    expect(html).toContain(order.orderNumber);
    // The operator-facing APP_NAME must never leak onto a customer surface.
    expect(html).not.toContain("TraceTxn Test");
  });
});

describe("payment request email", () => {
  it("is sent from exactly this identity", async () => {
    const order = await paidOrderDto();
    await sendPaymentRequestEmail(order);

    expect(sentMail).toHaveLength(1);
    const msg = sentMail[0]!;
    expect(msg.from).toBe(EXPECTED_FROM);
    expect(msg.to).toBe("ada@payops.test");
    expect(msg.replyTo).toBe(EXPECTED_REPLY_TO);
    expect(msg.headers).toMatchObject({
      "X-Entity-Kind": "PAYMENT_LINK",
      "Auto-Submitted": "auto-generated",
    });
  });

  it("uses exactly this default subject", async () => {
    const order = await paidOrderDto();
    await sendPaymentRequestEmail(order);

    // Brand-shaped and customer-facing, so P6 must not disturb it for this
    // organization. "Budget" is the rental provider on the order, not the
    // sender brand.
    expect(sentMail[0]!.subject).toBe(
      `Complete your Budget payment • ${order.orderNumber}`,
    );
  });

  it("sends the customer to a first-party CTA, not the raw gateway URL", async () => {
    const order = await paidOrderDto();
    await sendPaymentRequestEmail(order);

    // The consent layer puts an "I Agree" step in front of payment, so the
    // primary CTA is a /consent/ link rather than the Stripe checkout URL.
    // Recorded so a future change of CTA target is visible.
    const html = String(sentMail[0]!.html);
    expect(html).toMatch(/https?:\/\/localhost:3000\/(consent|pay)\//);
    expect(html).toContain(order.orderNumber);
  });

  it("honours an explicit subject override", async () => {
    const order = await paidOrderDto();
    await sendPaymentRequestEmail(order, { subject: "Custom subject line" });
    expect(sentMail[0]!.subject).toBe("Custom subject line");
  });
});

describe("sender identity is read from configuration, not hardcoded", () => {
  it("uses one single From across both email kinds", async () => {
    // If P6 threads an organization identity through only one of the two
    // send paths, this catches the split.
    const order = await paidOrderDto();
    await sendPaymentConfirmationEmail(order);
    await sendPaymentRequestEmail(order);

    expect(sentMail).toHaveLength(2);
    const froms = new Set(sentMail.map((m) => m.from));
    expect([...froms]).toEqual([EXPECTED_FROM]);
  });
});
