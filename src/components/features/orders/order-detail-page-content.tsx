"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";

import { ArchiveOrderButton } from "@/components/features/orders/archive-order-button";
import { OrderConsentCard } from "@/components/features/orders/order-consent-card";
import { OrderDetailsCard } from "@/components/features/orders/order-details-card";
import { OrderDocumentsCard } from "@/components/features/orders/order-documents-card";
import { OrderEvidenceCard } from "@/components/features/orders/order-evidence-card";
import { OrderPaymentCard } from "@/components/features/orders/order-payment-card";
import { OrderStatusTimeline } from "@/components/features/orders/order-status-timeline";
import { PaymentStatusFloater } from "@/components/features/orders/payment-status-floater";
import { RiskFlagDialog } from "@/components/features/disputes/risk-flag-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { PageHeader } from "@/components/common/page-header";
import { OrderDetailsSkeleton } from "@/components/common/skeletons";
import {
  ConsentStatusBadge,
  OrderStatusBadge,
  RecordStateBadge,
} from "@/components/common/status-badges";
import { useOrderQuery } from "@/hooks/use-order-query";
import { useReconcilePayment } from "@/hooks/use-reconcile-payment";
import { ApiClientError } from "@/lib/api-client";
import { ConsentStatus, OrderStatus, RecordState } from "@/lib/constants/enums";
import type { UserRole } from "@/lib/constants/enums";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";

interface OrderDetailPageContentProps {
  orderId: string;
  role: UserRole;
}

/**
 * Order detail, the operational source-of-truth screen for one order.
 *
 * Linear routing: this is a real page at `/orders/[id]`, NOT an internal
 * workspace tab. The server route guards access + existence; this client
 * component owns the fetch + render.
 *
 * What lives here:
 *   - lifecycle timeline (Created → Email Sent → Consent Received →
 *     Paid → Confirmation Sent)
 *   - order details (booking + customer + provider + vehicle)
 *   - payment status + Stripe link tooling
 *   - consent state with audit fields
 *   - self-healing reconcile (fires once when PENDING is detected so a
 *     dropped webhook in local dev doesn't strand the agent on stale
 *     state)
 *
 * The agent reaches the email composer via the inline "Edit payment
 * email" / "Compose payment request" CTAs, there is no persistent tab
 * to switch back to.
 */
export function OrderDetailPageContent({
  orderId,
  role,
}: OrderDetailPageContentProps) {
  const router = useRouter();
  const { data: order, error, isLoading } = useOrderQuery(orderId);

  useReconcilePayment({
    orderId,
    status: order?.status,
    hasSession: Boolean(order?.payment.paymentSessionId),
  });

  if (isLoading) return <OrderDetailsSkeleton />;

  if (error) {
    const isMissing =
      error instanceof ApiClientError &&
      (error.status === 404 || error.status === 403);
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="w-fit">
          <Link href="/app/orders">
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
              ? "It may have been archived or deleted."
              : error.message}
          </AlertDescription>
        </Alert>
        <Button
          size="sm"
          variant="outline"
          onClick={() => router.push("/app/orders")}
        >
          Back to orders
        </Button>
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

  const needsPaymentLink = order.status === OrderStatus.NOT_INITIATED;
  const inFlight =
    needsPaymentLink ||
    order.status === OrderStatus.PAYMENT_PENDING ||
    order.status === OrderStatus.FAILED ||
    order.status === OrderStatus.EXPIRED;

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="w-fit">
        <Link href="/app/orders">
          <ArrowLeftIcon className="size-3.5" />
          Back to orders
        </Link>
      </Button>
      <PageHeader
        title={order.orderNumber}
        description="Live order state and audit trail."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <OrderStatusBadge status={order.status} />
            {order.consent.status !== ConsentStatus.NOT_REQUESTED ? (
              <ConsentStatusBadge status={order.consent.status} />
            ) : null}
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

      <PaymentStatusFloater order={order} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Status</CardTitle>
          <CardDescription>
            Lifecycle from order creation through Stripe confirmation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OrderStatusTimeline order={order} />
        </CardContent>
      </Card>

      {needsPaymentLink ? (
        <Alert>
          <AlertTitle>Order ready, payment not initiated yet</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              The Stripe payment link is generated when you send the
              request email. Open the composer to send and initiate
              payment in one step.
            </span>
            <Button asChild size="sm">
              <Link href={`/app/orders/${order.id}/email`}>
                Compose payment request
                <ArrowRightIcon className="size-3.5" />
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : inFlight && order.payment.paymentUrl ? (
        <Alert>
          <AlertTitle>Payment in progress</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              Re-send the payment-request email or edit customer details
              from the email composer.
            </span>
            <Button asChild size="sm" variant="outline">
              <Link href={`/app/orders/${order.id}/email`}>
                Edit payment email
                <ArrowRightIcon className="size-3.5" />
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <OrderDetailsCard order={order} />
        </div>
        <div className="space-y-6">
          <OrderPaymentCard order={order} canRegenerate={canRegenerate} />
          <OrderDocumentsCard
            orderId={order.id}
            canIssue={role === "ADMIN" || role === "SUPER_ADMIN"}
            isPaid={Boolean(order.payment.paidAt)}
          />
          <OrderEvidenceCard orderId={order.id} role={role} />
          <OrderConsentCard order={order} role={role} />
        </div>
      </div>
    </div>
  );
}
