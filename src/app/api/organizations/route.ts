import { PaymentGatewayKey } from "@/lib/constants/enums";
import { Organization } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { jsonOk, withApi } from "@/server/api/respond";
import {
  getSelectedOrganization,
  listMemberOrganizations,
} from "@/server/auth/organization";
import { requireUser } from "@/server/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/organizations — the organizations the caller may act in, plus
 * which one is currently selected.
 *
 * Scoped to the caller's own memberships; there is no "list all
 * organizations" surface, because a user has no legitimate reason to learn
 * that other tenants exist.
 */
export const GET = withApi(async () => {
  await requireUser();
  const [organizations, selected] = await Promise.all([
    listMemberOrganizations(),
    getSelectedOrganization(),
  ]);
  // Which gateways the SELECTED organization may use. The email composer
  // renders its provider dropdown from this instead of a hardcoded list —
  // otherwise it shows "Stripe (available)" to a PayPal-only brand and tells
  // the operator the money is going somewhere it is not.
  let payments: {
    provider: PaymentGatewayKey;
    enabledProviders: PaymentGatewayKey[];
  } | null = null;

  if (selected) {
    await connectMongo();
    const org = await Organization.findById(selected.id)
      .select("payments")
      .lean<{
        payments?: {
          provider?: PaymentGatewayKey;
          enabledProviders?: PaymentGatewayKey[];
        };
      } | null>();
    const provider = org?.payments?.provider ?? PaymentGatewayKey.STRIPE;
    const enabled =
      org?.payments?.enabledProviders && org.payments.enabledProviders.length > 0
        ? org.payments.enabledProviders
        : [provider];
    payments = { provider, enabledProviders: enabled };
  }

  return jsonOk({
    organizations,
    selectedId: selected?.id ?? null,
    payments,
  });
});
