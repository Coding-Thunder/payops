import { beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import {
  OrderEvidenceActorType,
  OrderEvidenceEventType,
  UserRole,
} from "@/lib/constants/enums";
import { OrderEvidence, Provider } from "@/server/db/models";
import { sendPaymentConfirmationEmail } from "@/server/services/email.service";
import {
  getOrderById,
  resendConfirmationEmail,
} from "@/server/services/order.service";
import {
  createProvider,
  invalidateProviderLogoCache,
} from "@/server/services/provider.service";
import { createPaidOrder } from "@/tests/factories/order.factory";
import { createSettings } from "@/tests/factories/settings.factory";
import { actorFor } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";

/**
 * Who sent a confirmation email, as the dispute packet records it.
 *
 * The automatic confirmation is the payment webhook's. A RESEND is an
 * agent's deliberate act — usually after pasting the booking reference —
 * and its evidence row must say so: attributed to that agent, marked as a
 * resend. Otherwise a dispute reviewer reads a second "payment webhook"
 * receipt days after the payment and cannot tell what happened.
 */

const actor = actorFor(UserRole.ADMIN, { name: "Rita Resend", email: "rita@payops.test" });

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
});

interface EvidenceRow {
  actor: { type: string; userId?: unknown; name?: string | null; email?: string | null; role?: string | null };
  payload: Record<string, unknown>;
}

async function confirmationRows(orderId: string | Types.ObjectId): Promise<EvidenceRow[]> {
  return OrderEvidence.find({
    orderId: new Types.ObjectId(String(orderId)),
    eventType: OrderEvidenceEventType.CONFIRMATION_EMAIL_SENT,
  })
    .sort({ sequence: 1 })
    .lean<EvidenceRow[]>();
}

describe("resendConfirmationEmail — the evidence row is the agent's", () => {
  it("attributes the resend to the agent who asked for it, and marks it a resend", async () => {
    const order = await createPaidOrder({});
    await resendConfirmationEmail(String(order._id), { actor });

    const rows = await confirmationRows(order._id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toMatchObject({
      type: OrderEvidenceActorType.AGENT,
      name: "Rita Resend",
      email: "rita@payops.test",
      role: UserRole.ADMIN,
    });
    expect(String(rows[0]!.actor.userId)).toBe(actor.id);
    expect(rows[0]!.payload.resend).toBe(true);
  });

  it("keeps the automatic confirmation the payment webhook's, with no resend flag", async () => {
    const order = await createPaidOrder({});
    await sendPaymentConfirmationEmail(await getOrderById(String(order._id), { actor }));

    const rows = await confirmationRows(order._id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toMatchObject({
      type: OrderEvidenceActorType.SYSTEM,
      name: "Payment webhook",
    });
    expect("resend" in rows[0]!.payload).toBe(false);
  });
});

describe("resendConfirmationEmail — the resent email shows the provider's live logo", () => {
  /** A logo path destroyed by an old deploy, frozen on the order. */
  const DEAD_LOGO = "/providers/avis-563c9c0b.jpg";
  const LIVE_LOGO = "/providers/avis-live-logo.png";

  it("renders the provider's current logo, not the order's dead snapshot, even from a cold cache", async () => {
    await createProvider(
      {
        key: "AVIS",
        name: "AVIS",
        logo: DEAD_LOGO,
        primaryColor: "#1E3A8A",
        onPrimaryColor: "#FFFFFF",
        tagline: "",
        sortOrder: 0,
      } as Parameters<typeof createProvider>[0],
      { actor },
    );
    await Provider.updateOne({ key: "AVIS" }, { $set: { logo: LIVE_LOGO } });
    const order = await createPaidOrder({
      provider: { id: "AVIS", name: "AVIS", logo: DEAD_LOGO, primaryColor: null, onPrimaryColor: null },
    });
    // What the automatic send's path guarantees by warming first; a resend
    // must not depend on some earlier request having warmed it.
    invalidateProviderLogoCache();

    const result = await resendConfirmationEmail(String(order._id), { actor });
    expect(result.order.provider.logo).toBe(LIVE_LOGO);

    const [row] = await confirmationRows(order._id);
    const html = String(row!.payload.html);
    expect(html).toContain("avis-live-logo.png");
    expect(html).not.toContain("avis-563c9c0b.jpg");
  });
});
