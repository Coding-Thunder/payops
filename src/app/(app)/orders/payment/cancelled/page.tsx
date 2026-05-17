import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CancelledIllustration } from "@/components/brand/illustrations";
import { getOrderByNumber } from "@/server/services/order.service";

export const metadata = { title: "Payment cancelled" };
export const dynamic = "force-dynamic";

interface CancelPageProps {
  searchParams: Promise<{ order?: string }>;
}

export default async function PaymentCancelledPage({
  searchParams,
}: CancelPageProps) {
  const { order: orderNumber } = await searchParams;
  const order = orderNumber ? await getOrderByNumber(orderNumber) : null;

  return (
    <div className="mx-auto max-w-xl py-10">
      <Card>
        <CardContent className="pt-10 pb-10 text-center space-y-5">
          <CancelledIllustration className="mx-auto text-muted-foreground" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Payment not completed
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              The customer didn&apos;t finish the checkout. The order is still
              awaiting payment - you can resend the same link or regenerate a
              new one from the order page.
            </p>
          </div>
          <div className="flex justify-center gap-2">
            <Button asChild variant="outline">
              <Link href="/orders">All orders</Link>
            </Button>
            {order ? (
              <Button asChild>
                <Link href={`/orders/${order.id}`}>Open order</Link>
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
