import { beforeEach, describe, expect, it } from "vitest";

import { BadRequestError } from "@/lib/errors";
import { Order } from "@/server/db/models";
import {
  getPublicAcknowledgementView,
  recordTermsAcknowledgement,
} from "@/server/services/acknowledgement.service";
import { generateAckToken } from "@/server/services/ack-token";
import { ensureMongo } from "@/tests/utils/db";
import { createPaidOrder } from "@/tests/factories/order.factory";
import { createSettings } from "@/tests/factories/settings.factory";

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
});

describe("terms acknowledgement flow", () => {
  it("records the customer's acknowledgement from a signed token (no auth)", async () => {
    const order = await createPaidOrder({});
    const token = generateAckToken(String(order._id));

    const before = await getPublicAcknowledgementView(token);
    expect(before.acknowledgedAt).toBeNull();

    const after = await recordTermsAcknowledgement(token, { request: null });
    expect(after.acknowledgedAt).toBeTruthy();

    const stored = await Order.findById(order._id).lean();
    expect(stored?.termsAcknowledgement?.acknowledgedAt).toBeInstanceOf(Date);
  });

  it("is idempotent on duplicate clicks — does not re-stamp", async () => {
    const order = await createPaidOrder({});
    const token = generateAckToken(String(order._id));

    const first = await recordTermsAcknowledgement(token, { request: null });
    const second = await recordTermsAcknowledgement(token, { request: null });
    // Same timestamp — the second click returns the existing record.
    expect(second.acknowledgedAt).toBe(first.acknowledgedAt);
  });

  it("rejects an invalid / malformed token", async () => {
    await expect(
      getPublicAcknowledgementView("not-a-real-token"),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("a token can only acknowledge its own booking", async () => {
    const a = await createPaidOrder({});
    const b = await createPaidOrder({});
    const tokenA = generateAckToken(String(a._id));

    await recordTermsAcknowledgement(tokenA, { request: null });

    const storedA = await Order.findById(a._id).lean();
    const storedB = await Order.findById(b._id).lean();
    expect(storedA?.termsAcknowledgement?.acknowledgedAt).toBeInstanceOf(Date);
    // Order B is untouched — the token is bound to A's id.
    expect(storedB?.termsAcknowledgement ?? null).toBeNull();
  });
});
