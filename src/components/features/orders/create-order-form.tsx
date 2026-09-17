"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { useUnsavedChangesGuard } from "@/components/common/unsaved-changes-guard";
import { api, ApiClientError } from "@/lib/api-client";
import {
  BookingType,
  type BookingType as BookingTypeT,
  type Currency,
  PaymentTiming,
} from "@/lib/constants/enums";
import type { CreateOrderInput } from "@/lib/validation";
import type { OrderDTO, ProviderDTO } from "@/types";

import {
  findJustCreatedOrder,
  isUnknownCreateOutcome,
} from "./create-outcome";
import { OrderForm, useOrderForm } from "./order-form";

interface CreateOrderFormProps {
  allowedBookingTypes: readonly BookingTypeT[];
  defaultCurrency: Currency;
  allowedCurrencies: readonly string[];
  /** Active provider catalog. Empty array renders the selector with a
   *  "configure providers first" prompt. */
  providers: ProviderDTO[];
}

interface CreateOrderApiResponse {
  order: OrderDTO;
  checkoutUrl: string;
}

/**
 * A create whose result is not known. `match` is the order the lookup found,
 * or null when the lookup found nothing it could trust — including when the
 * lookup itself failed.
 */
/** When to look for an order whose create request failed without an answer. */
const LOOKUP_DELAYS_MS = [0, 1500, 4000];

interface UncertainOutcome {
  match: Pick<OrderDTO, "id" | "orderNumber"> | null;
  lookupFailed: boolean;
}

/**
 * Create Order — the shared order form in create mode.
 *
 * The fields, selectors and validation live in `OrderForm`, which Edit Order
 * renders too; this wrapper owns only what creating means: blank defaults,
 * `POST /api/orders`, and moving on to the payment-request step.
 */
