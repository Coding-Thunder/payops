import { PageHeader } from "@/components/common/page-header";
import { DynamicOrderForm } from "@/components/features/orders/dynamic-order-form";
import { CURRENCIES } from "@/lib/constants/enums";
import { Permission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";
import { listActiveItemTypes } from "@/server/services/item-type.service";
import { listActiveItems } from "@/server/services/item.service";
import { getSettings } from "@/server/services/settings.service";

export const metadata = { title: "Create order" };
export const dynamic = "force-dynamic";

/**
 * Universal create-order page.
 *
 * The form is dynamic: the operator picks an ItemType from the org's
 * catalog OR picks a saved catalog Item that pre-fills name + price +
 * attributes (Pass 6c). Tenant #1's rental flow is now just one option
 * among many — the auto-seeded `rental_booking` ItemType.
 */
export default async function CreateOrderPage() {
  const actor = await requirePermission(Permission.ORDER_CREATE);
  const [settings, itemTypes, catalogItems] = await Promise.all([
    getSettings(actor.orgId),
    listActiveItemTypes(actor.orgId ?? null),
    actor.orgId ? listActiveItems(actor.orgId) : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Create order"
        description="Pick what's being sold, fill in the fields, and we'll generate the payment link when you send the request email."
      />
      <DynamicOrderForm
        itemTypes={itemTypes}
        catalogItems={catalogItems}
        defaultCurrency={settings.defaultCurrency}
        allowedCurrencies={CURRENCIES}
      />
    </div>
  );
}
