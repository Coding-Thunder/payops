"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toast } from "@/components/ui/sonner";
import { api, ApiClientError } from "@/lib/api-client";
import { PaymentGatewayLabel } from "@/lib/constants/labels";
import { formatCurrency } from "@/lib/format";
import type { PaymentGatewayKey } from "@/lib/constants/enums";
import type { OrderDTO } from "@/types";

/**
 * "Stripe declined — try PayPal" on the SAME order.
 *
 * Options come from the order's own organization, so an operator is never
 * offered a provider this brand has not enabled.
 *
 * The warning is not decoration. The outgoing link cannot be reliably
 * killed — Stripe's expire call cannot report success and PayPal has no
 * cancel for an unapproved order — so for a short window two payable links
 * can exist. The backend turns any success on the old one into a flagged
 * competing payment rather than a second settlement, but the operator
 * should know before they create the situation.
 */
export function SwitchGatewayDialog({ order }: { order: OrderDTO }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<PaymentGatewayKey[] | null>(null);
  const [target, setTarget] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .get<{ current: PaymentGatewayKey | null; options: PaymentGatewayKey[] }>(
        `/api/orders/${order.id}/gateway-options`,
      )
      .then((r) => {
        if (cancelled) return;
        setOptions(r.options);
        setTarget(r.options[0] ?? "");
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, order.id]);

  async function onSwitch() {
    if (!target) return;
    setError(null);
    setSaving(true);
    try {
      await api.post(`/api/orders/${order.id}/switch-gateway`, { gateway: target });
      toast.success(
        `New ${PaymentGatewayLabel[target as PaymentGatewayKey] ?? target} payment link generated.`,
      );
      setOpen(false);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : "Could not switch gateway.";
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  const currentLabel = order.payment.gateway
    ? (PaymentGatewayLabel[order.payment.gateway] ?? order.payment.gateway)
    : "none";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <RefreshCwIcon className="size-3.5" />
          Try another gateway
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Use a different payment gateway</DialogTitle>
          <DialogDescription>
            Issues a new link for order {order.orderNumber} on another gateway.
            The order is not duplicated.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Could not switch</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-3 text-[13px]">
          <div className="rounded-md border border-border bg-surface-1 px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Currently</span>
              <span className="font-medium">{currentLabel}</span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-muted-foreground">Amount to collect</span>
              <span className="font-medium tabular-nums">
                {formatCurrency(order.pricing.amount, order.pricing.currency)}
              </span>
            </div>
            {order.payment.failureReason ? (
              <div className="mt-1 text-[12px] text-destructive">
                {order.payment.failureReason}
              </div>
            ) : null}
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              Switch to
            </label>
            {options === null ? (
              <p className="text-[12px] text-muted-foreground">Loading…</p>
            ) : options.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">
                No other gateway is enabled for this brand.
              </p>
            ) : (
              <Select value={target} onValueChange={setTarget} disabled={saving}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a gateway" />
                </SelectTrigger>
                <SelectContent>
                  {options.map((g) => (
                    <SelectItem key={g} value={g}>
                      {PaymentGatewayLabel[g] ?? g}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {order.payment.paymentUrl ? (
            <Alert variant="destructive">
              <TriangleAlertIcon className="size-4" />
              <AlertTitle>The existing link stays live for a short time</AlertTitle>
              <AlertDescription>
                We ask the current gateway to close its session, but neither
                Stripe nor PayPal can confirm it. If the customer pays the old
                link, that payment is recorded and the order is flagged for you
                to reconcile — it will not settle twice.
              </AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <LoadingButton
            onClick={onSwitch}
            loading={saving}
            loadingText="Generating"
            disabled={!target || saving}
          >
            Generate link
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