export function CreateOrderForm({
  allowedBookingTypes,
  defaultCurrency,
  allowedCurrencies,
  providers,
}: CreateOrderFormProps) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);
  // `POST /api/orders` mints a new order on every call and has no
  // idempotency key. After it succeeds, `router.replace` runs without being
  // awaited, RHF clears `isSubmitting`, and the form sits enabled for the
  // whole route transition — long enough for a second Enter to create a
  // duplicate. The latch closes that window. It is released only on failure,
  // never in a `finally`, so a success keeps it shut.
  const submittingRef = useRef(false);
  // Set when a create failed without saying whether the order was written.
  // While set, submitting again needs an explicit "create anyway".
  const [uncertain, setUncertain] = useState<UncertainOutcome | null>(null);
  const [allowRetry, setAllowRetry] = useState(false);
  const uncertainRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (uncertain) uncertainRef.current?.focus();
  }, [uncertain]);

  const form = useOrderForm({
    bookingType: allowedBookingTypes[0] ?? BookingType.NEW_BOOKING,
    provider: providers[0]?.key ?? "",
    customer: { name: "", email: "", phone: "" },
    vehicle: { company: "", type: "", imageUrl: "" },
    trip: {
      pickupDate: "",
      dropoffDate: "",
      pickupLocation: "",
      dropoffLocation: "",
    },
    currency: defaultCurrency,
    charges: [{ name: "Rental cost", amount: 0, timing: PaymentTiming.PREPAID }],
    notes: "",
  });

  // A fully typed booking must not be thrown away by a stray click.
  const dirty = form.formState.isDirty && !created;
  const guard = useUnsavedChangesGuard({
    when: dirty,
    busy: form.formState.isSubmitting,
    title: "Discard this booking?",
    description:
      "The order has not been created yet. Leaving now will lose everything you have entered.",
  });

  function goToOrder(orderId: string) {
    setCreated(true);
    guard.release();
    // Sequential workflow: step 2 is sending the request email.
    router.replace(`/app/orders/${orderId}/email`);
    router.refresh();
  }

  async function onSubmit(values: CreateOrderInput) {
    if (submittingRef.current) return;
    if (uncertain && !allowRetry) {
      uncertainRef.current?.focus();
      return;
    }
    submittingRef.current = true;
    setServerError(null);
    setUncertain(null);
    setAllowRetry(false);
    const startedAt = Date.now();
    try {
      const result = await api.post<CreateOrderApiResponse>(
        "/api/orders",
        values,
      );
      // A reply without an order is not a created order.
      if (!result?.order?.id) {
        throw new ApiClientError(502, {
          code: "BAD_RESPONSE",
          message: "The server's reply did not include the new order.",
        });
      }
      toast.success("Order created. Send the payment request next.");
      goToOrder(result.order.id);
    } catch (err) {
      if (!isUnknownCreateOutcome(err)) {
        submittingRef.current = false;
        const message =
          err instanceof ApiClientError
            ? err.message
            : "Something went wrong. Please try again.";
        setServerError(message);
        toast.error(message);
        return;
      }

      // The order may exist. Look before offering a retry that would mint
      // a second one for the same booking. A miss proves nothing: after a
      // gateway timeout the server can still be writing the order, so the
      // lookup is repeated briefly and, even then, a miss is reported as
      // "not found yet" — never as "not created".
      let outcome: UncertainOutcome = { match: null, lookupFailed: false };
      for (const waitMs of LOOKUP_DELAYS_MS) {
        if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
        try {
          const match = await findJustCreatedOrder(values, startedAt);
          outcome = { match, lookupFailed: false };
          if (match) break;
        } catch {
          outcome = { match: null, lookupFailed: true };
        }
      }
      submittingRef.current = false;
      setUncertain(outcome);
      toast.error(
        outcome.match
          ? `This booking may already have been created as ${outcome.match.orderNumber}.`
          : "We could not confirm whether the order was created.",
      );
    }
  }

  const uncertainNotice = uncertain ? (
    <Alert
      ref={uncertainRef}
      tabIndex={-1}
      variant="destructive"
      data-testid="create-outcome-unknown"
    >
      <TriangleAlertIcon className="size-4" />
      <AlertTitle>
        {uncertain.match
          ? `This booking may already exist as ${uncertain.match.orderNumber}`
          : "We could not confirm whether the order was created"}
      </AlertTitle>
      <AlertDescription className="space-y-3">
        <p>
          {uncertain.match
            ? "The request failed, but an order you created moments ago has the same customer, provider and trip. Open it rather than creating the booking twice."
            : uncertain.lookupFailed
              ? "The request failed and the orders list could not be checked. Look for this booking in Orders before creating it again, or it may be created twice."
              : "The request failed and no matching order has appeared yet — but it may still be saving. Check Orders in a minute before creating it again, or it may be created twice."}
        </p>
        <div className="flex flex-wrap gap-2">
          {uncertain.match ? (
            <Button
              type="button"
              size="sm"
              onClick={() => goToOrder(uncertain.match!.id)}
            >
              Open {uncertain.match.orderNumber}
            </Button>
          ) : (
            <Button asChild size="sm" variant="outline">
              <Link href="/app/orders" target="_blank" rel="noopener">
                Check Orders in a new tab
              </Link>
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={allowRetry}
            onClick={() => setAllowRetry(true)}
          >
            {allowRetry
              ? "Submit again to create it"
              : "It is a different booking — create anyway"}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  ) : null;

  return (
    <>
      <OrderForm
        mode="create"
        form={form}
        providers={providers}
        allowedBookingTypes={allowedBookingTypes}
        defaultCurrency={defaultCurrency}
        allowedCurrencies={allowedCurrencies}
        serverError={serverError}
        serverErrorTitle="Could not create order"
        onSubmit={onSubmit}
        onCancel={() =>
          dirty ? guard.requestLeave("/app/orders") : router.back()
        }
        submitLabel="Create order & generate link"
        submittingLabel="Creating order"
        locked={created}
        beforeActions={uncertainNotice}
      />
      {guard.dialog}
    </>
  );
}
