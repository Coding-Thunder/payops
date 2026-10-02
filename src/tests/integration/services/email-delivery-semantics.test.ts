import { beforeEach, describe, expect, it, vi } from "vitest";

import { UserRole } from "@/lib/constants/enums";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * "email_sent" MUST MEAN AN EMAIL WAS SENT.
 *
 * `sendEmail` throws on a transport error, so a genuine SMTP failure never
 * reached the success path. But with NO transport configured it logged,
 * recorded EMAIL_FAILED and returned NORMALLY — and the caller went on to
 * emit `order.lifecycle.transition transition="email_sent"` and publish
 * ORDER_EMAIL_SENT. The operator's timeline then showed "Email sent" for an
 * email that was never handed to anything.
 *
 * These pin the distinction, for car orders as much as flight: the lifecycle
 * claim is gated on actual delivery, and the outbox retries instead of
 * marking an undelivered row SENT.
 */

const { mailerState } = vi.hoisted(() => ({
  mailerState: { enabled: true, sent: [] as Array<Record<string, unknown>> },
}));

vi.mock("@/server/email/smtp", () => {
  const stub = {
    sendMail: async (m: Record<string, unknown>) => {
      mailerState.sent.push(m);
      return { messageId: "<ok>", response: "250 OK" };
    },
  };
  return {
    // null is exactly what getMailer returns with no SMTP_* configured.
    getMailer: () => (mailerState.enabled ? stub : null),
    getMailerFor: () => (mailerState.enabled ? stub : null),
    verifyMailer: async () => {},
    _resetOrgMailersForTests: () => {},
    applyGlobalCc: <T,>(m: T) => m,
  };
});

const { sendPaymentRequestEmail, sendPaymentConfirmationEmail } = await import(
  "@/server/services/email.service"
);
const { createOrder, getOrderById, initiatePayment } = await import(
  "@/server/services/order.service"
);
const { logger } = await import("@/lib/logger");

const actor = actorFor(UserRole.ADMIN);

async function linkedOrder() {
  const created = await createOrder(validCreateOrderInput(), { actor });
  await initiatePayment(created.order.id, { actor });
  return getOrderById(created.order.id, { actor });
}

function emailSentTransitions(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.filter(
    (c) =>
      String(c[0]) === "order.lifecycle.transition" &&
      (c[1] as { transition?: string } | undefined)?.transition ===
        "email_sent",
  );
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await mockSession(actor);
  mailerState.enabled = true;
  mailerState.sent.length = 0;
});

describe("with a working transport", () => {
  it("reports delivery and claims email_sent", async () => {
    const order = await linkedOrder();
    const info = vi.spyOn(logger, "info");

    const result = await sendPaymentRequestEmail(order, {}, { actor });

    expect(result.delivered).toBe(true);
    expect(mailerState.sent).toHaveLength(1);
    expect(emailSentTransitions(info)).toHaveLength(1);
    info.mockRestore();
  });
});

describe("with NO transport configured", () => {
  it("does not claim email_sent", async () => {
    const order = await linkedOrder();
    mailerState.enabled = false;
    const info = vi.spyOn(logger, "info");

    const result = await sendPaymentRequestEmail(order, {}, { actor });

    expect(result.delivered).toBe(false);
    expect(mailerState.sent).toHaveLength(0);
    expect(emailSentTransitions(info)).toHaveLength(0);
    info.mockRestore();
  });

  it("says so on the confirmation path too", async () => {
    const created = await createOrder(validCreateOrderInput(), { actor });
    const dto = await getOrderById(created.order.id, { actor });
    mailerState.enabled = false;

    const result = await sendPaymentConfirmationEmail(dto);
    expect(result.delivered).toBe(false);
  });

  it("makes the outbox retry rather than mark the row SENT", async () => {
    const { enqueueEmail, drainOnePendingEmail } = await import(
      "@/server/services/email-outbox.service"
    );
    const { EmailKind } = await import("@/lib/constants/enums");
    const { PendingEmailStatus } = await import(
      "@/server/db/models/outbox.model"
    );
    const created = await createOrder(validCreateOrderInput(), { actor });
    await enqueueEmail(
      {
        orderId: created.order.id,
        kind: EmailKind.PAYMENT_CONFIRMATION,
        recipient: "ada@payops.test",
      },
      null,
    );

    mailerState.enabled = false;
    const result = await drainOnePendingEmail();
    expect(result?.status).not.toBe(PendingEmailStatus.SENT);
  });

  it("marks the row SENT once a transport is available", async () => {
    const { enqueueEmail, drainOnePendingEmail } = await import(
      "@/server/services/email-outbox.service"
    );
    const { EmailKind } = await import("@/lib/constants/enums");
    const { PendingEmailStatus } = await import(
      "@/server/db/models/outbox.model"
    );
    const created = await createOrder(validCreateOrderInput(), { actor });
    await enqueueEmail(
      {
        orderId: created.order.id,
        kind: EmailKind.PAYMENT_CONFIRMATION,
        recipient: "ada@payops.test",
      },
      null,
    );

    const result = await drainOnePendingEmail();
    expect(result?.status).toBe(PendingEmailStatus.SENT);
  });
});
