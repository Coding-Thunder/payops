import Link from "next/link";
import { ArrowRightIcon, GaugeIcon, LockKeyholeIcon } from "lucide-react";

import { PageHeader } from "@/components/common/page-header";
import { DynamicOrderForm } from "@/components/features/orders/dynamic-order-form";
import { Button } from "@/components/ui/button";
import { CURRENCIES } from "@/lib/constants/enums";
import { Permission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";
import { getOrderQuotaSnapshot } from "@/server/services/billing.service";
import { listActiveItemTypes } from "@/server/services/item-type.service";
import { listActiveItems } from "@/server/services/item.service";
import { getSettings } from "@/server/services/settings.service";

export const metadata = { title: "Create order" };
export const dynamic = "force-dynamic";

export default async function CreateOrderPage() {
  const actor = await requirePermission(Permission.ORDER_CREATE);
  const [settings, itemTypes, catalogItems, quota] = await Promise.all([
    getSettings(actor.orgId),
    listActiveItemTypes(actor.orgId ?? null),
    actor.orgId ? listActiveItems(actor.orgId) : Promise.resolve([]),
    getOrderQuotaSnapshot(actor.orgId ?? null),
  ]);

  const headerExtra = Number.isFinite(quota.limit) ? (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-[11.5px] text-muted-foreground"
      title={`Plan: ${quota.plan.name}`}
    >
      <GaugeIcon className="size-3" />
      <span className="font-medium text-foreground">
        {quota.current} / {quota.limit}
      </span>
      active orders
    </span>
  ) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Create order"
        description="Pick what's being sold, fill in the fields, and we'll generate the payment link when you send the request email."
        actions={headerExtra}
      />
      {quota.atLimit ? (
        <div className="rounded-2xl border border-border bg-card p-7 shadow-sm">
          <div className="flex items-start gap-4">
            <span
              className="inline-flex size-10 shrink-0 items-center justify-center rounded-full"
              style={{
                background:
                  "color-mix(in oklch, var(--brand-emerald) 14%, white)",
                color: "var(--brand-emerald-strong)",
              }}
            >
              <LockKeyholeIcon className="size-5" />
            </span>
            <div className="space-y-3">
              <div>
                <h2 className="font-display text-[18px] font-semibold tracking-tight">
                  You&apos;ve reached your {quota.plan.name} limit
                </h2>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">
                  Your plan caps at{" "}
                  <span className="font-medium text-foreground">
                    {quota.limit} active orders
                  </span>{" "}
                  at a time. You currently have{" "}
                  <span className="font-medium text-foreground">
                    {quota.current}
                  </span>{" "}
                  open. Resolve a pending order (mark it paid, expire it,
                  or archive it), or upgrade for more headroom.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button asChild size="sm" className="gap-1.5">
                  <Link href="/pricing">
                    See plans
                    <ArrowRightIcon className="size-3.5" />
                  </Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href="/app/orders">Review open orders</Link>
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <DynamicOrderForm
          itemTypes={itemTypes}
          catalogItems={catalogItems}
          defaultCurrency={settings.defaultCurrency}
          allowedCurrencies={CURRENCIES}
        />
      )}
    </div>
  );
}
