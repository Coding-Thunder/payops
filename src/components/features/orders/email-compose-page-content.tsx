"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";

import { EmailComposer } from "@/components/features/orders/email-composer";
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
import { CenteredSpinner } from "@/components/ui/spinner";
import { useOrderQuery } from "@/hooks/use-order-query";
import { ApiClientError } from "@/lib/api-client";
import { formatCurrency } from "@/lib/format";

interface EmailComposePageContentProps {
  orderId: string;
}

/**
 * Step 2 of the linear flow — communication only.
 *
 * Lives at `/orders/[id]/email` as a real Next.js route (no workspace
 * tab shell). Strict scope:
 *   1. Compact order summary so the agent doesn't lose context.
 *   2. Email composer (split-pane editor + sticky preview).
 *   3. After send: success banner + auto-redirect to `/orders/[id]`.
 *
 * What's deliberately NOT here (it all lives on `/orders/[id]`):
 *   - payment status / Stripe link tools
 *   - reconcile + polling
 *   - consent state cards / audit timeline / status timeline
 *
 * Performance: single GET /api/orders/[id] via useOrderQuery. No polling,
 * no SSE bridges specific to this page.
 */
export function EmailComposePageContent({
  orderId,
}: EmailComposePageContentProps) {
  const router = useRouter();
  const { data: order, error, isLoading } = useOrderQuery(orderId);

  const [sentAt, setSentAt] = React.useState<string | null>(null);

  // Auto-redirect to the order detail page the moment the send completes.
  // No artificial delay — the order route has its own loading skeleton
  // (loading.tsx) which carries the user across the transition. We
  // depend only on `sentAt` so the effect runs exactly once per send
  // and never has its push timeout cancelled by a re-render.
  React.useEffect(() => {
    if (!sentAt) return;
    router.push(`/app/orders/${orderId}`);
  }, [sentAt, orderId, router]);

  // Full-page loader takes over the moment a send completes. Replaces
  // the previous inline alert so the user has a single, clear "going
  // somewhere" affordance instead of a buried success banner.
  if (sentAt) {
    return (
      <CenteredSpinner
        minHeight="60vh"
        size="xl"
        text="Email sent — opening the order page…"
      />
    );
  }

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
      </div>
    );
  }

  if (!order) return null;

  const orderHref = `/app/orders/${order.id}`;

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="w-fit">
        <Link href="/app/orders">
          <ArrowLeftIcon className="size-3.5" />
          Back to orders
        </Link>
      </Button>

      <PageHeader
        title={`Send payment request · ${order.orderNumber}`}
        description="Compose the payment-request email and send it. Track status on the order page once it's out."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Order summary</CardTitle>
          <CardDescription>
            Frozen at creation. Edit customer fields from the composer below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <SummaryRow
              label="Customer"
              value={`${order.customer.name} · ${order.customer.email}`}
            />
            <SummaryRow
              label="Amount"
              value={formatCurrency(order.pricing.amount, order.pricing.currency)}
            />
            <SummaryRow
              label={order.lineItems.length === 1 ? "Item" : "Items"}
              value={
                order.lineItems
                  .map((l) =>
                    l.quantity > 1 ? `${l.quantity}× ${l.name}` : l.name,
                  )
                  .join(", ") || "—"
              }
            />
            <SummaryRow label="Order" value={order.orderNumber} mono />
          </dl>
        </CardContent>
      </Card>

      <EmailComposer
        order={order}
        initialHtml=""
        defaultSubject={`Complete your payment • ${order.orderNumber}`}
        onSent={(at) => setSentAt(at)}
      />

      <div className="flex justify-end">
        <Button asChild variant="outline" size="sm">
          <Link href={orderHref}>
            Skip — open order
            <ArrowRightIcon className="size-3.5" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd
        className={
          mono
            ? "mt-1 font-mono text-xs text-foreground font-medium"
            : "mt-1 text-sm text-foreground font-medium"
        }
      >
        {value}
      </dd>
    </div>
  );
}
