import { type NextRequest } from "next/server";

import { Permission } from "@/lib/constants/permissions";
import { assertPaidFeaturesEnabled } from "@/lib/paid-features";
import { ConflictError } from "@/lib/errors";
import { modifyOrderSchema } from "@/lib/validation";
import { getRequestContext } from "@/server/api/request-context";
import { jsonOk, withApi } from "@/server/api/respond";
import { requirePermission } from "@/server/auth/session";
import { applyOrderModification } from "@/server/services/order.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

/**
 * Order edit — apply a customer-requested change to an existing booking.
 * (Not "MCO": MCO is the amount being charged now; a change here may
 * re-price it, but the edit itself is a booking change.)
 *
 * Amends the order in place; never creates one. The response returns the
 * field-level diff so the operator UI can show exactly what moved, and
 * `amountChanged` so it can say whether a new payment link is needed.
 */
export const POST = withApi(
  async (req: NextRequest, { params }: Params) => {
    const actor = await requirePermission(Permission.ORDER_UPDATE);
    // A paid feature, switched off until paid for: see src/lib/paid-features.ts.
    assertPaidFeaturesEnabled();
    const { id } = await params;
    const body = modifyOrderSchema.parse(await req.json());
    // The edit page always says which version it was filled from. A request
    // that does not — a tab still running the JavaScript from before this
    // check existed, or a hand-made call — could silently revert a newer
    // change, so it is refused rather than applied blind.
    if (!body.expectedUpdatedAt) {
      throw new ConflictError(
        "This page is out of date. Reload it, then make your change again.",
      );
    }
    const ctx = await getRequestContext();

    const result = await applyOrderModification(id, body, {
      actor,
      request: ctx,
    });
    return jsonOk(result);
  },
  { rateLimit: { route: "order-modify", max: 30, windowMs: 60_000 } },
);
