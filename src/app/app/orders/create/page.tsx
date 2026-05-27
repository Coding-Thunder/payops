import { PageHeader } from "@/components/common/page-header";
import { DynamicOrderForm } from "@/components/features/orders/dynamic-order-form";
import { CURRENCIES } from "@/lib/constants/enums";
import { Permission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";
import { listActiveItemTypes } from "@/server/services/item-type.service";
import { getSettings } from "@/server/services/settings.service";

export const metadata = { title: "Create order" };
export const dynamic = "force-dynamic";

/**
 * Pass 5e — Universal create-order page.
 *
 * The form is dynamic: the operator picks an ItemType from the org's
 * catalog, and the form renders whatever `attributeSchema` that ItemType
 * declares. Tenant #1's rental flow is now just one option among many —
 * the auto-seeded `rental_booking` ItemType — selected from the same
 * picker as `milk_carton`, `service_visit`, or anything else the admin
 * has defined.
 */
export default async function CreateOrderPage() {
  const actor = await requirePermission(Permission.ORDER_CREATE);
  const [settings, itemTypes] = await Promise.all([
    getSettings(actor.orgId),
    listActiveItemTypes(actor.orgId ?? null),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Create order"
        description="Pick what's being sold, fill in the fields, and we'll generate the payment link when you send the request email."
      />
      <DynamicOrderForm
        itemTypes={itemTypes}
        defaultCurrency={settings.defaultCurrency}
        allowedCurrencies={CURRENCIES}
      />
    </div>
  );
}
