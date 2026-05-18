"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { ArrowLeftIcon } from "lucide-react";

import { ArchiveOrderButton } from "@/components/features/orders/archive-order-button";
import { EmailComposer } from "@/components/features/orders/email-composer";
import { OrderDetailsCard } from "@/components/features/orders/order-details-card";
import { OrderPaymentCard } from "@/components/features/orders/order-payment-card";
import { PaymentStatusFloater } from "@/components/features/orders/payment-status-floater";
import { RiskFlagDialog } from "@/components/features/disputes/risk-flag-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { PageHeader } from "@/components/common/page-header";
import {
  OrderDetailsSkeleton,
} from "@/components/common/skeletons";
import {
  OrderStatusBadge,
  RecordStateBadge,
} from "@/components/common/status-badges";
import { ApiClientError } from "@/lib/api-client";
import { OrderStatus, RecordState } from "@/lib/constants/enums";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import type { UserRole } from "@/lib/constants/enums";

import { useOrderQuery } from "../hooks/use-order-query";
import { useWorkspaceStore } from "../store";
import { useTabPermissions } from "../hooks/use-tab-permissions";

interface OrderDetailsTabContentProps {
  tabId: string;
  orderId: string;
  /** Which sub-section to scroll to on first mount. */
  focus?: "overview" | "payment";
}

/**
 * Per-tab content for the ORDER_DETAILS / PAYMENT_REVIEW workspace tabs.
 *
 * Isolation contract:
 *  - Each tab instance owns its own React Query subscription keyed by
 *    orderId — switching tabs preserves the previous tab's cached data.
 *  - The "focus=payment" variant scrolls the payment section into view on
 *    mount but otherwise shares the same render tree.
 *  - Once the order resolves, the tab label updates to the order number so
 *    the strip stops showing the temporary "Order" placeholder.
 */
export function OrderDetailsTabContent({
  tabId,
  orderId,
  focus = "overview",
}: OrderDetailsTabContentProps) {
  const router = useRouter();
  const updateTabMeta = useWorkspaceStore((s) => s.updateTabMeta);
  const evictTab = useWorkspaceStore((s) => s.evictTab);

  const { data: order, error, isLoading } = useOrderQuery(orderId);
  const { role } = useTabPermissions();

  const paymentSectionRef = React.useRef<HTMLDivElement | null>(null);
  const didFocusRef = React.useRef(false);

  // Update the tab label once we have the order number.
  React.useEffect(() => {
    if (!order) return;
    const label =
      focus === "payment"
        ? `${order.orderNumber} · Payment`
        : order.orderNumber;
    updateTabMeta(tabId, {
      label,
      subtitle: `${order.customer.name} · ${order.customer.email}`,
    });
  }, [order, focus, tabId, updateTabMeta]);

  // Scroll the focused section into view on first mount.
  React.useEffect(() => {
    if (didFocusRef.current) return;
    if (focus !== "payment") return;
    if (!order) return;
    const node = paymentSectionRef.current;
    if (!node) return;
    didFocusRef.current = true;
    requestAnimationFrame(() => {
      node.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [order, focus]);

  if (isLoading) return <OrderDetailsSkeleton />;

  if (error) {
    const isMissing =
      error instanceof ApiClientError &&
      (error.status === 404 || error.status === 403);
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="w-fit">
          <Link href="/orders">
            <ArrowLeftIcon className="size-3.5" />
            Back to orders
          </Link>
        </Button>
        <Alert variant="destructive">
          <AlertTitle>
            {isMissing ? "Order not found" : "Could not load this order"}
          </AlertTitle>
          <AlertDescription>
            {isMissing
              ? "It may have been archived or deleted. Close this tab to clean up your workspace."
              : error.message}
          </AlertDescription>
        </Alert>
        {isMissing ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              evictTab(tabId);
              router.push("/orders");
            }}
          >
            Close tab
          </Button>
        ) : null}
      </div>
    );
  }

  if (!order) return null;

  const canRegenerate = roleHasPermission(
    role,
    Permission.ORDER_REGENERATE_LINK,
  );
  const canArchive =
    roleHasPermission(role, Permission.ORDER_ARCHIVE) &&
    order.state === RecordState.ACTIVE &&
    order.status !== OrderStatus.PAID;
  const canFlagRisk = roleHasPermission(role, Permission.ORDER_UPDATE);

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="w-fit">
        <Link href="/orders">
          <ArrowLeftIcon className="size-3.5" />
          Back to orders
        </Link>
      </Button>
      <PageHeader
        title={order.orderNumber}
        description="Order details and payment status."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <OrderStatusBadge status={order.status} />
            {order.state !== RecordState.ACTIVE ? (
              <RecordStateBadge state={order.state} />
            ) : null}
            {order.risk.flagged ? (
              <Badge variant="destructive">Flagged</Badge>
            ) : null}
            {canFlagRisk ? <RiskFlagDialog order={order} /> : null}
            {canArchive ? <ArchiveOrderButton orderId={order.id} /> : null}
          </div>
        }
      />
      {/* Live payment status — sticks below the topbar and flips
          colour the instant Stripe webhooks fire (via SSE). */}
      <PaymentStatusFloater order={order} />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <OrderDetailsCard order={order} />
        </div>
        <div className="space-y-6" ref={paymentSectionRef}>
          <OrderPaymentCard order={order} canRegenerate={canRegenerate} />
        </div>
      </div>

      {/* Inline email composer — no separate /compose route. Shown as
          long as there's a Stripe link to send; once the order is paid,
          the composer freezes itself into a sent / paid state. */}
      {order.payment.checkoutUrl ? (
        <section className="space-y-3">
          <div className="border-t border-border pt-6">
            <h2 className="text-[15px] font-semibold tracking-tight">
              Payment-request email
            </h2>
            <p className="mt-1 text-[12.5px] text-muted-foreground">
              Edit the customer-facing email and send. The preview reflects
              exactly what will be delivered; payment status above updates
              in real time once Stripe confirms.
            </p>
          </div>
          <EmailComposer
            order={order}
            initialHtml=""
            defaultSubject={`Complete your ${
              order.provider?.name ?? "rental"
            } payment • ${order.orderNumber}`}
          />
        </section>
      ) : null}
    </div>
  );
}

// Re-export so legacy callers can import from the workspace tab module.
export type { UserRole };
