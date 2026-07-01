import { beforeEach, describe, expect, it } from "vitest";

import { OrderStatus, UserRole } from "@/lib/constants/enums";
import { summarizeCharges } from "@/lib/charges";
import { Order } from "@/server/db/models";
import {
  createOrder,
  initiatePayment,
  reconcileOrderPayment,
  resendConfirmationEmail,
  setConfirmationNumber,
} from "@/server/services/order.service";
import { recordTermsAcknowledgement } from "@/server/services/acknowledgement.service";
import { generateAckToken } from "@/server/services/ack-token";
import { actorFor } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { createSettings } from "@/tests/factories/settings.factory";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";

/**
 * Full rental journey, service-layer end-to-end:
 *   create (split charges + locations)
 *     → generate link (Stripe charged PREPAID ONLY)
 *       → pay (reconcile → PAID)
 *         → paste supplier confirmation number
 *           → resend confirmation (carries the number)
 *             → customer "I Agree" (acknowledgement recorded)
 */
beforeEach(async () => {
  await ensureMongo();
  await createSettings();
});

describe("rental journey (end-to-end)", () => {
  it("charges only the prepaid amount and threads the whole flow", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const stripe = getCurrentTestStripe();

    // 1) Create a booking: $150 prepaid + $350 due-at-counter ($500 total),
    //    with pick-up / drop-off locations.
    const input = validCreateOrderInput({
      currency: "USD",
      charges: [
        { name: "Rental cost", amount: 150, timing: "PREPAID" },
        { name: "Counter balance", amount: 350, timing: "DUE_AT_COUNTER" },
      ],
    });
    const { order: draft } = await createOrder(input, { actor });

    expect(draft.status).toBe(OrderStatus.NOT_INITIATED);
    // pricing.amount == prepaid total (the ONLY figure billed online)
    expect(draft.pricing.amount).toBe(150);
    expect(draft.charges).toHaveLength(2);
    expect(draft.trip.pickupLocation).toBe("LAX Airport — Terminal 1");
    expect(draft.trip.dropoffLocation).toBe("San Diego Downtown");

    // Single source of truth derivations
    const sum = summarizeCharges(draft.charges);
    expect(sum).toMatchObject({ prepaid: 150, dueAtCounter: 350, total: 500 });

    // 2) Generate the payment link → Stripe is asked for PREPAID ONLY.
    const { order: linked } = await initiatePayment(draft.id, { actor });
    expect(linked.status).toBe(OrderStatus.LINK_GENERATED);

    expect(stripe.sessionsCreated).toHaveLength(1);
    const unitAmount =
      stripe.sessionsCreated[0].params.line_items?.[0]?.price_data?.unit_amount;
    // $150.00 → 15000 minor units. NOT 50000 (total), NOT 35000 (counter).
    expect(unitAmount).toBe(15000);

    // 3) Customer completes checkout → reconcile drives the PAID transition.
    const session = stripe.sessionsCreated[0].result as unknown as {
      status: string;
      payment_status: string;
      amount_total: number | null;
    };
    session.status = "complete";
    session.payment_status = "paid";
    session.amount_total = 15000;

    const rec = await reconcileOrderPayment(linked.id, { actor });
    expect(rec.order.status).toBe(OrderStatus.PAID);
    // Reconciled amount reflects the prepaid charge only.
    expect(rec.order.payment.amountReceived).toBe(150);

    // 4) Agent pastes the supplier confirmation number after payment.
    const withNum = await setConfirmationNumber(linked.id, "SUPP-9F3K2218", {
      actor,
    });
    expect(withNum.confirmationNumber).toBe("SUPP-9F3K2218");

    // 5) Resend the confirmation email — re-renders with the number.
    const resent = await resendConfirmationEmail(linked.id, { actor });
    expect(resent.order.confirmationNumber).toBe("SUPP-9F3K2218");

    // 6) Customer clicks "I Agree" (public, token-validated).
    const token = generateAckToken(linked.id);
    const ack = await recordTermsAcknowledgement(token, { request: null });
    expect(ack.acknowledgedAt).toBeTruthy();

    const stored = await Order.findById(linked.id).lean();
    expect(stored?.status).toBe(OrderStatus.PAID);
    expect(stored?.pricing.amount).toBe(150);
    expect(stored?.confirmationNumber).toBe("SUPP-9F3K2218");
    expect(stored?.termsAcknowledgement?.acknowledgedAt).toBeInstanceOf(Date);
  });

  it("blocks a booking whose entire cost is due at counter (nothing to prepay)", async () => {
    const actor = actorFor(UserRole.ADMIN);
    // pricing.amount would be 0 → below the model's Stripe minimum → create fails.
    await expect(
      createOrder(
        validCreateOrderInput({
          currency: "USD",
          charges: [
            { name: "Everything at counter", amount: 500, timing: "DUE_AT_COUNTER" },
          ],
        }),
        { actor },
      ),
    ).rejects.toThrow();
  });
});
