import Link from "next/link";
import { CheckCircle2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getOrderByNumber } from "@/server/services/order.service";

export const metadata = { title: "Payment success" };
export const dynamic = "force-dynamic";

interface SuccessPageProps {
  searchParams: Promise<{ order?: string }>;
}

export default async function PaymentSuccessPage({
  searchParams,
}: SuccessPageProps) {
  const { order: orderNumber } = await searchParams;
  const order = orderNumber ? await getOrderByNumber(orderNumber) : null;

  return (
    <div className="mx-auto max-w-xl py-10">
      <Card>
        <CardContent className="pt-10 pb-10 text-center space-y-4">
          <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-success/15 text-success">
            <CheckCircle2Icon className="size-7" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Payment received
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Thanks - a confirmation email is on its way to the customer.
              Stripe is our source of truth, so the order status will update
              once the webhook is processed.
            </p>
          </div>
          {order ? (
            <Alert>
              <AlertTitle className="font-mono">{order.orderNumber}</AlertTitle>
              <AlertDescription>
                Current internal status: {order.status}
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex justify-center gap-2">
            <Button asChild variant="outline">
              <Link href="/orders">View all orders</Link>
            </Button>
            <Button asChild>
              <Link href="/orders/create">Create another</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
