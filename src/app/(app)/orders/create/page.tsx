import { CreateOrderForm } from "@/components/features/orders/create-order-form";
import { PageHeader } from "@/components/common/page-header";
import { Permission } from "@/lib/constants/permissions";
import { CURRENCIES } from "@/lib/constants/enums";
import { requirePermission } from "@/server/auth/session";
import { getSettings } from "@/server/services/settings.service";
import { listActiveProviders } from "@/server/services/provider.service";

export const metadata = { title: "Create order" };
export const dynamic = "force-dynamic";

export default async function CreateOrderPage() {
  await requirePermission(Permission.ORDER_CREATE);
  const [settings, providers] = await Promise.all([
    getSettings(),
    listActiveProviders(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="New order"
        description="Capture booking details and generate a secure Stripe payment link to share with the customer."
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
