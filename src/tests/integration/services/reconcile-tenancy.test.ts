import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import {
  PaymentGatewayKey,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import { Organization, OrganizationMember } from "@/server/db/models";
import {
  createOrder,
  reconcileOrderPayment,
} from "@/server/services/order.service";
import { orgCookieName } from "@/server/auth/org-cookie";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { setNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo } from "@/tests/utils/db";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * Cross-tenant protection on the reconcile path.
 *
 * WHY THIS FILE EXISTS: `reconcileOrderPayment` was the ONLY order-by-id
 * service function without an `assertOrderInScope` call, while eight
 * siblings had one. Its only guard was `ORDER_VIEW_ALL`, which is a ROLE
 * check, not a TENANT check — so an ADMIN of one brand who supplied
 * another brand's order id received the full OrderDTO (customer name,
 * email, phone, amounts) AND could drive that order to PAID, firing a
 * confirmation email against the other brand's Stripe account.
 *
 * The fix is deliberately scoped to the AUTHENTICATED branch only. The
 * public /pay/success caller passes no ctx, carries no organization cookie,
 * and would resolve to denyAll — scoping that path would break the payment
 * success page for every brand. Its protection is the session-id pairing,
 * which `reconcile.test.ts` already pins and which must keep working.
 */

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

async function makeOrg(slug: string, isDefault: boolean, userId: string) {
  const doc = await Organization.create({
    slug,
    name: slug,
    brandName: `${slug} brand`,
    isDefault,
    payments: { provider: PaymentGatewayKey.STRIPE },
  });
  const id = doc._id as Types.ObjectId;
  await OrganizationMember.create({
    organizationId: id,
    userId: new Types.ObjectId(userId),
    role: UserRole.ADMIN,
    status: RecordState.ACTIVE,
  });
  return id;
}

function actingAs(orgId: Types.ObjectId | null) {
  setNextHeaders(
    orgId ? { cookies: { [orgCookieName()]: String(orgId) } } : {},
  );
}

const admin = actorFor(UserRole.ADMIN);

let rentalOrg: Types.ObjectId;
let globevistaOrg: Types.ObjectId;

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sessionMock = await mockSession(admin);
  rentalOrg = await makeOrg("rentalconfirmation", true, admin.id);
  globevistaOrg = await makeOrg("globevista", false, admin.id);
});

afterEach(() => {
  if (sessionMock) {
    sessionMock.restore();
    sessionMock = null;
  }
});

describe("reconcileOrderPayment tenancy", () => {
  it("refuses an order belonging to another organization, even for an ADMIN with ORDER_VIEW_ALL", async () => {
    // An order created while acting as GlobeVista.
    actingAs(globevistaOrg);
    const { order: globevistaOrder } = await createOrder(
      validCreateOrderInput(),
      { actor: admin },
    );

    // Same human, now acting as RentalConfirmation, reaches for the other
    // brand's order by id. ORDER_VIEW_ALL would have let this through.
    actingAs(rentalOrg);
    await expect(
      reconcileOrderPayment(globevistaOrder.id, { actor: admin }),
    ).rejects.toThrow(/not found/i);
  });

  it("still allows reconcile for an order in the caller's OWN organization", async () => {
    actingAs(globevistaOrg);
    const { order } = await createOrder(validCreateOrderInput(), {
      actor: admin,
    });

    // No payment session yet, so this returns the early "nothing to
    // reconcile" result rather than throwing — the point is that the
    // tenancy check did NOT reject it.
    const result = await reconcileOrderPayment(order.id, { actor: admin });
    expect(result.order.id).toBe(order.id);
    expect(result.stripeStatus).toBe("unknown");
  });

  it("the default organization can still reconcile an UNATTRIBUTED pre-migration order", async () => {
    // Orders written before organizations existed carry no organizationId.
    // The default org's scope clause must still match them, or this change
    // would break RentalConfirmation's access to its own history.
    actingAs(null);
    const { order } = await createOrder(validCreateOrderInput(), {
      actor: admin,
    });

    actingAs(rentalOrg);
    const result = await reconcileOrderPayment(order.id, { actor: admin });
    expect(result.order.id).toBe(order.id);
  });

  it("a NON-default organization cannot reach an unattributed order", async () => {
    actingAs(null);
    const { order } = await createOrder(validCreateOrderInput(), {
      actor: admin,
    });

    actingAs(globevistaOrg);
    await expect(
      reconcileOrderPayment(order.id, { actor: admin }),
    ).rejects.toThrow(/not found/i);
  });
});
