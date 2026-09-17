"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftIcon, ArrowRightIcon, PencilIcon } from "lucide-react";

import { ArchiveOrderButton } from "@/components/features/orders/archive-order-button";
import { ConfirmationNumberCard } from "@/components/features/orders/confirmation-number-card";
import { OrderConsentCard } from "@/components/features/orders/order-consent-card";
import { OrderDetailsCard } from "@/components/features/orders/order-details-card";
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
import { hasCustomerConsent } from "@/lib/consent";
import { formatCurrency } from "@/lib/format";
import { PaymentGatewayLabel } from "@/lib/constants/labels";
import { heldPaymentSource, outstandingHeldPayments } from "@/lib/payment-state";
import { ConsentStatus, OrderStatus, RecordState } from "@/lib/constants/enums";
import type { UserRole } from "@/lib/constants/enums";
import { Permission, roleHasPermission } from "@/lib/constants/permissions";

interface OrderDetailPageContentProps {
  orderId: string;
  role: UserRole;
}

/**
 * Order detail — the operational source-of-truth screen for one order.
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
 * email" / "Compose payment request" CTAs — there is no persistent tab
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
  // Order edits are money-adjacent (they can change the MCO), so they ride the same admin-only
  // permission the service re-checks. An archived order is read-only.
  const canEditOrder =
    roleHasPermission(role, Permission.ORDER_UPDATE) &&
    order.state !== RecordState.ARCHIVED;

  const needsPaymentLink = order.status === OrderStatus.NOT_INITIATED;
  // A request sent for manual collection leaves the order NOT_INITIATED on
  // purpose — there is no link to generate. Telling the operator to "compose
  // a payment request" then contradicted the decision they had already made.
  // The same holds after a failed, expired or re-priced link: Manual is the
  // fallback the send route keeps open there, and the page must not steer
  // the operator back to a gateway link once they have chosen it.
  // Including while an earlier gateway link is still live: the operator
  // chose Manual, and the page must say so rather than "payment in progress".
  const manualRequested =
    order.consent.collectionMethod === "MANUAL" &&
    order.status !== OrderStatus.PAID;
  const liveLinkAlongsideManual =
    manualRequested &&
    Boolean(order.payment.paymentUrl) &&
    (order.status === OrderStatus.LINK_GENERATED ||
      order.status === OrderStatus.PAYMENT_PENDING);
  // Failed and expired orders keep their old URL; it is not "in progress".
  const inFlight = order.status === OrderStatus.PAYMENT_PENDING;
  // A link generated (by a regenerate or "Try another gateway") that the
  // customer has not been sent. The page used to give no way to send it.
  const linkNotSent =
    order.status === OrderStatus.LINK_GENERATED && Boolean(order.payment.paymentUrl);
  const paymentStopped =
    order.status === OrderStatus.FAILED || order.status === OrderStatus.EXPIRED;
  // Money the gateway took that the order did not accept. Until it is
  // reconciled, collecting again risks charging the customer twice.
  const held = outstandingHeldPayments(order);
  const emailHref = `/app/orders/${order.id}/email`;

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
            {manualRequested ? (
              // A manual request is what is pending, whatever the last link
              // did; "Failed" or "Draft" read as if something was wrong.
              <Badge variant="secondary">Manual payment requested</Badge>
            ) : (
              <OrderStatusBadge status={order.status} />
            )}
            {order.consent.status !== ConsentStatus.NOT_REQUESTED &&
            // A paid order is not waiting for anyone's consent.
            !(
              order.status === OrderStatus.PAID &&
              order.consent.status === ConsentStatus.REQUESTED
            ) ? (
              <ConsentStatusBadge status={order.consent.status} />
            ) : null}
            {order.state !== RecordState.ACTIVE ? (
              <RecordStateBadge state={order.state} />
            ) : null}
            {order.risk.flagged ? (
              <Badge variant="destructive">Flagged</Badge>
            ) : null}
            {canEditOrder ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/app/orders/${order.id}/edit`}>
                  <PencilIcon className="size-3.5" />
                  Edit order
                </Link>
              </Button>
            ) : null}
            {canFlagRisk ? <RiskFlagDialog order={order} /> : null}
            {canArchive ? <ArchiveOrderButton orderId={order.id} /> : null}
          </div>
        }
      />

      <PaymentStatusFloater
        order={order}
        canRecordPayment={roleHasPermission(role, Permission.ORDER_UPDATE)}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Status</CardTitle>
          <CardDescription>
            Lifecycle from order creation through payment confirmation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OrderStatusTimeline order={order} />
        </CardContent>
      </Card>

      {held.length > 0 ? (
        <Alert
          variant="destructive"
          data-testid="held-payment-alert"
          // The default destructive text is below 4.5:1 on its tint.
          className="text-red-800 dark:text-red-200"
        >
          <AlertTitle>
            {order.status === OrderStatus.PAID
              ? "An extra payment was received — refund it"
              : "A payment was already received that this order did not accept — do not charge the customer again"}
          </AlertTitle>
          <AlertDescription className="space-y-2">
            <ul className="list-disc pl-5">
              {held.map((a, i) => (
                <li key={`${a.sessionId ?? "held"}-${i}`}>
                  {formatCurrency(a.amount, a.currency)} on{" "}
                  {PaymentGatewayLabel[a.gateway] ?? a.gateway}
                  {` ${heldPaymentSource(a)}`}
                  {a.sessionId ? (
                    <span className="font-mono text-[11px]"> {a.sessionId}</span>
                  ) : null}
                </li>
              ))}
            </ul>
            <p>
              {order.status === OrderStatus.PAID
                ? "This order is already paid, so this money is not owed. Refund it in the gateway, then clear the order's flag."
                : canEditOrder
                  ? "The order did not accept it, so it is waiting for you. Refund it in the gateway and clear the order's flag, or record it as this order's payment with Record manual payment."
                  : "The order did not accept it, so it is waiting for an admin to reconcile. Do not collect again."}
            </p>
            {order.risk.flaggedNote ? (
              <p className="whitespace-pre-line text-[12px]">
                {order.risk.flaggedNote}
              </p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {held.length > 0 ? null : manualRequested ? (
        <Alert>
          <AlertTitle>Manual payment requested</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              {hasCustomerConsent(order.consent.status)
                ? canEditOrder
                  ? "The customer confirmed the booking. Once you have collected the payment, use Record manual payment in the Payment panel."
                  : "The customer confirmed the booking. Once the payment is collected, an admin records it on this order."
                : canEditOrder
                  ? `A booking confirmation request was sent to ${order.customer.email}. Once the customer confirms and you have collected the payment, use Record manual payment in the Payment panel.`
                  : `A booking confirmation request was sent to ${order.customer.email}. Once the customer confirms and the payment is collected, an admin records it on this order.`}
              {liveLinkAlongsideManual
                ? " An earlier online payment link is still live — if the customer pays it, do not charge them again."
                : null}
            </span>
            <Button asChild size="sm" variant="outline">
              <Link href={emailHref}>
                Open payment request
                <ArrowRightIcon className="size-3.5" />
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : needsPaymentLink ? (
        <Alert>
          <AlertTitle>Order ready — payment not initiated yet</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              The payment link is generated when you send the
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
      ) : linkNotSent ? (
        <Alert>
          <AlertTitle>
            New {order.payment.gateway ? (PaymentGatewayLabel[order.payment.gateway] ?? order.payment.gateway) : "payment"} link ready — not sent to the customer yet
          </AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              Send the payment request so {order.customer.name} can confirm
              and pay {formatCurrency(order.pricing.amount, order.pricing.currency)}.
            </span>
            <Button asChild size="sm">
              <Link href={emailHref}>
                Send payment request
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
              Re-send the payment request, switch to another payment method, or
              edit customer details on the payment-request page.
            </span>
            <Button asChild size="sm" variant="outline">
              <Link href={emailHref}>
                Open payment request
                <ArrowRightIcon className="size-3.5" />
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : paymentStopped ? (
        <Alert>
          <AlertTitle>
            {order.status === OrderStatus.FAILED
              ? "Payment did not go through — choose how to collect next"
              : "Payment link expired — choose how to collect next"}
          </AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              On the payment-request page, for this same order: send a new
              link, switch to another gateway (e.g. PayPal), or send a manual
              consent request.
            </span>
            <Button asChild size="sm">
              <Link href={`${emailHref}#payment-method`}>
                Choose payment method
                <ArrowRightIcon className="size-3.5" />
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <OrderDetailsCard order={order} />
          <ConfirmationNumberCard order={order} />
        </div>
        <div className="space-y-6">
          <OrderPaymentCard
            order={order}
            canRegenerate={canRegenerate}
            canManagePayment={
              roleHasPermission(role, Permission.ORDER_UPDATE) &&
              order.state !== RecordState.ARCHIVED
            }
          />
          <OrderEvidenceCard orderId={order.id} role={role} />
          <OrderConsentCard order={order} role={role} />
        </div>
      </div>
    </div>
  );
}
