import { PaymentGatewayKey } from "@/lib/constants/enums";
import { PaymentGatewayLabel } from "@/lib/constants/labels";
import { Organization } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { jsonOk, withApi } from "@/server/api/respond";
import { getOrganization } from "@/server/auth/organization";
import { enabledProvidersOf } from "@/server/payments/resolve-gateway";
import { requireUser } from "@/server/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Providers this codebase can actually transact with, in display order.
 *
 * Everything outside this list is an enum placeholder whose registry entry
 * throws, so it is never offered — not even greyed out. Being IN this list
 * means "implemented"; being in `enabledProviders` means "switched on".
 */
const SUPPORTED: PaymentGatewayKey[] = [
  PaymentGatewayKey.STRIPE,
  PaymentGatewayKey.PAYPAL,
];

/**
 * GET /api/organizations — the deployment's organization and its payment
 * configuration.
 *
 * There is exactly one organization, resolved server-side. It used to be
 * whichever one a cookie named, filtered through the caller's memberships;
 * both are gone, and with them the possibility of this returning `payments:
 * null` because no selection had been made — which would leave the composer's
 * provider dropdown empty and let it submit with no gateway at all.
 *
 * `supportedProviders` carries the enabled flag per provider rather than only
 * listing the usable ones, so the operator can SEE that PayPal exists and is
 * not available yet. Hiding it would misrepresent the roadmap; enabling it
 * would misrepresent the deployment.
 */
export const GET = withApi(async () => {
  await requireUser();
  const organization = await getOrganization();

  await connectMongo();
  const org = await Organization.findById(organization.id)
    .select("payments")
    .lean<{
      payments?: {
        provider?: PaymentGatewayKey;
        enabledProviders?: PaymentGatewayKey[];
      };
    } | null>();

  const enabled = enabledProvidersOf(org ?? {});
  // The default must be one the deployment can actually use, or the composer
  // would preselect a provider the server is about to refuse.
  const provider = enabled.includes(
    org?.payments?.provider ?? PaymentGatewayKey.STRIPE,
  )
    ? (org?.payments?.provider ?? PaymentGatewayKey.STRIPE)
    : enabled[0];

  return jsonOk({
    organizations: [organization],
    selectedId: organization.id,
    payments: {
      provider,
      enabledProviders: enabled,
      supportedProviders: SUPPORTED.map((key) => ({
        key,
        label: PaymentGatewayLabel[key],
        enabled: enabled.includes(key),
      })),
    },
  });
});
