import { CreateOrderForm } from "@/components/features/orders/create-order-form";
import { PageHeader } from "@/components/common/page-header";
import { CURRENCIES } from "@/lib/constants/enums";
import { Permission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";
import { listActiveProviders } from "@/server/services/provider.service";
import { getSettings } from "@/server/services/settings.service";

export const metadata = { title: "Create order" };
export const dynamic = "force-dynamic";

/**
 * Step 1 of the linear flow — booking entry.
 *
 * Server-rendered page that fetches what the form binds against
 * (allowed booking types, default currency, active providers) and
 * renders the form directly. On submit the form posts /api/orders and
 * routes the agent to /orders/[id]/email. No internal tabs, no drafts
 * autosave, no workspace shell.
 */
export default async function CreateOrderPage() {
  await requirePermission(Permission.ORDER_CREATE);
  const [settings, providers] = await Promise.all([
    getSettings(),
    listActiveProviders(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Create order"
        description="Capture booking details. The payment link is generated when you send the request email."
      />
      <CreateOrderForm
        allowedBookingTypes={settings.allowedBookingTypes}
        defaultCurrency={settings.defaultCurrency}
        allowedCurrencies={CURRENCIES}
        providers={providers}
      />
    </div>
  );
}
