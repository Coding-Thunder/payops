"use client";

import { useFormContext, useWatch } from "react-hook-form";

import {
  flightAmountLabels,
  showsAirlineCharge,
  summarizeFlightAmounts,
} from "@/lib/charges";
import { BookingType, type Currency, PaymentTiming } from "@/lib/constants/enums";
import { formatCurrency } from "@/lib/format";
import type { FlightOrderInput } from "@/lib/validation";

import type { FlightOrderFormValues } from "./itinerary-form";

/**
 * The flight form's live breakdown: airline charge + service charge = total
 * booking value, of which the payment link charges only the service charge
 * — the amount payable now. Same helper, same rows and the same copy the
 * customer pages and emails use, so the operator sees exactly what the
 * customer will — including the neutral wording a modification or
 * cancellation charge gets, which is a fee for the change rather than the
 * service charge for the booking.
 */
export function FlightAmountsSummary({
  defaultCurrency,
}: {
  defaultCurrency: Currency;
}) {
  const { control } = useFormContext<
    FlightOrderFormValues,
    unknown,
    FlightOrderInput
  >();
  const airlineFare = useWatch({ control, name: "flight.airlineFare" });
  const serviceCharge = useWatch({ control, name: "charges.0.amount" });
  const bookingType = useWatch({ control, name: "bookingType" });
  const currency = useWatch({ control, name: "currency" }) ?? defaultCurrency;
  const amounts = summarizeFlightAmounts(
    [
      {
        name: "",
        amount: typeof serviceCharge === "number" ? serviceCharge : 0,
        timing: PaymentTiming.PREPAID,
      },
    ],
    typeof airlineFare === "number" ? airlineFare : null,
  );
  // This form only creates itinerary flights, so the service-charge model
  // comes down to the booking type (see `flightMoneyWording`).
  const serviceChargeModel = bookingType === BookingType.NEW_BOOKING;
  const labels = flightAmountLabels(serviceChargeModel);
  const showAirline = showsAirlineCharge(amounts);

  return (
    <div className="space-y-1.5 rounded-md border bg-muted/30 p-4 text-sm">
      {showAirline ? (
        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0 text-muted-foreground">
            {labels.airlineFare}
            <span className="block text-xs">{labels.airlineFareNote}</span>
          </span>
          <span className="shrink-0 font-medium tabular-nums">
            {formatCurrency(amounts.airlineFare, currency)}
          </span>
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground">{labels.serviceCharge}</span>
        <span className="font-medium tabular-nums">
          {formatCurrency(amounts.serviceCharge, currency)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3 border-t pt-1.5">
        <span className="font-medium">{labels.bookingTotal}</span>
        <span className="font-semibold tabular-nums">
          {formatCurrency(amounts.bookingTotal, currency)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">{labels.payableNow}</span>
        <span className="font-semibold tabular-nums">
          {formatCurrency(amounts.payableNow, currency)}
        </span>
      </div>
      {showAirline ? (
        <p className="pt-1 text-xs text-muted-foreground">
          {labels.airlineFareExplainer}
        </p>
      ) : null}
      <p className="pt-1 text-xs text-muted-foreground">
        {serviceChargeModel
          ? "The payment link charges only the "
          : "The payment link charges only "}
        <strong>{formatCurrency(amounts.payableNow, currency)}</strong>
        {serviceChargeModel ? " service charge." : "."}
      </p>
    </div>
  );
}
