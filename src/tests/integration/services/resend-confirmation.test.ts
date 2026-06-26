import { beforeEach, describe, expect, it } from "vitest";

import { ConflictError, ForbiddenError } from "@/lib/errors";
import { OrderStatus, UserRole } from "@/lib/constants/enums";
import { Order } from "@/server/db/models";
import {
  resendConfirmationEmail,
  setConfirmationNumber,
} from "@/server/services/order.service";
import { actorFor } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import {
  createOrder as factoryCreateOrder,
  createPaidOrder,
} from "@/tests/factories/order.factory";
import { createSettings } from "@/tests/factories/settings.factory";

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
});

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
